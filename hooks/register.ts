import type { EngineInterface, Register } from 'claude-code'
import { statusIcons } from './status-icons'

const TTL_MS = 60 * 60 * 1000
const PING_AFTER_MS = 50 * 60 * 1000
const MIN_PING_MS = 60 * 1000
const MAX_RETRIES = 3
const AUTO_WARM_MS = 3 * 60 * 60 * 1000
const DEFAULT_WINDOW_MS = 6 * 60 * 60 * 1000
const BIG_TOKENS = 50000
const PING_PROMPT = 'Reply with the single word: warm'
const KEY_DEADLINE = 'deadline'
const KEY_EVERY = 'every'
const KEY_GUARD = 'guard'
const KEY_ALWAYS = 'always'

// Prompts no person sent, so nobody could send them again after a refusal. Every
// other origin, including sdk, unclassified and the owner's own Slack or channel
// messages, may carry a person's words and keeps the guard.
const UNATTENDED = new Set(['task-notification', 'scheduled-trigger', 'peer', 'peer-send-message', 'projects-relay', 'coordinator', 'observer', 'observer-activity'])

const LONG_PROMPT_TOKENS = 100000

// $ per million tokens, [cache read, 1h cache write, output], list prices October 2026.
// More specific families first: a model id takes the first row it matches.
const PRICES: Array<[string | RegExp, number, number, number]> = [
  ['fable-5-1', 0.25, 20, 50],
  ['mythos-5-1', 0.25, 20, 50],
  ['fable-5', 1, 20, 50],
  ['mythos-5', 1, 20, 50],
  ['opus-5-5', 0.2, 8, 20],
  ['opus-5', 0.5, 10, 25],
  // Opus 4 and 4.1 in every spelling (claude-opus-4-1-20250805, claude-opus-4@20250514, the -0 and -1 aliases), never Opus 4.5 and later.
  [/opus-4(?:-[01])?(?:$|[^-\d]|-20\d{6})/, 1.5, 30, 75],
  ['opus-4', 0.5, 10, 25],
  ['sonnet-5-5', 0.1, 4, 10],
  ['sonnet-5', 0.2, 4, 10],
  ['sonnet', 0.3, 6, 15],
  ['haiku-5-5', 0.01, 0.2, 0.5],
  ['3-5-haiku', 0.08, 1.6, 4],
  ['haiku-3-5', 0.08, 1.6, 4],
  ['haiku', 0.1, 2, 5],
]

// A request whose prompt, cache reads and writes included, is over 100k tokens pays these instead.
const LONG_PRICES: Array<[string, number, number, number]> = [
  ['haiku-5-5', 0.05, 1, 2.5],
]

type PingRecord = { at: number; read: number; write: number; usd: number | null; warm: boolean }
type Miss = { at: number; tokens: number; usd: number | null }
type GuardMode = 'refuse' | 'warn'

export type State = {
  hasBand: boolean
  sid: string
  deadline: number
  every: number
  always: boolean
  lastRequestAt: number
  lastModel: string | null
  ctx: number
  compacted: boolean
  resumedAt: number
  transcript: number
  guard: GuardMode
  ackedAt: number
  coldWritePending: boolean
  misses: Miss[]
  pending: { cancel: () => void } | null
  last: PingRecord | null
  stopped: string | null
  waitForTurn: boolean
  retries: number
  retryReason: string
  gen: number
  tick: number
  offs: number
  turnOffs: number | null
  inFlight: boolean
  stepWrites: StepWrites | null
  steps: number
  endingSid: string
}

/** What this turn's main requests wrote before any compaction it saw, priced per request where the steps reported usage. */
type StepWrites = { tokens: number; usd: number; priced: boolean }

function priceOf(model: string | null, promptTokens: number): [number, number, number] | null {
  const m = (model ?? '').toLowerCase().replace(/[\s.]+/g, '-')
  if (promptTokens > LONG_PROMPT_TOKENS) {
    for (const [family, read, write, output] of LONG_PRICES) if (m.includes(family)) return [read, write, output]
  }
  for (const [family, read, write, output] of PRICES) {
    if (typeof family === 'string' ? m.includes(family) : family.test(m)) return [read, write, output]
  }
  return null
}

export function parseDuration(text: string): number | null {
  const m = /^(?:(\d+)h)?(?:(\d+)m)?$/.exec(text.trim())
  if (!m || (m[1] === undefined && m[2] === undefined)) return null
  return (Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 60 * 1000
}

export function fmtDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 60000))
  const h = Math.floor(total / 60)
  const m = total % 60
  if (h >= 48) return `${Math.floor(h / 24)}d ${h % 24}h`
  return h > 0 ? `${h}h${String(m).padStart(2, '0')}m` : `${m}m`
}

function fmtUsd(usd: number | null): string {
  return usd == null ? 'n/a' : '$' + (usd >= 100 ? usd.toFixed(0) : usd.toFixed(2))
}

function fmtTok(n: number): string {
  return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1000 ? Math.round(n / 1000) + 'k' : String(n)
}

