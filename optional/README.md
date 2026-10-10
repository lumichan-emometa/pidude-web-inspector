# Optional repair: workspace Git-branch footer

`workspace-git-branches.ts` is a repaired copy of a **separate Pi extension** that shows Git branches/status in the footer. It is not part of the browser picker and is **not automatically enabled** by Pidude Web Inspector's manifest.

## Why it is included

A recorded Pi crash pointed to `workspace-git-branches.ts`, where a background scan called `pi.exec` after a reload/session replacement invalidated its runtime. Stopping its interval did not cancel the scan already in progress. A startup/shutdown race could also recreate an interval after shutdown.

The repaired copy:

- Uses a fresh abort controller and isolated state for each session run.
- Passes an abort signal to Git commands and checks cancellation before/after commands and filesystem discovery.
- Invalidates the old run before aborting it, so it cannot publish status into a newer session.
- Waits for the active refresh during shutdown.
- Schedules the next scan only after the current one finishes and only if its run is still active.
- Contains background failures and stale-context UI errors instead of leaking unhandled rejections into Pi.
- Preserves the prior branch/status formatting and refresh interval.

## Install only if needed

**Do not install this merely because it came with the ZIP.** It is an optional repair for users who already have this Git-status extension and want it fixed.

Ask Pi:

```text
Read optional/README.md. I already use workspace-git-branches.ts and want the
stale-context crash repaired. Compare the included fixed copy with my installed
extension, preserve my customizations, and back up the existing file outside
Pi's auto-discovery directories before replacing it. Ask before overwriting.
```

Instructions for the agent:

1. Confirm that the user wants this separate repair. Locate their actual installed `workspace-git-branches.ts`; the usual path is `~/.pi/agent/extensions/workspace-git-branches.ts`. Respect their configured Pi agent directory. Do not invent/create a Git footer if none exists unless the user explicitly requests it.
2. Read both files and check compatibility with the installed Pi. If they differ beyond the lifecycle fix, preserve the user's changes or ask rather than blindly replacing the file.
3. Back up the original **outside all `extensions/` directories**. A backup `.ts` file inside discovery can load as an unwanted duplicate.
4. After approval, patch the lifecycle logic or copy the fixed file over that exact installed file. Do not add a second registration or load this optional directory independently.
5. Run this package's `npm run check`. The `test/workspace-git-branches.test.ts` tests exercise the included repaired copy; if you adapted the user's file, also verify/test the adapted implementation instead of claiming these tests cover different code.
6. Ask the user to restart affected Pi sessions to load the fixed code. Existing processes still have the old extension in memory; one more reload/shutdown of an old process may reproduce the old error. Never kill unrelated Pi sessions automatically.

No credential files, session histories or private configuration are included. The default `/preview` install keeps this optional file unregistered. Crash logs are not deleted or reported automatically.
