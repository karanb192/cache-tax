# Contributing to Cache Tax

Thanks for helping. Cache Tax does two things: it keeps the prompt cache warm during breaks, and it tells you what a cold send will cost before you pay it. Changes that make either of those more accurate, cheaper or clearer are the ones most likely to land.

## Before you start

- **Bug fix:** open the PR directly. Link the issue if there is one.
- **Branch from current `main`.** If `main` moves while your PR is open, merge it in before asking for review. A PR built on an old release usually needs its changes redone by hand.
- **New feature or behaviour change:** open an issue first and describe the case. It saves you from building something that will not fit.
- **Out of scope for this mod:** writing files, sending prompts on your behalf, keeping prompt text, or calling the model for anything except a keepwarm ping. Those widen what the mod can reach (see [What it can reach](README.md#what-it-can-reach)). They may fit better as a separate mod that reads [`$.cacheTax.status()`](README.md#reading-the-state-from-another-mod).

## Show that it works

Every PR carries evidence that matches the change. A reviewer should be able to see what changed without checking out your branch.

| Your change | Evidence to include |
|---|---|
| Anything a user sees in Claude Code: the row above the prompt, the status line, a dialog, a command's reply | A screenshot or a short screen recording (under 30 seconds) from a real Claude Code session, before and after. Name the Claude Code version and the surface (terminal app, Desktop Code tab). Say which surfaces you did not check. |
| The website (`site/`), which deploys from `main` on merge | Browser screenshots before and after, at a desktop and a phone width, in light and dark mode. |
| Behaviour: when the guard stops or asks, when pings run, what gets scored | A test in `tests/register.test.ts` that fails before your change and passes after. Say in the PR that you checked it fails without the fix. |
| Timing: anything that waits on the clock, the store, a dialog or a turn | A test that holds that wait open and runs the competing event in the middle (a `/clear`, a resume, `/keepwarm off`, another command). Races are where most review findings come from, and a recording cannot show them. |
| Cost: anything that changes how often pings run or what they cost | The arithmetic: pings per window and their price against one cold write. |

Screenshots and recordings must be real captures of the running thing. Do not render a mock-up and present it as a screenshot. If you cannot capture or run something, say so and why; an honest gap is easier to review than a guess. Leave out anything private on screen, such as other conversations or file paths.

## Checks to run

```sh
claude plugin validate .
claude plugin test .
npx -p typescript tsc -p .
```

The typecheck needs the generated declarations in `.claude-plugin/types/`, which Claude Code writes when it loads the plugin from your checkout (`claude --plugin-dir .`); keep them untracked. Paste the pass count from `claude plugin test .` into the PR.

The test kit can set the plugin's options for one test, so a `userConfig` option is testable end to end: `test('name', { options: { autoWarm: 'off' } }, async ($, on) => { ... })`.

## In the PR

- Keep the title and description in step with the final diff. If a coding agent wrote the PR, read its description against the diff before you open it; the same evidence applies.
- Update the README when behaviour, commands or [What it can reach](README.md#what-it-can-reach) change, including the test count.
- Leave the version in `.claude-plugin/plugin.json` alone. It is set at release.
