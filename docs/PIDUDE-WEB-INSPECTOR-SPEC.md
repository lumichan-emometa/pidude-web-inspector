# Pidude Web Inspector

Status: v0.1 implementation specification

## 1. Goal

Select a rendered element in a local dev-server page, insert a concise `@element_N` reference at the current Pi terminal editor cursor, and supply bounded source-location hints to the coding agent when that reference is used.

This adapts `PREVIEW-ELEMENT-SELECTION-SPEC.md` to Pi's terminal interface. No Pi fork, application source modification, cloud service, or browser extension is required.

## 2. v0.1 scope and UX

- `/preview http://localhost:5173` opens a dedicated, visible Chromium window. HTTP(S) loopback URLs only; credentials are rejected. An explicit URL is required.
- `/preview`, `/preview help`, `/preview -h` and `/preview --help` show commands and a step-by-step guide without starting/stopping a browser or changing reference state. `/preview status` shows connection status and explains that saved-reference counts are element snapshots, not browser counts; `/preview close` closes the managed browser, preserving references; `/preview clear` closes it and forgets references on the current session branch, without recycling aliases or rewriting drafts/history.
- A compact fixed toolbar offers **Interact** (default) and **Select**, a candidate label/selector, **Insert into Pi**, and **Copy reference**.
- **Minimize** collapses the panel to a small bottom-right restore button, freeing the panel's former footprint for page interaction. Preserve mode and candidate. The button says **Pi · Select** while Select remains active, otherwise **Pi · Preview**. Restore via click/keyboard; selecting another element automatically reopens the panel without stealing page focus. Escape still exits Select while minimized. Move keyboard focus to the restore button on minimize and back to the minimize button on explicit restoration. Start expanded after document navigation; do not write UI state to application storage.
- In Select, hover gets an amber outline; selected candidate remains outlined; tagged nodes get a blue outline. These are browser overlay rectangles, not changes to application styles or source. A temporary cursor stylesheet is removed when leaving Select. Up to 100 iframe elements receive temporary inert state and pointer shields so their containers can be selected without activating frame contents; pre-existing inert state is preserved.
- Pointer/mouse activation is intercepted at the window capture phase before application handlers. Escape returns to Interact; Enter/Space on a focused page element selects it instead of activating it. Picker controls remain keyboard accessible.
- Prefer interactive ancestors for nested spans/SVG paths. Allow selecting a candidate's parent via **Parent**.
- Confirmation registers an immutable metadata snapshot first. Insert then calls `ctx.ui.pasteToEditor()`. Copy copies only the registered alias; it is meaningful only in the paired Pi session.
- Insert never submits a prompt, starts a turn, simulates OS keyboard input, replaces the whole draft, or steals OS focus. v0.1 surrounds inserted aliases with spaces because Pi's public paste API does not expose cursor-adjacent text. Clipboard output has no padding.
- Browser controls report success/failure. Pi displays connection/reference counts in its status line. While Pi has a blocking extension dialog open, insertion is refused (copy remains available).
- Reload/navigation on the approved origin restores the picker in Interact mode. Captured metadata survives detached nodes, navigation, browser closure, Pi reload and resume.

## 3. Architecture

```text
Pi extension --launch--> dedicated Playwright Chromium (ephemeral profile)
     ^                         |
     |  source-checked binding | picker executes in approved top-level document
     +-------------------------+
     |
     +-- validate metadata --> session registry --> paste alias into Pi editor
     +-- context hook --> append bounded metadata to request-time user-message copies
```

Use Playwright's private browser transport and a randomly named exposed binding, not an HTTP/WebSocket server. There is no public listening bridge port, CORS policy, or bearer token exposed through URLs. Validate the source page, main frame and exact origin on every call; a random binding name is defense in depth, not authentication against the approved page. The page is untrusted and can call its own binding: accepted data is hints only, never commands, paths to execute, or permissions.

Only one managed page is authorized. Popups and subframes do not gain bridge access. Same-origin main-frame navigation is supported; off-origin documents receive no picker and bridge calls are rejected. The browser may navigate normally in Interact mode; reopening `/preview URL` establishes a new explicit origin authorization. Loopback restriction applies to the initial target, not to every resource the app itself loads.

## 4. Data contract

```ts
interface ElementContext {
  tag: string;             // @element_1 ... @element_999
  selector: string;        // <= 500 characters, best-effort CSS
  element: string;         // <= 40 characters, lowercase tag name
  text?: string;           // <= 240 characters
  role?: string;           // <= 80 characters
  ariaLabel?: string;      // <= 160 characters
  pagePath: string;        // <= 300 characters, pathname only
}
```

The Node side allocates tags. Browser-supplied tags, origins and page paths are not trusted; the path comes from the checked Playwright frame URL. Reject malformed required fields; strip control/bidi characters; normalize whitespace; bound fields and raw request size (8 KiB). Reject unknown actions. Maximum 999 allocated references per session. No alias reuse after clearing or branching; scan all session entries for the high-water mark. Branch-visible state comes only from entries on the active branch.

Selector priority: verified unique ID, verified unique test attribute, then short ancestor chain with escaped classes and nth-of-type disambiguation. The selector is a hint, never a guarantee of a JSX/source location.

Text extraction must skip input/textarea/select, editable subtrees, scripts/styles, hidden content and picker UI, including when a parent is selected. Never capture `.value`, HTML, cookies, storage, network data, or URL queries/fragments. Bound text traversal work as well as output. Accessible labels are best effort (`aria-label`, safe `aria-labelledby`, image alt), not a full accessibility-tree implementation. Page text and labels can still contain sensitive information: the user must select only content they intend to share.

