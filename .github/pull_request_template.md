## What and why

<!-- One or two sentences: what changes for the user, and the case that needs it. Link the issue. -->

## Evidence

<!-- Match the change (see CONTRIBUTING.md, "Show that it works"). Delete the lines that do not apply. -->

- Screenshot or recording, before and after (real capture; Claude Code version and surface):
- Test that fails before the change and passes after:
- For anything that waits (clock, store, dialog, turn): test that runs a `/clear`, resume or `/keepwarm off` in the middle:
- Cost arithmetic, if pings change:

## Checks

- [ ] `claude plugin validate .` passes
- [ ] `claude plugin test .` passes: N tests
- [ ] `tsc -p .` is clean
- [ ] README updated if behaviour, commands or "What it can reach" changed
- [ ] Version in `plugin.json` left alone