function coldUsd(s: State): number | null {
  const price = priceOf(s.lastModel, s.ctx)
  return price ? s.ctx * price[1] / 1e6 : null
}

function warmUsd(s: State): number | null {
  const price = priceOf(s.lastModel, s.ctx)
  return price ? s.ctx * price[0] / 1e6 : null
}

/** Everything a fork bills: the cache read, any cache write, uncached input at the base rate (half the 1h write rate), and the output. */
function pingUsd(u: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }, price: [number, number, number]): number {
  return (u.cache_read_input_tokens * price[0] + u.cache_creation_input_tokens * price[1] + u.input_tokens * price[1] / 2 + u.output_tokens * price[2]) / 1e6
}

/** The read-only upper bound: pings at the cache-read rate that cost as much as one cold write of the same context. */
function breakEvenPings(s: State): number | null {
  const price = priceOf(s.lastModel, s.ctx)
  if (!price || s.ctx <= 0) return null
  return Math.floor(price[1] / price[0])
}

function isCold(s: State, now: number): boolean {
  return s.lastRequestAt > 0 && !s.compacted && now - s.lastRequestAt >= TTL_MS
}

function guardText(s: State, now: number): string {
  const price = priceOf(s.lastModel, s.ctx)
  const rate = price ? `$${price[1]}/MTok` : 'the cache-write rate'
  const warm = warmUsd(s)
  return `the prompt cache went cold ${fmtDuration(now - s.lastRequestAt - TTL_MS)} ago. Sending this re-writes ` +
    `up to ${s.ctx.toLocaleString('en-US')} tokens at ${rate} = ${fmtUsd(coldUsd(s))}` +
    (warm == null ? '' : ` (a warm turn would have cost ${fmtUsd(warm)})`) + '.'
}

export type ResumeFields = {
  source: string
  model?: string
  context_tokens?: number
  seconds_since_last_response?: number
  prompt_cache_likely_expired?: boolean
  estimated_cache_write_usd?: number
}

/** /clear starts a new conversation in the same process; nothing priced before it still exists. */
export function resetForClear(s: State) {
  s.ctx = 0
  s.lastRequestAt = 0
  s.compacted = false
  s.resumedAt = 0
  s.transcript = 0
  s.ackedAt = 0
  s.coldWritePending = false
  s.misses = []
  s.waitForTurn = false
  s.stepWrites = null
  s.steps = 0
  outdate(s)
  disarm(s)
}

/** Applies a resumed session's fields to the state; returns the line to log, if any. */
export function seedFromResume(s: State, e: ResumeFields, now: number): string | null {
  if (e.source !== 'resume' && e.source !== 'fork') return null
  if (typeof e.context_tokens === 'number' && e.context_tokens > 0) s.ctx = e.context_tokens
  if (typeof e.seconds_since_last_response === 'number') {
    s.lastRequestAt = now - e.seconds_since_last_response * 1000
    s.resumedAt = 0
  }
  if (typeof e.model === 'string') s.lastModel = e.model
  s.compacted = false
  if (e.prompt_cache_likely_expired !== true || s.ctx < BIG_TOKENS) return null
  const usd = typeof e.estimated_cache_write_usd === 'number' ? fmtUsd(e.estimated_cache_write_usd) : fmtUsd(coldUsd(s))
  return `resuming cold. The first message re-writes ${s.ctx.toLocaleString('en-US')} tokens, about ${usd}. /clear and paste a summary if you only need the conclusions.`
}

/** A transcript resumed without the time of its last response: that response came after its first launch, so an hour after that launch the cache may be cold. */
function mayBeCold(s: State, now: number): boolean {
  return s.resumedAt > 0 && !s.lastRequestAt && now - s.resumedAt >= TTL_MS
}

/** The line for a resumed session whose last response time never arrived: the cache may be cold, and this is what that would cost. */
function unknownText(s: State): string {
  const price = priceOf(s.lastModel, s.ctx)
  const rate = price ? `$${price[1]}/MTok` : 'the cache-write rate'
  return `resumed with up to ${s.ctx.toLocaleString('en-US')} tokens of context and no time of its last response, so the cache may be cold. ` +
    `If it is, this message re-writes them at ${rate} = ${fmtUsd(coldUsd(s))}.`
}

/** The conversation was summarized: the next request is the first over the new prefix, and a ping out for the old one is dropped. */
function markCompacted(s: State) {
  s.compacted = true
  s.transcript = 0
  s.ackedAt = 0
  outdate(s)
}

function statusText(s: State, now: number): string | undefined {
  if (s.stopped) return `keepwarm stopped: ${s.stopped}`
  if (!s.deadline) return undefined
  const pingText = s.last ? ` · last ping read ${fmtTok(s.last.read)} ${fmtUsd(s.last.usd)}` : ''
  const nextText = !s.lastRequestAt ? ' · waiting for the first turn'
    : s.compacted ? ' · waiting for the first turn after compaction'
    : isCold(s, now) ? ` · cold now, first ping ${fmtDuration(s.every)} after the next turn`
    : s.waitForTurn ? ' · nothing to fork yet, first ping after the next turn'
    : s.retries ? ` · API busy, ping retry ${s.retries} of ${MAX_RETRIES}`
    : ` · ping in ${fmtDuration(s.lastRequestAt + s.every - now)}`
  return `keepwarm ${fmtDuration(s.deadline - now)} left${nextText}${pingText}`
}

