/**
 * The `$.cacheTax` noun as every caller sees it: read-only, so another mod
 * (a status band, say) can show keepwarm without parsing /cache-tax output.
 * Where cache-tax is not installed there is no `$.cacheTax`, so a caller
 * tests for it before use.
 *
 * Experimental until cache-tax 3.0: fields may be added, renamed or removed
 * in a minor release.
 */

/** Where keepwarm stands: `on` while a window is open, `stopped` after it gave up, `off` otherwise. */
export type CacheTaxKeepwarm = 'on' | 'stopped' | 'off'

export type CacheTaxStatus = {
  keepwarm: CacheTaxKeepwarm
  /** Time left in the window, in ms; 0 unless `on`. */
  leftMs: number
  /** The /keepwarm always switch. */
  always: boolean
  /** The always window in ms (six hours unless /keepwarm always <window> set another), or null while always is off. */
  alwaysMs: number | null
  /** The "Auto keepwarm" option: whether a paid cold write arms keepwarm by itself. */
  autoWarm: boolean
  /** What a cold send does: `refuse` asks first (refuse once where nobody can answer), `warn` shows the price and sends. */
  guard: 'refuse' | 'warn'
  /** Under `refuse`, the dollar floor below which a cold send goes through with its price shown; null for none. */
  guardFloorUsd: number | null
  /**
   * Whether the cache is cold now, or null before the first turn or after compaction. An estimate from the
   * one-hour clock since the last request, not a check of the server's cache: show it as one.
   */
  cold: boolean | null
  /** Why keepwarm stopped, when it did. */
  stopped: string | null
  /** Cold writes this session. */
  coldWrites: number
}

export type CacheTax = {
  /** The state as /cache-tax reads it, at this moment. */
  status: () => Promise<CacheTaxStatus>
}

declare module 'claude-code' {
  interface EngineInterface {
    cacheTax: CacheTax
  }
}
