# v0.1 validation

## Executed

Environment: macOS arm64, Node 24.6.0, Pi 1.1.0 (also validated on 0.87.0 and 0.87.1), Playwright 1.63.0 / bundled Chromium.

- `npm run typecheck`: passed.
- `npm test`: 22 tests passed.
- `npm run test:browser`: 5 browser integration scenarios passed (multiple assertions per scenario), including minimize/restore and lifecycle hardening.
- Real Pi TUI smoke: loaded `src/index.ts` through Pi's extension loader using explicit `-e`; launched visible Chromium with `/preview`; inserted a browser selection into the middle of a draft; closed browser and exited the test Pi session. No model request was sent.
- Actual draft before insertion: `Make this smaller`, caret immediately before `smaller`.
- Actual draft after insertion: `Make this  @element_1 smaller` (padding intentionally retains the pre-existing space).
- Browser screenshot reviewed at `artifacts/picker.png`.

## Automated coverage

Core: schema field limits, control/bidi sanitization, metadata allowlist, loopback URL restriction, exact aliases, duplicate references, persistence-before-acknowledgment, restore/clear/branch high-water behavior, allocation limit, model-context immutability, queued user messages, context budgets and unavailable/omitted reporting.

Host: help aliases and guide content without browser/state changes, session restore, input validation, unknown-reference draft restoration, hidden context projection, clear markers, invalid URL rejection before launch. Lifecycle tests cover opening/connected/closed footer states, saved-reference retention, stale callback rejection, concurrent opens waiting for cleanup, latest-request-wins, close/shutdown during launch, idempotent close, status reconciliation, failed startup, actionable errors, and query-redacted diagnostics.

Browser: Interact behavior, SVG/button normalization, pointerdown/click suppression, registration and insertion, same-candidate alias reuse, copy acknowledgment/fallback, blocking-dialog refusal, sensitive-descendant exclusion, parent selection, frame shielding/inert cleanup, Escape, link navigation and reinjection, keyboard selection, pathname-only capture, duplicate IDs, subframe binding rejection, off-origin rejection, close and close-during-startup. Real Chromium lifecycle tests additionally cover manual page closure, browser quit, an actual renderer crash via CDP, single disconnection notification, repeatable close, and closing while navigation is waiting on an unresponsive local server. Minimize/restore coverage includes keyboard focus, preserving the selected candidate and mode, click-through in the old panel footprint, automatic reopening on selection, Escape while minimized, and narrow-viewport bounds.

Installation: actual Pi discovery/loader tests for copied global and project-local packages. Each test copies source into staging, moves it to an isolated extension directory, deletes the simulated download, and successfully discovers the manifest entry and invokes `/preview help` without explicit package registration. These tests validate discovery and source independence; they do not download/reinstall npm dependencies or Chromium (the installer guide calls for a full check from the final directory).

Optional Git-footer repair: five regression scenarios cover cancellation at each Git-command boundary, timer-triggered shutdown, preventing overlapping scans, containing process and stale-UI errors, retrying failed scans, old/new run isolation, and immediate shutdown during filesystem discovery. Tests use a guarded mock Pi host and abort-aware command interface; no user repositories are edited. The repaired optional file is byte-identical to the patched local global extension. Existing Pi processes require a restart to load it.

## Remaining manual acceptance

- [x] Project-local installation and use: user exercised the extension on a Next.js dev server and successfully referenced an element in a prompt.
- [ ] On a real React/Vue/etc. dev server, select multiple elements and submit a change request. Verify source edits target the intended components.
- [ ] Resume a persisted real Pi session; reference a previously selected element. Registry restore is unit/host tested; real persisted-session resume remains to be checked.
- [ ] Exercise `/tree`, `/fork`, `/new` and reload while the browser is open in real Pi (branch restoration and shutdown logic have automated coverage, not every interactive flow).
- [ ] Test OS clipboard contents manually; browser tests exercise the copy path and feedback, not the user's system clipboard.
- [ ] Test accessibility with a screen reader and a narrow viewport.
- [ ] Test other supported desktop OSes and custom Pi editors.

## Known deviations from the original builder spec

- Main interface is a browser overlay plus Pi terminal, not an iframe inside a builder.
- Private Playwright binding replaces a BFF/HTTP endpoint; only the selected managed page/origin can use it.
- Request-time context projection replaces a `/chat` API and supports queued Pi messages.
- Persistent custom session entries retain metadata; clean visible history does not imply metadata-free session files.
- Insertion adds surrounding spaces rather than querying/replacing a browser textarea selection.
- Deep iframe/shadow DOM selection and framework source instrumentation are deferred.