function updateStatus($: EngineInterface, s: State, now: number) {
  if (s.hasBand) $.ui.invalidate('ui.render')
  else $.ui.status(statusText(s, now))
}

/** Cancels the timer. Every new timer is set right after this, so the tick also says the schedule changed. */
function disarm(s: State) {
  if (s.pending) s.pending.cancel()
  s.pending = null
  s.tick++
}

/** Outdates any ping in flight: /clear, a resume, compaction or stop replaced the state it was sent for. Re-arming or extending the window does not, so a ping out at that moment still counts; a main request outdates it through the request clock. */
function outdate(s: State) {
  s.gen++
}

// The window and its ping period belong to the session that armed them, so a
// second session, or one resumed from another transcript, never inherits them
// and cannot turn them off. The always switch and the guard mode stay global.
function deadlineKey(s: State): string {
  return `${KEY_DEADLINE}:${s.sid}`
}

function everyKey(s: State): string {
  return `${KEY_EVERY}:${s.sid}`
}

/** Clears this session's own dead window and the bare keys a store written before 2.1.1 still holds. Other sessions' keys are never touched: a read followed by a delete cannot be made atomic against their renewal. */
async function prune($: EngineInterface, s: State, now: number) {
  for (const key of [KEY_DEADLINE, deadlineKey(s)]) {
    const deadline = await $.store.get(key)
    if (deadline === undefined) continue
    if (typeof deadline === 'number' && deadline > now) continue
    await $.store.delete(key)
    await $.store.delete(KEY_EVERY + key.slice(KEY_DEADLINE.length))
  }
}

async function stop($: EngineInterface, s: State, why: string | null, forgetAlways = false) {
  // Set before any await, so a window being opened at the same moment sees the off and does not write itself back.
  if (forgetAlways) {
    s.always = false
    s.offs++
  }
  s.deadline = 0
  s.every = PING_AFTER_MS
  s.stopped = why
  s.retries = 0
  outdate(s)
  disarm(s)
  await $.store.delete(deadlineKey(s))
  await $.store.delete(everyKey(s))
  if (forgetAlways) await $.store.delete(KEY_ALWAYS)
  updateStatus($, s, await $.clock.now())
}

/** The conversation ended under /clear or an in-process resume. The next one's id cannot be read until the engine has switched, so the state is left unseated. */
async function endConversation($: EngineInterface, s: State, reason: 'clear' | 'resume') {
  // Claimed before any await: a second end or a classic start for the same conversation finds it already gone, and an
  // end cut short by its budget leaves no timer and no old id behind, only the keys below.
  const keys = [deadlineKey(s), everyKey(s)]
  const ending = s.sid
  resetForClear(s)
  s.sid = ''
  s.endingSid = ending
  // /clear ends the conversation the window was armed for. A resume carries the window on to the next one, under its
  // id: the old id's keys go here, or a /keepwarm off there could never find them and the old session would re-arm them.
  if (reason === 'clear') {
    s.deadline = 0
    s.every = PING_AFTER_MS
    s.stopped = null
    s.retries = 0
  }
  for (const key of keys) await $.store.delete(key)
  if (reason === 'clear') updateStatus($, s, await $.clock.now())
}

/** Reads the session the process runs now: its id, its model and the engine's figures for its context. Returns the time read with them. */
async function seat($: EngineInterface, s: State, id?: string): Promise<number> {
  s.sid = id ?? await $.session.id()
  s.endingSid = ''
  s.lastModel = await $.session.model()
  const usage = await $.session.usage()
  const now = await $.clock.now()
  if (usage.context.tokens) s.ctx = usage.context.tokens
  // A resumed transcript's last response came somewhere between its first launch and now; only the resume fields say where.
  s.resumedAt = !s.lastRequestAt && usage.context.tokens ? usage.startedAt : 0
  return now
}

/** Seats the state in the conversation that followed a /clear or a resume, once, and arms what always or a window opened meanwhile asks for. */
async function reseat($: EngineInterface, s: State) {
  if (s.sid) return
  const id = await $.session.id()
  // The host still answers with the conversation being ended: the next one is not there to seat yet, so nothing is
  // seated under the old id, and a window opened meanwhile waits in memory for the id it belongs to.
  if (id === s.endingSid) return
  const now = await seat($, s, id)
  if (s.always) await startWindow($, s, DEFAULT_WINDOW_MS, PING_AFTER_MS)
  // A window carried over, or armed while the conversation was ending, is written under this id.
  else if (s.deadline) await startWindow($, s, s.deadline - now, s.every)
  else updateStatus($, s, now)
}