## 5. Pi lifecycle and persistence

- Extension factory registers handlers only; launch resources only in `/preview`.
- TUI-only browser commands/insertion. No claim of RPC/editor-host support in v0.1.
- Persist each accepted reference in a versioned `pidude-web-inspector:reference` custom entry. These entries are not automatically model context or visible chat messages.
- Persist clear markers in `pidude-web-inspector:clear`. Restore on session start and tree navigation, retaining the session-wide allocation high-water mark.
- Stop the browser on session shutdown, reload, switch, fork and clear. In-flight launch and callbacks must not revive resources or write into a replacement session.
- The registry is scoped to the current Pi session/branch, never a process-global singleton.
- Explicit states: idle (footer hidden until used), opening, connected, closed. Footer shows the authorized origin while opening/connected and **N saved refs**, including zero after a close. The origin is the connection target, not necessarily the current navigated route.
- Browser page/window close, process disconnect and renderer crash transition to closed exactly once and release the dedicated browser. Close is idempotent and awaits in-flight launch/navigation cleanup before a replacement opens.
- Serialize cleanup and assign each command a generation ticket. Only the newest operation/handle can insert references or update live status. Close/shutdown during startup must not revive connected status; stale disconnection events must not close a replacement preview.
- `/preview status` reconciles the transport's actual connectivity as a fallback for missed notifications. Shutdown clears the extension footer before releasing its UI context.
- Browser close/disconnect changes live status, not stored reference meanings. Reference counts intentionally survive reopening; clearing is a separate explicit operation.
- Connection-refused failures instruct the user to start/check their dev server. Only missing-executable failures suggest installing Chromium. Diagnostics omit URL queries/credentials.

**Privacy:** metadata is stored in Pi session JSONL and sent to the configured model when referenced. Hidden is not encrypted or absent from disk. Clear prevents future registry resolution but does not erase historical JSONL records or metadata already sent to a model.

## 6. Context construction

Use Pi's `context` hook to append a metadata block to copies of user messages before a model request. Do not transform persisted input. This also covers queued steering/follow-up user messages, which need not trigger `before_agent_start` individually.

- Parse exact aliases with numeric boundaries (`@element_1` is not `@element_10`).
- Only references present in user text are eligible; unrelated stored selections never enter model context.
- Deduplicate within each user message; maximum 12 references per message.
- Allocate a 16,000-character total appended-context budget per request, newest user messages first; warn in bounded metadata about missing/omitted references. Original user messages are never truncated.
- Label serialized JSON explicitly as untrusted UI metadata, not instructions. Tell the agent to locate source with text, labels, selector and path, and ask if ambiguous. Do not promote page text into the system prompt.
- Restore registry state independently of compaction; referencing an old alias explicitly still resolves it. Compaction may summarize previously enriched context like other model-visible data.
- Input validation refuses new prompts with unknown references or more than 12 distinct aliases and reports why. Interactive idle prompts are restored for editing. The context hook still reports unavailable aliases for historical or programmatic messages that bypass validation.

## 7. Browser design

A small instrument panel, not an app-builder shell: slate-blue ink `#20334d`, white `#ffffff`, cool surface `#edf3fa`, selection amber `#db8a17`, tagged blue `#316bce`, muted gray `#617086`. System sans for controls and monospace for selectors/references. The signature is the live element label paired with its exact tag, not decorative animation. No remote fonts/assets. An open shadow root isolates the panel from app CSS (it is not a security boundary); fixed, pointer-transparent outline layers do not affect layout. Panel width is bounded by the viewport, text wraps, controls show focus and pressed state, outcomes use a polite live region. No animation.

## 8. Explicit limitations

- Dedicated Playwright Chromium; does not attach to the user's normal browser/profile or inherit login state.
- Top-level light DOM only in v0.1. Iframe contents, closed/open shadow-root internals, canvas objects and browser chrome are not individually selectable; select the containing host/frame instead.
- Native browser top-layer dialogs can cover a normal overlay; picker top-layer integration is deferred.
- No screenshots, full accessibility snapshots, framework source instrumentation, automatic terminal foregrounding or custom editor replacement.
- Event cancellation prevents ordinary pointer/keyboard activation in the selected document. It cannot stop timers, network effects, hostile scripts or every custom application event system; Select mode is not a sandbox.
- Clipboard support depends on the browser environment. On failure show the registered alias for manual copying; registration remains valid.
- Exact whitespace-aware insertion and selection replacement follow the installed Pi editor's native paste behavior.

## 9. Test and acceptance plan

Unit: schema bounds, malicious/control text, URL allowlist, exact alias matching, registry clear/restore/high-water, branch isolation, context budget and deduplication.

Browser integration against a local fixture: nested span/SVG normalization, unique selector, pointerdown/click suppression, Interact behavior, keyboard select/Escape, sensitive descendant exclusion, Parent, insert/copy acknowledgments, registration reuse for repeated actions, navigation reinjection, source-origin rejection, browser cleanup.

Extension integration with a fake Pi host: registration persists before insertion, draft never submitted, context changes are non-persistent, queued user messages resolve, resume/clear behavior, blocking-dialog guard, shutdown cleanup. Typecheck all TypeScript. A real TUI smoke test must verify cursor position and installed-package loading; automated host tests are not a substitute for this.

## 10. Delivery sequence

1. Specification, package manifest and test scaffolding.
2. Validation/registry/context core and unit tests.
3. Browser picker and managed transport with browser tests.
4. Pi lifecycle/commands/persistence/editor integration and host tests.
5. README, installation instructions and manual TUI acceptance checklist.
