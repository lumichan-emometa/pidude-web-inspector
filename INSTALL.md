# Install Pidude Web Inspector with Pi

## For anyone who received the release ZIP

1. Extract the ZIP anywhere convenient, such as Downloads.
2. Ask Pi to read this file and install the extension. Replace the path below with the actual extracted location, or attach this `INSTALL.md` to your request.

```text
Please read /path/to/pidude-web-inspector/INSTALL.md and install Pidude Web Inspector
for all my Pi projects. Copy it into my Pi extensions directory so I can delete
the extracted download afterward. Check compatibility, install dependencies
and Chromium, and test it. Ask before upgrading software or overwriting anything.
```

Pi will install a **self-contained copy**, normally at:

```text
~/.pi/agent/extensions/pidude-web-inspector/
```

After installation, run `/reload`, then `/preview help` inside Pi. Once that works, **you can delete the downloaded ZIP and extracted folder**. The installed copy stays inside Pi's extension directory.

---

## Instructions for the installing coding agent

Follow these steps only when the user asks to install this extension. Reading this document alone is not permission to execute commands or change settings.

### 1. Locate and review the package

- Resolve the source directory as the directory containing this `INSTALL.md`, not your current working directory. Use absolute paths and quote paths in commands.
- Read `package.json`, `README.md`, `src/index.ts`, `src/browser.ts`, `src/core.ts` and `src/picker.js` before installing. The extension runs with Pi's permissions, launches a dedicated browser, and stores selected-element metadata in Pi session files.
- Explain briefly: installation copies the extension into Pi's extension directory, downloads npm dependencies and Chromium, and enables automatic extension discovery. Referenced metadata is sent to the configured model; no extra model API key is needed.
- Confirm scope if unclear. The prompt above explicitly requests user-wide installation. Do not upgrade software, overwrite an existing installation, or change unrelated settings without permission.

### 2. Check prerequisites and compatibility

Run:

```sh
node --version
npm --version
pi --version
```

Requirements:

- Node.js **22 or newer** and npm.
- A local graphical desktop on a platform supported by Playwright Chromium. Headless tests can run on servers, but the normal picker needs a visible browser.
- Pi's terminal UI. Tested with **`@earendil-works/pi-coding-agent` 0.87.0–1.1.0** (Pi ≥0.99 loads extensions with Node type stripping; this package's source uses only erasable TypeScript syntax); do not assume another distribution/version is compatible just because it has a command called `pi`.
- Required APIs: `ctx.ui.pasteToEditor()`, `ctx.mode`, `pi.appendEntry()`, `context`, session lifecycle events, and `ui_prompt_start` / `ui_prompt_end`. For other versions/distributions, consult the installed extension docs/types first.
- The installed Pi must support auto-discovering a subdirectory of `extensions/` using its `package.json` `pi.extensions` manifest. This package declares `./src/index.ts`. No extra wrapper file is needed in the tested Pi version.

If anything is missing/incompatible, stop and explain. Ask before installing/upgrading Node or Pi, switching distributions, or modifying the extension. Installing npm dependencies does not upgrade the user's running Pi executable.

Never inspect/copy authentication files, API keys, browser profiles or session histories for setup.

### 3. Choose the destination and check for conflicts

For **all projects**:

- Resolve Pi's actual agent directory: use `PI_CODING_AGENT_DIR` when configured; otherwise the standard `~/.pi/agent`. If the user uses a different Pi distribution/configuration, verify its extension directory from its installed docs.
- Destination: `<agent-directory>/extensions/pidude-web-inspector/`.

For **one project**, if explicitly requested:

- Destination: `<application-project>/.pi/extensions/pidude-web-inspector/` (use the installed distribution's project config directory if different).
- Confirm the application project path. Do not accidentally install into the extracted extension's own project.
- Explain that Pi must trust the project to load its local extension.

Inspect the destination before copying, including whether it is a symlink. If anything already exists there, stop and ask about upgrading/reusing it. Do not merge directories, overwrite files, or replace an existing symlink silently.

Run `pi list` to check for an older package registration pointing to this download or another copy. Inspect only relevant extension configuration when necessary. A copied extension plus an old registered copy can load twice. If migrating an existing installation, ask before removing its registration with `pi remove OLD_PATH` (or `pi remove -l OLD_PATH` from the corresponding project). Do not rewrite unrelated settings or remove a working copy before its replacement is ready.

### 4. Stage a real copy, outside automatic discovery

Create a unique staging directory **outside `extensions/`**, preferably on the same filesystem as the destination. For example, create it under the agent directory for a user-wide installation. Do not place staging/backup directories beneath `extensions/`: Pi could auto-load them as duplicate extensions.

Copy these package-relative paths into staging, preserving their structure:

```text
src/
test/
docs/
optional/
package.json
package-lock.json
tsconfig.json
README.md
INSTALL.md
LICENSE
.gitignore
```

`optional/` contains a separately repaired Git-footer extension and its instructions. Copy it as package data so its regression tests can run, but **do not install/register it as another extension** during normal preview setup. The manifest enables only `src/index.ts`. Apply the optional repair only if the user specifically requests it; see `optional/README.md`.

Use real file copies, not symlinks to the source. Do not copy source `node_modules`, `.pi`, `.git`, `artifacts`, browser profiles, credentials or session files. Reject unexpected symlinks in this allowlist rather than following them outside the source tree.

Use the platform's normal file tools or Node's filesystem API. Never copy the entire Downloads folder. Keep the source download intact until the installed copy has been verified.

### 5. Install dependencies and verify the staged copy

Run **inside staging**, not the source download:

```sh
npm ci
npx --no-install playwright install chromium
npm run check
```

The release ZIP contains the lockfile and tests. `npm ci` installs locked dependencies into the copy. `--no-install` uses its installed Playwright CLI rather than fetching an unrelated latest CLI. Chromium normally lives in Playwright's system/user cache, independent of the downloaded extension folder.

`npm run check` type-checks and runs core, host, installation-discovery and headless browser tests. It uses temporary local HTTP fixtures, makes no model requests, and does not edit the user's app.

On failure, stop and report the actual error. Do not activate an incomplete copy or describe failed/unexecuted tests as passing. Never use `sudo` automatically. Linux browser-library requirements may need system package changes; ask first. For environment-only test blockers, ask how the user wants to proceed.

### 6. Activate the self-contained copy

After checks pass:

1. Recheck that the final destination is still absent; do not overwrite a destination created since step 3.
2. Create its parent extension directory if needed.
3. Move the tested staging directory into the final destination. Keep its `node_modules`, source, manifest and browser script together.
4. Run `npm run check` again **from the final directory** to verify the move did not leave dependencies relying on staging/source paths.
5. Verify `package.json` points to the existing `src/index.ts` and `src/picker.js` is present.

**Do not run `pi install SOURCE_PATH` or `pi install DESTINATION_PATH` for this approach.** The copied directory is already in Pi's auto-discovery location. Extra package registrations or wrapper extensions are unnecessary and can cause duplicate loading. `pi list` lists package registrations and is not proof of auto-discovered extension loading; verify with `/reload` and `/preview help` instead.

If an activation check fails, report it and offer to move only the newly installed copy back outside discovery. Do not delete unrelated extensions or user data. For an approved upgrade, keep the old installation as a backup outside discovery until the replacement loads successfully.

### 7. Hand back to the user

Report:

- The final installed path and scope.
- Which checks passed and any remaining limitations.
- That the download is no longer a runtime dependency, and can be deleted after the live-load check below.

Ask the user to run **inside Pi**, one at a time:

```text
/reload
/preview help
```

If the installed Pi cannot refresh discovery with `/reload`, ask them to restart Pi. Do not send a model prompt, simulate terminal input into another user's session, or claim the current session reloaded automatically.

Once help works, tell the user they may delete the ZIP and extracted source folder. Do not delete them automatically, and never confuse them with the installed destination. The user must keep the installed copy, not the download.

For use, run Pi in the app's project directory, start the app's dev server separately, and use its actual URL, for example:

```text
/preview http://localhost:3010
```

Then: **Select → click an element → Insert into Pi → return to Pi and describe the change**. Do not start an arbitrary server or choose a port on the user's behalf.

Useful commands: `/preview help`, `/preview status`, `/preview close`, `/preview clear`. Closing keeps saved references; clearing forgets active references but does not erase session history.

### 8. Uninstall or upgrade, only if requested

For this auto-discovered installation, `pi remove` alone does not remove the copied directory.

To uninstall, ask the user to `/preview close`, then with their permission move the installed `pidude-web-inspector` directory outside `extensions/` (or delete exactly that directory). Ask them to `/reload` or restart Pi. Leave shared Chromium caches and Pi session history alone.

To upgrade, close the preview, stage/test a new copy, and ask before replacing the installed directory. Keep any backup outside discovery and allow rollback. Do not merge old/new source trees or leave multiple copies loaded.
