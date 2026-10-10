import { readdir, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type RepoBranch = {
  name: string;
  branch: string;
  isCurrentDirectory: boolean;
  dirty: boolean;
  ahead: number;
  behind: number;
  hasUpstream: boolean;
};

const STATUS_ID = "workspace-git-branches";
const REFRESH_MS = 2_000;
type GitExec = (args: string[]) => ReturnType<ExtensionAPI["exec"]>;
type RefreshRun = {
  ctx: ExtensionContext;
  controller: AbortController;
  timer?: ReturnType<typeof setTimeout>;
  pending?: Promise<void>;
};

export default function workspaceGitBranches(pi: ExtensionAPI) {
  let active: RefreshRun | undefined;
  const isActive = (run: RefreshRun) => active === run && !run.controller.signal.aborted;

  function stop(): RefreshRun | undefined {
    const previous = active;
    active = undefined; // Invalidate callbacks before aborting any asynchronous work.
    if (previous) {
      clearTimeout(previous.timer);
      previous.timer = undefined;
      previous.controller.abort();
    }
    return previous;
  }

  async function refresh(run: RefreshRun): Promise<void> {
    if (!isActive(run)) return;
    const { ctx, controller } = run;
    const signal = controller.signal;
    try {
      // Check before AND after every command: cancellation can happen between
      // any two awaits, including filesystem operations inside discovery.
      const exec: GitExec = async (args) => {
        signal.throwIfAborted();
        const result = await pi.exec("git", args, { timeout: 1_500, signal });
        signal.throwIfAborted();
        return result;
      };
      const repos = await discoverRepositories(exec, ctx.cwd, signal);
      if (!isActive(run)) return;

      if (repos.length === 0) {
        ctx.ui.setStatus(STATUS_ID, undefined);
        return;
      }

      const theme = ctx.ui.theme;
      const parts = repos.map((repo) => {
        const label = repos.length > 1 || !repo.isCurrentDirectory
          ? `${theme.fg("muted", repo.name)} `
          : "";
        const git = theme.fg("accent", "");
        const fork = theme.fg("dim", "");
        // Branch color represents the worktree; sync state uses separate arrows.
        // Clean + fully synced uses the same explicit #4ADE80 green as the
        // dev-server icon — the theme's "success" renders yellow-green, so the
        // RGB sequence is hardcoded to keep both footer indicators identical.
        const SYNCED_GREEN = "\x1b[38;2;74;222;128m";
        const RESET = "\x1b[39m";
        const synced = !repo.dirty && repo.hasUpstream && repo.ahead === 0 && repo.behind === 0;
        const branch = repo.dirty
          ? theme.fg("error", repo.branch)
          : synced
            ? `${SYNCED_GREEN}${repo.branch}${RESET}`
            : theme.fg("success", repo.branch);
        const state: string[] = [];
        if (repo.dirty) state.push(theme.fg("error", "*"));
        if (!repo.hasUpstream) state.push(theme.fg("warning", "↑"));
        else if (repo.ahead > 0) state.push(theme.fg("warning", `↑${repo.ahead}`));
        if (repo.behind > 0) state.push(theme.fg("warning", `↓${repo.behind}`));
        return `${label}${git} ${fork} ${branch}${state.length ? ` ${state.join(" ")}` : ""}`;
      });

      const separator = theme.fg("dim", "  ·  ");
      ctx.ui.setStatus(
        STATUS_ID,
        `${theme.fg("dim", "→ ")}${parts.join(separator)}`,
      );
    } catch {
      // A background timer must never reject into Pi's uncaught-error handler.
      // Expected cancellation is silent; other failures get a small status.
      if (!isActive(run)) return;
      try { ctx.ui.setStatus(STATUS_ID, "Git status unavailable"); }
      catch { /* The runtime may already have invalidated this UI context. */ }
    }
  }

  function startRefresh(run: RefreshRun): Promise<void> {
    if (!isActive(run)) return Promise.resolve();
    if (run.pending) return run.pending;
    run.pending = refresh(run).then(() => {
      run.pending = undefined;
      // Schedule only after completion, never overlapping scans. Crucially,
      // shutdown during the first scan must not create a new timer afterward.
      if (isActive(run)) {
        run.timer = setTimeout(() => {
          run.timer = undefined;
          void startRefresh(run);
        }, REFRESH_MS);
      }
    });
    return run.pending;
  }

  pi.on("session_start", async (_event, ctx) => {
    stop();
    if (!ctx.hasUI) return;
    const run: RefreshRun = { ctx, controller: new AbortController() };
    active = run;
    await startRefresh(run);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    const previous = stop();
    // Use the shutdown event's live context, not one saved by a command/timer.
    try { if (ctx.hasUI) ctx.ui.setStatus(STATUS_ID, undefined); }
    catch { /* Best effort during teardown; cleanup must still complete. */ }
    await previous?.pending;
  });
}

async function discoverRepositories(
  exec: GitExec,
  cwd: string,
  signal: AbortSignal,
): Promise<RepoBranch[]> {
  signal.throwIfAborted();
  const resolvedCwd = await realpath(cwd).catch(() => resolve(cwd));
  signal.throwIfAborted();
  const candidates = [resolvedCwd];

  const entries = await readdir(resolvedCwd, { withFileTypes: true }).catch(() => []);
  signal.throwIfAborted();
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    candidates.push(resolve(resolvedCwd, entry.name));
  }

  const repos: RepoBranch[] = [];
  for (const candidate of candidates) {
    const rootResult = await exec(["-C", candidate, "rev-parse", "--show-toplevel"]);
    if (rootResult.code !== 0) continue;

    const reportedRoot = rootResult.stdout.trim();
    const resolvedRoot = await realpath(reportedRoot).catch(() => resolve(reportedRoot));
    if (resolvedRoot !== candidate) continue;

    const branchResult = await exec(["-C", candidate, "symbolic-ref", "--quiet", "--short", "HEAD"]);
    const branch = branchResult.code === 0
      ? branchResult.stdout.trim()
      : await shortCommit(exec, candidate);
    if (!branch) continue;

    const status = await repositoryStatus(exec, candidate);
    repos.push({
      name: candidate === resolvedCwd ? candidate.split("/").pop() || candidate : candidate.split("/").pop() || candidate,
      branch,
      isCurrentDirectory: candidate === resolvedCwd,
      ...status,
    });
  }

  return repos.sort((a, b) => {
    if (a.isCurrentDirectory !== b.isCurrentDirectory) return a.isCurrentDirectory ? -1 : 1;
    const aDefault = a.branch === "main" || a.branch === "master";
    const bDefault = b.branch === "main" || b.branch === "master";
    if (aDefault !== bDefault) return aDefault ? 1 : -1;
    return a.name.localeCompare(b.name);
  });
}

async function repositoryStatus(exec: GitExec, repo: string): Promise<{
  dirty: boolean;
  ahead: number;
  behind: number;
  hasUpstream: boolean;
}> {
  const result = await exec(["-C", repo, "status", "--porcelain=v2", "--branch", "--untracked-files=normal"]);
  if (result.code !== 0) {
    return { dirty: false, ahead: 0, behind: 0, hasUpstream: false };
  }

  const lines = result.stdout.split("\n").filter(Boolean);
  const hasUpstream = lines.some((line) => line.startsWith("# branch.upstream "));
  const ab = lines.find((line) => line.startsWith("# branch.ab "))?.match(/\+(\d+) -(\d+)/);
  return {
    dirty: lines.some((line) => !line.startsWith("# ")),
    ahead: ab ? Number(ab[1]) : 0,
    behind: ab ? Number(ab[2]) : 0,
    hasUpstream,
  };
}

async function shortCommit(exec: GitExec, repo: string): Promise<string> {
  const result = await exec(["-C", repo, "rev-parse", "--short", "HEAD"]);
  return result.code === 0 ? `detached@${result.stdout.trim()}` : "";
}
