import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PreviewBrowser, type BrowserCallbacks } from "./browser.ts";
import { CLEAR_ENTRY, REFERENCE_ENTRY, MAX_REFERENCES, Registry, enrichMessages, references, previewURL, clean } from "./core.ts";

export interface BrowserHandle {
  open(target: string): Promise<unknown>;
  close(): Promise<void>;
  isConnected(): boolean;
}
export type BrowserFactory = (callbacks: BrowserCallbacks) => BrowserHandle;

export function previewFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/ERR_CONNECTION_REFUSED/.test(message)) {
    return "Could not connect to the preview dev server. Start it and use the URL/port it prints, then retry /preview URL.";
  }
  if (/executable doesn't exist|playwright install/i.test(message)) {
    return "Chromium is missing. Run npx playwright install chromium in the extension directory, then retry /preview URL.";
  }
  // Browser errors may contain the full navigation URL (including sensitive query data).
  const safe = clean(message.replace(/https?:\/\/[^\s]+/g, (value) => {
    try { return new URL(value).origin; } catch { return "[preview URL]"; }
  }), 500);
  return `Could not open preview: ${safe}`;
}

export default function previewSelect(pi: ExtensionAPI, makeBrowser: BrowserFactory = (callbacks) => new PreviewBrowser(callbacks)) {
  const registry = new Registry();
  let browser: BrowserHandle | undefined;
  let current: ExtensionContext | undefined;
  let generation = 0;
  let cleanup: Promise<void> = Promise.resolve();
  let dialogOpen = false;
  let state: "idle" | "opening" | "connected" | "closed" = "idle";
  let targetOrigin = "";

  const statusText = () => `Preview ${state === "idle" ? "closed" : state}${state === "opening" || state === "connected" ? ` (${targetOrigin})` : ""} · ${registry.items.size} saved refs`;
  const status = () => {
    if (current?.mode === "tui") current.ui.setStatus("pidude-web-inspector",
      state !== "idle" || registry.items.size ? statusText() : undefined);
  };
  const restore = (ctx: ExtensionContext) => {
    current = ctx;
    registry.restore(ctx.sessionManager.getEntries(), ctx.sessionManager.getBranch());
    status();
  };
  // Invalidate old callbacks immediately, but serialize process cleanup. Every
  // caller gets its own ticket; a newer command cancels an older pending open.
  const stop = (): Promise<number> => {
    const ticket = ++generation;
    state = "closed";
    const previous = browser;
    browser = undefined;
    status();
    cleanup = cleanup.then(() => previous?.close()).then(() => {}, () => {});
    return cleanup.then(() => ticket);
  };

  pi.on("session_start", (_event, ctx) => { dialogOpen = false; restore(ctx); });
  pi.on("session_shutdown", async () => {
    // Clear the footer while this UI still belongs to us, then invalidate it.
    if (current?.mode === "tui") current.ui.setStatus("pidude-web-inspector", undefined);
    current = undefined;
    await stop();
  });
  pi.on("session_tree", async (_event, ctx) => {
    const ticket = await stop();
    if (ticket === generation && current) restore(ctx);
  });
  pi.on("ui_prompt_start", () => { dialogOpen = true; });
  pi.on("ui_prompt_end", () => { dialogOpen = false; });

  pi.registerCommand("preview", {
    description: "Select local preview elements: /preview URL | help | status | close | clear",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        if (ctx.hasUI) ctx.ui.notify("Preview selection currently requires Pi's terminal UI.", "warning");
        return;
      }
      current = ctx;
      const arg = args.trim();
      if (!arg || ["help", "--help", "-h"].includes(arg)) {
        ctx.ui.notify([
          "Pi Preview — select page elements and reference them in your prompt.",
          "",
          "/preview http://localhost:3010 — open your running dev server",
          "/preview help — show this guide",
          "/preview status — show browser connection and saved-reference count",
          "/preview close — close browser, keep saved references",
          "/preview clear — close browser and forget references (history remains on disk)",
          "",
          "1. Start your app's dev server separately (Next.js, Vite, etc.).",
          "2. Open its URL with /preview URL, then click Select in the browser.",
          "3. Click an element; use Parent if you want its container.",
          "4. Click Insert into Pi to insert a tag at the cursor, or Copy reference.",
          "5. Return to Pi and write, for example: Make @element_1 smaller.",
          "",
          "Interact restores normal page behavior. Escape exits Select.",
          "The − button minimizes the panel; click its corner button to restore.",
          "Insertion never submits your prompt. Copied tags work only in this Pi session.",
          "Saved refs are element snapshots, not browser windows; they survive closing.",
          "Only local HTTP(S) URLs are supported. Metadata is saved in Pi's session",
          "and sent to your model when referenced. Clear does not erase history.",
        ].join("\n"), "info");
        return;
      }
      if (arg === "status") {
        // Defensive reconciliation if the host missed a close notification.
        if (state === "connected" && !browser?.isConnected()) await stop();
        if (!current) return;
        status();
        ctx.ui.notify(`${statusText()}\nSaved refs are element snapshots in this Pi session, not browser windows.\n/preview URL — open picker\n/preview close — close browser, keep saved refs\n/preview clear — close browser and forget refs (history remains on disk)`, "info");
        return;
      }
      if (arg === "close" || arg === "clear") {
        const ticket = await stop();
        if (!current || ticket !== generation) return;
        if (arg === "clear") {
          pi.appendEntry(CLEAR_ENTRY, { version: 1 });
          registry.clear();
          status();
        }
        ctx.ui.notify(arg === "clear" ? "References cleared; existing draft tags may now be unavailable. Session files are not erased." : "Preview closed. References are still available. Use /preview clear to forget them.", "info");
        return;
      }
      let url: URL;
      try { url = previewURL(arg); }
      catch { ctx.ui.notify("Use an HTTP(S) loopback URL: localhost, 127.0.0.1 or [::1], without credentials.", "error"); return; }
      const ownGeneration = await stop();
      if (!current || ownGeneration !== generation) return;
      const ownsOperation = () => current !== undefined && generation === ownGeneration;
      const active = () => ownsOperation() && browser === managed && (state === "opening" || state === "connected");
      const managed = makeBrowser({
        canInsert: () => active() && !dialogOpen && current?.mode === "tui",
        register: (candidate) => {
          if (!active()) throw new Error("Pi session changed. Reopen /preview.");
          const ref = registry.add(candidate, (reference) => pi.appendEntry(REFERENCE_ENTRY, { version: 1, reference }));
          status();
          return ref.tag;
        },
        insert: (tag) => {
          if (!active() || dialogOpen || current?.mode !== "tui") throw new Error("Pi editor is unavailable. Use Copy reference.");
          current.ui.pasteToEditor(` ${tag} `);
        },
        disconnected: () => {
          if (!active()) return;
          state = "closed";
          // Retain the handle until stop(): it may still be finishing cleanup.
          status();
        },
      });
      browser = managed;
      targetOrigin = url.origin;
      state = "opening";
      status();
      ctx.ui.notify("Opening preview in dedicated Chromium…", "info");
      try {
        await managed.open(arg);
        if (!active() || !managed.isConnected()) { await managed.close(); return; }
        state = "connected";
        status();
        ctx.ui.notify("Use Select in the browser, then Insert into Pi. Metadata is saved in this Pi session and sent to your model when referenced.", "info");
      } catch (error) {
        if (!ownsOperation()) return;
        state = "closed";
        status();
        ctx.ui.notify(previewFailure(error), "error");
      }
    },
  });

  pi.on("input", (event, ctx) => {
    const tags = references(event.text);
    const missing = tags.filter((tag) => !registry.items.has(tag));
    if (!missing.length && tags.length <= MAX_REFERENCES) return { action: "continue" as const };
    const reason = missing.length
      ? `Unknown preview references: ${missing.slice(0, 12).map((tag) => tag.slice(0, 40)).join(", ")}. Select them in this Pi session or remove the tags.`
      : `Use at most ${MAX_REFERENCES} element references in one prompt.`;
    if (ctx.hasUI) ctx.ui.notify(reason, "warning");
    if (event.source === "interactive" && ctx.mode === "tui" && ctx.isIdle()) ctx.ui.setEditorText(event.text);
    return { action: "handled" as const };
  });

  pi.on("context", (event) => ({ messages: enrichMessages(event.messages, registry) }));
}