async function arm($: EngineInterface, s: State) {
  disarm(s)
  s.retries = 0
  if (!s.deadline) return
  const now = await $.clock.now()
  // A timer set while the clock was read, such as a retry, is replaced here, never left running beside this one;
  // from this line to the assignment below nothing awaits.
  disarm(s)
  s.retries = 0
  if (now >= s.deadline) return stop($, s, null)
  // A cold window still needs expiry cleanup, but must not send a model request.
  if (s.lastRequestAt && !s.compacted && !isCold(s, now)) {
    const untilCold = s.lastRequestAt + TTL_MS - now
    // Waiting for a turn sends nothing, but wakes when the cache goes cold so the row says so.
    if (s.waitForTurn) s.pending = $.clock.after(Math.min(s.deadline - now, untilCold), () => { void arm($, s) })
    else {
      const delay = Math.min(s.deadline - now, untilCold, Math.max(1000, s.lastRequestAt + s.every - now))
      s.pending = $.clock.after(delay, () => { void ping($, s) })
    }
  } else {
    s.pending = $.clock.after(s.deadline - now, () => { void arm($, s) })
  }
  updateStatus($, s, now)
}

async function ping($: EngineInterface, s: State) {
  s.pending = null
  if (!s.deadline) return
  const tick = s.tick
  const now = await $.clock.now()
  // A timer set or cancelled while the clock was read (an extension, a retry, a turn) owns the window now;
  // if that left no timer, a window still open is armed again rather than left without one.
  if (s.tick !== tick) return s.pending || s.inFlight ? undefined : arm($, s)
  // One fork at a time: the one already out re-arms when it settles. Checked after the await, and set
  // below with no await in between, so two timers can never both send.
  if (s.inFlight) return
  if (now >= s.deadline) return arm($, s)
  if (isCold(s, now)) return arm($, s)
  if (s.compacted || s.waitForTurn || !s.lastRequestAt) return arm($, s)
  // A request since this timer was set moved the clock; schedule from it.
  if (now - s.lastRequestAt < s.every - 1000) return arm($, s)
  // A host that slept past a retry's slot must not send it inside the last minute.
  if (s.retries && now >= s.lastRequestAt + TTL_MS - MIN_PING_MS) return stop($, s, s.retryReason + afterRetries(s.retries))
  const gen = s.gen
  const sentAt = s.lastRequestAt
  s.inFlight = true
  const sent = await $.model.fork({ prompt: PING_PROMPT }).then(reply => ({ reply }), (err: unknown) => ({ err }))
  const at = await $.clock.now()
  s.inFlight = false
  // Checked after the last await. A stop, /clear, resume or compaction, or a main request that moved the
  // cache clock, replaced what this fork was sent for: its reply is dropped and the window armed afresh.
  if (gen !== s.gen || s.lastRequestAt !== sentAt) return s.pending ? undefined : arm($, s)
  if ('err' in sent) return stop($, s, `the ping failed, ${sent.err instanceof Error ? sent.err.message : String(sent.err)}`)
  const reply = sent.reply
  if (reply === null) return stop($, s, 'the engine did not send the ping, either the snapshot was cold or the API call failed')
  if (reply.isAnswered === false) {
    // A restarted process has no conversation to fork until its first turn; the window waits for one instead of ending.
    if (reply.reason === 'nothing-to-fork') {
      // Said once per wait: /keepwarm already answered "on", and the status row alone does not tell anyone to act.
      if (!s.waitForTurn) $.ui.log('keepwarm is on, but there is nothing to fork yet, so no ping goes out until your next message. Send one more message and the pings start.')
      s.waitForTurn = true
      return arm($, s)
    }
    const reason = reply.reason === 'api-error' ? `the API call failed${reply.status === null ? '' : ` (${reply.status})`}`
      : reply.reason === 'aborted' ? 'the ping was interrupted'
      : 'the ping returned no text'
    // A busy or failing API is usually brief; retry while a ping can still land a minute before the cache goes cold.
    if (reply.reason === 'api-error' && (reply.status === null || reply.status === 429 || reply.status >= 500)) {
      const wait = MIN_PING_MS * 2 ** s.retries
      if (s.retries < MAX_RETRIES && at + wait < Math.min(s.deadline, s.lastRequestAt + TTL_MS - MIN_PING_MS)) {
        s.retries++
        s.retryReason = reason
        // Replaces any timer set while the fork was out, such as a window extension's, so only the retry fires.
        disarm(s)
        s.pending = $.clock.after(wait, () => { void ping($, s) })
        updateStatus($, s, at)
        return
      }
    }
    return stop($, s, reason + afterRetries(s.retries))
  }
  const u = reply.usage
  const price = priceOf(s.lastModel, u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens)
  // A warm ping reads the prefix and writes only its own message; a write of a tenth of the read or more means the prefix broke.
  const warm = u.cache_read_input_tokens > 0 && u.cache_creation_input_tokens < 0.1 * u.cache_read_input_tokens
  const usd = price ? pingUsd(u, price) : null
  s.last = { at: now, read: u.cache_read_input_tokens, write: u.cache_creation_input_tokens, usd, warm }
  if (!warm) return stop($, s, `the ping read ${fmtTok(u.cache_read_input_tokens)} and wrote ${fmtTok(u.cache_creation_input_tokens)} tokens (${fmtUsd(usd)}), the cache was already gone`)
  s.lastRequestAt = now
  await arm($, s)
}

