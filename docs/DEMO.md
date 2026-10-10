# Demo Recording Plan

Goal: one real, unscripted 15–30 second recording of a complete task, embedded near the top of `README.md` as `docs/demo.gif`.

Status: **not yet recorded.** This document contains everything needed to record it. Do not publish a mock or a simulated result.

## Why it is not recorded yet

Capturing the real flow requires a human-driven graphical session: a running dev server, Pi's interactive terminal UI, the dedicated Chromium window, and screen capture of all three. An automated test run cannot produce this — insertion uses Pi's real editor cursor, and the final shot needs a genuine agent turn. Record it manually on a machine with a desktop.

## Sample app requirements

- Any small local app with visually distinct, self-explanatory elements (for example, a pricing card, a to-do row, or a form header) served by a dev server on `localhost`.
- **No personal data, API keys, secrets, real user content, or proprietary code on screen.** Prefer a dedicated demo repo or a scratch Vite/Next app.
- A change the agent can visibly complete in one turn (e.g. widening a button and left-aligning its label), so the "after" shot is real.

## Shot list (15–30 s)

| Time | Shot |
|---|---|
| 0–4 s | Terminal: dev server already running; type `/preview http://localhost:5173`. Dedicated Chromium window opens with the picker panel. |
| 4–10 s | Switch panel to **Select**; hover a target element (amber outline), click it. Optionally click **Parent** once to grab the container. |
| 10–15 s | Click **Insert into Pi**. Cut to Pi's editor showing `@element_1` at the cursor; type: `Make @element_1 wider and align its label to the left. Keep the existing colors and typography.` |
| 15–25 s | Send the prompt; agent edits the code. End on the preview showing the actual applied change (reload the page if the dev server doesn't hot-reload). |
| 25–30 s | (Optional) Footer card: product name + repository URL. |

## Recording tips

- Record at the terminal's native size; zoom editor/browser fonts so the alias `@element_1` is legible at README width (~800 px). Crop to the two relevant windows.
- Tools: macOS QuickTime/OBS for capture; convert with `ffmpeg -i demo.mp4 -vf "fps=12,scale=800:-1:flags=lanczos" -loop 0 docs/demo.gif`. Keep the GIF under ~10 MB; if larger, use an MP4 and embed it the same way.
- Keep the exact example prompt used here and in the README identical.
- One take per shot is fine; cut between shots rather than speeding up footage.

## Acceptance checklist

- [ ] Full flow shown is real: open → select → insert → send → visible result. No cuts that fake an outcome.
- [ ] Screen contains no secrets, personal data, or unrelated private files.
- [ ] `@element_1` is readable at embed size; prompt text matches the README example.
- [ ] The "after" frame shows the page actually changed by the agent.
- [ ] File saved as `docs/demo.gif` (or `docs/demo.mp4`).

## Embedding

Once the file exists, uncomment the embed in `README.md` (Demo section):

```markdown
![Demo: selecting an element in the local preview and inserting @element_1 into Pi](docs/demo.gif)
```