function afterRetries(n: number): string {
  return n ? ` after ${n} ${n === 1 ? 'retry' : 'retries'}` : ''
}

/** The reply to an arming command; on a cold cache it says when the first ping can come. */
/** How long keepwarm holds the cache after a paid cold write: the rolling window when always is on. */
function holdMs(s: State): number {
  return s.always ? DEFAULT_WINDOW_MS : AUTO_WARM_MS
}

function armedText(s: State, now: number, windowMs: number): string {
  if (isCold(s, now)) return `keepwarm on for ${fmtDuration(windowMs)}. The cache is cold now, so the first ping comes ${fmtDuration(s.every)} after the next turn`
  return `keepwarm on for ${fmtDuration(windowMs)}, a ping ${fmtDuration(s.every)} after each idle stretch keeps the cache read, not re-written`
}

// A /keepwarm off after `offs` was read wins: the window it cancelled is not written back. A caller that awaited
// before deciding to open a window passes the count it read first.
async function startWindow($: EngineInterface, s: State, windowMs: number, every: number, offs = s.offs) {
  if (s.offs !== offs) return
  const now = await $.clock.now()
  if (s.offs !== offs) return
  const deadline = now + windowMs
  s.every = every
  s.deadline = deadline
  s.stopped = null
  // Unseated, between a conversation's end and the host reporting the next, the window has no id to be written under; the seat writes it.
  if (!s.sid) return arm($, s)
  if (every === PING_AFTER_MS) await $.store.delete(everyKey(s))
  else await $.store.set(everyKey(s), every)
  await $.store.set(deadlineKey(s), deadline)
  if (s.offs !== offs) {
    // Remove only what this call wrote; a window armed after the off is left alone.
    if ((await $.store.get(deadlineKey(s))) === deadline) {
      await $.store.delete(deadlineKey(s))
      if (!s.deadline) await $.store.delete(everyKey(s))
    }
    return
  }
  await arm($, s)
}

function card(s: State, now: number): string {
  const lines: string[] = []
  lines.push(`${s.lastModel ?? 'model not seen yet'}`)
  if (s.compacted) lines.push('state       reset by compaction, waiting for the first turn')
  else if (s.resumedAt) lines.push(mayBeCold(s, now) ? 'state       unknown, resumed without the time of its last response' : `state       resumed without the time of its last response, warm for up to ${fmtDuration(s.resumedAt + TTL_MS - now)} more`)
  else if (!s.lastRequestAt) lines.push('state       no request yet this session')
  else if (isCold(s, now)) lines.push(`state       COLD, last request ${fmtDuration(now - s.lastRequestAt)} ago`)
  else lines.push(`state       warm, ${fmtDuration(s.lastRequestAt + TTL_MS - now)} left`)
  lines.push(`context     ${s.ctx.toLocaleString('en-US')} tokens`)
  lines.push(`cold cost   ${fmtUsd(coldUsd(s))} to re-write it (warm turn ${fmtUsd(warmUsd(s))})`)
  const always = s.always ? ' (always)' : ''
  const idle = s.always ? 'off until the next turn, which arms 6h00m (always)' : 'off (/keepwarm to arm it for 6h00m)'
  lines.push(`keepwarm    ${s.deadline ? (statusText(s, now) ?? '').replace(/^keepwarm /, 'on, ') + always : s.stopped ? `stopped, ${s.stopped}${always}` : idle}`)
  const pings = breakEvenPings(s)
  if (pings != null) lines.push(`break-even  up to ${pings} pings at the read rate cost one cold write, about ${fmtDuration(pings * s.every)} of idle at one ping per ${fmtDuration(s.every)}`)
  lines.push(`guard       ${s.guard === 'refuse' ? 'refuse once (/cache-tax guard warn to only show the price)' : 'warn only (/cache-tax guard refuse to be stopped once)'}`)
  const paid = s.misses.reduce((a, m) => a + (m.usd ?? 0), 0)
  lines.push(`session     ${s.misses.length} cold write${s.misses.length === 1 ? '' : 's'} paid, ${fmtUsd(paid)}`)
  return lines.join('\n')
}

export function freshState(): State {
  return {
    hasBand: false, sid: '', deadline: 0, every: PING_AFTER_MS, always: false, lastRequestAt: 0, lastModel: null, ctx: 0, compacted: false,
    resumedAt: 0, transcript: 0, guard: 'refuse', ackedAt: 0, coldWritePending: false, misses: [], pending: null, last: null, stopped: null,
    waitForTurn: false, retries: 0, retryReason: '', gen: 0, tick: 0, offs: 0, turnOffs: null, inFlight: false, stepWrites: null, steps: 0, endingSid: '',
  }
}

export const register: Register = on => {
  const s = freshState()
  let light = false
  let noColor = false

  on('config.set', { key: 'theme' }, async ($, e, next) => {
    const result = await next(e)
    if (result.deny === undefined) {
      light = typeof result.value === 'string' && result.value.startsWith('light')
      if (s.hasBand) $.ui.invalidate('ui.render')
    }
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const rest = await next(e)
    if (!s.hasBand || e.props.hasSurvey) return rest
    const now = await $.clock.now()
    const text = statusText(s, now)
    if (!text || (s.deadline && now >= s.deadline)) return rest
    const state = s.stopped ? 'stopped' : !s.lastRequestAt || s.compacted ? 'unknown' : isCold(s, now) ? 'cold' : 'warm'
    const color = noColor ? undefined : state === 'warm' ? 'success' : state === 'cold' ? (light ? '#c15f3c' : '#d97757') : undefined
    const { Box, Text } = $.ui.resolve(e)
    const asset = statusIcons[light ? 'light' : 'dark'][state === 'warm' || state === 'cold' ? state : 'neutral']
    const icon = noColor ? Text({ bold: true, children: ['[>]'] })
      : e.surface === 'terminal' ? $.ui.resolve(e).Image({ source: { png: asset.png }, columns: 3, rows: 1, alt: '[>]' })
      : e.surface === 'desktop' ? $.ui.resolve(e).Svg({ source: asset.svg, width: 18, height: 18, alt: 'Cache Tax' })
      : Text({ color, bold: true, children: ['[>]'] })
    return Box({ flexDirection: 'column', children: [
      rest,
      Box({ flexDirection: 'row', alignItems: 'center', children: [
        Box({ flexShrink: 0, children: [icon] }),
        Text({ children: [
          ' cache-tax · ',
          Text({ color, bold: true, children: [state] }),
          ` · ${text}`,
        ] }),
      ] }),
    ] })
  })

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    s.hasBand = e.surface === 'terminal' || e.surface === 'desktop'
    if (s.hasBand) {
      const theme = (await $.config.list()).find(row => row.key === 'theme')?.value
      light = typeof theme === 'string' && theme.startsWith('light')
      noColor = Boolean(await $.env.get('NO_COLOR'))
      $.ui.status(undefined)
    }
    const now = await seat($, s)
    await prune($, s, now)
    const saved = await $.store.get(deadlineKey(s))
    const savedEvery = await $.store.get(everyKey(s))
    const savedGuard = await $.store.get(KEY_GUARD)
    s.deadline = typeof saved === 'number' && saved > now ? saved : 0
    s.every = typeof savedEvery === 'number' && savedEvery >= MIN_PING_MS && savedEvery < TTL_MS ? savedEvery : PING_AFTER_MS
    s.guard = savedGuard === 'warn' ? 'warn' : 'refuse'
    s.always = (await $.store.get(KEY_ALWAYS)) === true
    // Always means a fresh default window every session, whatever the last one left behind.
    if (s.always) await startWindow($, s, DEFAULT_WINDOW_MS, PING_AFTER_MS)
    // The classic start arms a restored window too, but a managed plugin above this tier may continue beneath it; arming twice leaves one timer.
    else if (s.deadline) await arm($, s)
    await $.command.register({
      name: 'keepwarm',
      description: 'Keep the prompt cache warm: bare for 6h, a window such as 90m, always, off, or status (cache-tax)',
      argumentHint: '[6h | always | off | status]',
      immediate: true,
    })
    await $.command.register({
      name: 'cache-tax',
      description: 'Prompt cache state, cold price and this session\'s cold writes; guard warn|refuse (cache-tax, the Mod)',
      argumentHint: '[status | guard warn | guard refuse]',
      immediate: true,
    })
    // The hook form of cache-tax ships a /cache-tax:status skill; both installed means two guards.
    const commands = await $.command.list()
    if (commands.some(c => c.name === 'cache-tax:status')) {
      $.ui.log('the hook form (cache-tax@claude-code-hooks) is also installed, so a cold send is warned about or refused twice. Uninstall it, or /cache-tax guard warn here.')
    }
    updateStatus($, s, now)
    return r
  })

  // On Team and Enterprise accounts a managed plugin seated above this tier handles classic.* and continues beneath it, so
  // nothing here is relied on alone: session.end carries the /clear, turn.step the compaction, and the engine's own figures
  // the resumed context. What arrives here refines that, once: a clear already ended is only seated, a seat is never redone.
  on('session.end', async ($, e, next) => {
    // Only the conversation this state sits in: after the classic start of the next one, the old id is history.
    if ((e.reason === 'clear' || e.reason === 'resume') && e.sessionId === s.sid) await endConversation($, s, e.reason)
    return next(e)
  })

  // Resume fields seed the guard before any turn of the resumed session has run.
  on('classic.SessionStart', async ($, e, next) => {
    const r = await next(e)
    // A resumed or cleared conversation is not the one a ping in flight was sent for.
    outdate(s)
    // The conversation moved under this state without session.end reaching it: the payload names another id, or a
    // clear names none. One that already seated the new id (a command ran first) is left as it is.
    if (s.sid && (e.session_id === undefined ? e.source === 'clear' : e.session_id !== s.sid)) await endConversation($, s, e.source === 'clear' ? 'clear' : 'resume')
    // No session.start fires after /clear, so this is where always arms the new conversation.
    await reseat($, s)
    if (e.source === 'clear') return r
    const line = seedFromResume(s, e, await $.clock.now())
    if (line) $.ui.log(line)
    // The seeded clock decides whether a restored or always window pings before the first turn: never when it is cold.
    await arm($, s)
    return r
  })

  on('command.run', { command: 'keepwarm' }, async ($, e) => {
    await reseat($, s)
    const words = String(e.args ?? '').trim().split(/\s+/).filter(Boolean)
    const now = await $.clock.now()
    if (words[0] === 'off') {
      const wasAlways = s.always
      await stop($, s, null, true)
      return { text: wasAlways ? 'keepwarm is off, and always is off for every session from its next turn' : 'keepwarm is off' }
    }
    if (words[0] === 'always') {
      s.always = true
      await $.store.set(KEY_ALWAYS, true)
      await startWindow($, s, DEFAULT_WINDOW_MS, PING_AFTER_MS)
      const cold = isCold(s, now) ? `. The cache is cold now, so the first ping comes ${fmtDuration(s.every)} after the next turn` : ''
      return { text: `keepwarm always on: every session stays warm until ${fmtDuration(DEFAULT_WINDOW_MS)} after its last turn; /keepwarm off turns it off for good${cold}` }
    }
    if (!words.length) {
      await startWindow($, s, DEFAULT_WINDOW_MS, PING_AFTER_MS)
      return { text: armedText(s, now, DEFAULT_WINDOW_MS) }
    }
    if (words[0] !== 'status') {
      const window = parseDuration(words[0])
      if (!window) return { text: 'keepwarm takes a window such as 6h or 90m, or always, off, or status' }
      // "every 2m" is a testing knob and lasts only for the window it was given with.
      let every = PING_AFTER_MS
      if (words[1] === 'every') {
        const period = parseDuration(words[2] ?? '')
        // A period of the cache's whole hour or more would fire only once the cache is already cold.
        if (period == null || period < MIN_PING_MS || period >= TTL_MS) return { text: 'every takes a period from 1m to 59m' }
        every = period
      }
      await startWindow($, s, window, every)
      const rolls = s.always && (window < DEFAULT_WINDOW_MS || every !== PING_AFTER_MS)
      return { text: armedText(s, now, window) + (rolls ? `. Always is on, so your next turn makes it at least ${fmtDuration(DEFAULT_WINDOW_MS)} at one ping per ${fmtDuration(PING_AFTER_MS)}` : '') }
    }
    return { text: statusText(s, now) ?? 'keepwarm is off' }
  })

  on('command.run', { command: 'cache-tax' }, async ($, e) => {
    await reseat($, s)
    const words = String(e.args ?? '').trim().split(/\s+/).filter(Boolean)
    const now = await $.clock.now()
    if (words[0] === 'guard') {
      if (words[1] !== 'warn' && words[1] !== 'refuse') return { text: '/cache-tax guard takes warn or refuse' }
      s.guard = words[1]
      await $.store.set(KEY_GUARD, s.guard)
      return { text: s.guard === 'refuse' ? 'guard set to refuse once: a cold send is dropped with its price, the resend goes through' : 'guard set to warn: a cold send goes through with its price shown' }
    }
    return { text: card(s, now) }
  })

  // The message that pays. Only its first character is read.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'plugin') return next(e)
    await reseat($, s)
    if (typeof e.text !== 'string' || e.text.trimStart().startsWith('/')) return next(e)
    const now = await $.clock.now()
    // Without the time of the last response nothing says whether the cache is cold: the price is shown once and the message goes through.
    if (s.resumedAt) {
      const cold = mayBeCold(s, now)
      s.resumedAt = 0
      if (cold && s.ctx >= BIG_TOKENS) $.ui.log(unknownText(s))
      return next(e)
    }
    if (!isCold(s, now) || s.ctx < BIG_TOKENS) return next(e)
    // A refused prompt that no person sent would be lost: nobody is there to send it again.
    const unattended = UNATTENDED.has(e.origin.kind)
    if (s.guard === 'warn' || unattended) {
      $.ui.log(`${guardText(s, now)} Sending anyway${unattended ? `, since this ${e.origin.kind} prompt cannot be sent again` : ''}; keepwarm will hold the cache for ${fmtDuration(holdMs(s))} once it lands.`)
      s.coldWritePending = true
      return next(e)
    }
    if (s.ackedAt === s.lastRequestAt) {
      s.ackedAt = 0
      s.coldWritePending = true
      return next(e)
    }
    s.ackedAt = s.lastRequestAt
    return { drop: `cache-tax: ${guardText(s, now)} Send it again to pay it, and keepwarm will then hold the cache for ${fmtDuration(holdMs(s))}. Or /clear and start from a note.` }
  })

  on('turn.step', async function* ($, e, next) {
    if (!e.agentId) {
      await reseat($, s)
      // The off count when the turn's first request went out: an off after it wins over what the turn opens.
      if (e.index === 0) s.turnOffs = s.offs
      // A compaction leaves a summary where tens of messages were; a rewind takes a few off. A request over fewer than half the
      // last one's messages is read as a compaction, whether or not session.compact arrived. The context stays as it was, so
      // turn.complete still scores a cold write this turn paid against it before the live figure replaces it.
      if (e.messageCount * 2 < s.transcript) markCompacted(s)
      s.transcript = e.messageCount
      // Only a request sent before any compaction this turn saw can hold a cold write; what follows one is the summary.
      if (!s.compacted) s.steps++
      s.lastRequestAt = await $.clock.now()
    }
    const r = yield* next(e)
    // Each request's write is priced at its own prompt length's tier (Haiku 5.5 changes price at 100k), not the turn's sum.
    const u = r.usage
    if (!e.agentId && u && !s.compacted) {
      const price = priceOf(u.model || e.model, u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens)
      const was = s.stepWrites ?? { tokens: 0, usd: 0, priced: true }
      s.stepWrites = { tokens: was.tokens + u.cache_creation_input_tokens, usd: was.usd + (price ? u.cache_creation_input_tokens * price[1] / 1e6 : 0), priced: was.priced && price != null }
    }
    return r
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId) return r
    // An off at any point in this turn wins over every window the turn would open; a host that raised no
    // step falls back to the count at completion.
    const offs = s.turnOffs ?? s.offs
    s.turnOffs = null
    const now = await $.clock.now()
    // A sleeping host may deliver this turn before the expired window's timer.
    if (s.deadline && now >= s.deadline) await stop($, s, null)
    // turn.step stamps the exact request time; when no step of this turn did, the turn's end is the floor.
    // A turn aborted before it sent anything touched no cache, so it leaves the clock alone.
    if ((e.usage || !e.isAborted) && now - s.lastRequestAt > e.durationMs) s.lastRequestAt = now
    const compacted = s.compacted
    s.compacted = false
    if (s.lastRequestAt) s.resumedAt = 0
    s.waitForTurn = false
    s.ackedAt = 0
    // Always covers any break up to six hours after a turn that reached the cache (a turn that failed before any
    // response touched nothing, and its cache may be cold): a window of at least six hours at the default period,
    // which brings back a stopped window and replaces a shorter one or a testing period. Another session's
    // /keepwarm off or /keepwarm always changes the shared switch, so every such turn reads it.
    if (e.usage) {
      const shared = (await $.store.get(KEY_ALWAYS)) === true
      if (s.offs === offs) s.always = shared
      if (s.always) await startWindow($, s, Math.max(DEFAULT_WINDOW_MS, s.deadline - now), PING_AFTER_MS, offs)
    }
    const u = e.usage
    if (u) {
      if (u.model) s.lastModel = u.model
      const prev = s.ctx
      // A turn's usage is its responses summed, so a ten-step turn reports ten
      // reads of the context. The live window is the engine's figure; the sum
      // is only the fallback for a host that reports no tokens.
      const written = u.cache_creation_input_tokens
      const live = (await $.session.usage()).context.tokens
      s.ctx = live && live > 0 ? live : u.input_tokens + u.cache_read_input_tokens + written
      // A compaction since the last complete turn: what followed it is the summary, no cold write, so the turn is scored
      // on the requests before it alone. None before it leaves nothing to score, whatever the guard saw; requests before
      // it that reported no usage leave only the turn's total, an upper bound kept for a send the guard saw go cold.
      const writes = s.stepWrites
      const write = !compacted ? written : writes ? writes.tokens : s.steps && s.coldWritePending ? written : 0
      const full = prev > 20000 && write >= 0.5 * prev
      if (full || (s.coldWritePending && write > 0)) {
        // Priced per request when the steps reported usage; otherwise at the tier of the context the comeback re-sent.
        const price = priceOf(s.lastModel, prev || s.ctx)
        const usd = writes?.priced ? writes.usd : price ? write * price[1] / 1e6 : null
        s.misses.push({ at: now, tokens: write, usd })
        const extend = s.deadline < now + AUTO_WARM_MS && s.offs === offs
        if (extend) await startWindow($, s, AUTO_WARM_MS, s.every, offs)
        $.ui.log(`cold write of ${fmtTok(write)} tokens paid (${fmtUsd(usd)}).` +
          (extend ? ` Keeping the cache warm for ${fmtDuration(AUTO_WARM_MS)} so it is not paid again today; /keepwarm off to stop.` : ''))
      }
    }
    s.coldWritePending = false
    s.stepWrites = null
    s.steps = 0
    await arm($, s)
    return r
  })

  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    if (!e.agentId) {
      markCompacted(s)
      // Between turns nothing is left to score, and the next turn's summary write is not a cold write.
      s.ctx = 0
      disarm(s)
      await arm($, s)
    }
    return r
  })
}
