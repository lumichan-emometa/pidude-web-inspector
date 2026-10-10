import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import type { Browser, Page } from "playwright";
import { parseCandidate, previewURL, type Candidate } from "./core.ts";

export interface BrowserCallbacks {
  register(candidate: Candidate): string;
  insert(tag: string): void;
  canInsert(): boolean;
  disconnected(): void;
}

/** One private Playwright browser/page per Pi session; no network bridge listener. */
export class PreviewBrowser {
  private browser?: Browser;
  private page?: Page;
  private closed = false;
  private openTask?: Promise<Page>;
  private closeTask?: Promise<void>;
  private didDisconnect = false;
  private readonly registered = new Map<string, string>();
  private lastRegistration = 0;
  private origin = "";
  private binding = "";

  constructor(private readonly callbacks: BrowserCallbacks) {}

  isConnected(): boolean {
    return !this.closed && !!this.browser?.isConnected() && !!this.page && !this.page.isClosed();
  }

  open(target: string, options: { headless?: boolean } = {}): Promise<Page> {
    if (this.closed || this.openTask) return Promise.reject(new Error("Preview browser is already opened or closed."));
    this.openTask = this.launch(target, options);
    return this.openTask;
  }

  private async launch(target: string, options: { headless?: boolean }): Promise<Page> {
    try {
      const url = previewURL(target);
      this.origin = url.origin;
      this.binding = "__piPreview_" + randomBytes(16).toString("hex");
      const { chromium } = await import("playwright");
      if (this.closed) throw new Error("Preview was cancelled.");
      const browser = await chromium.launch({ headless: options.headless ?? false });
      if (this.closed) { await browser.close(); throw new Error("Preview was cancelled."); }
      this.browser = browser;
      browser.once("disconnected", () => {
        this.markClosed();
        this.browser = undefined;
      });
      const context = await browser.newContext({ viewport: null });
      const page = await context.newPage();
      this.page = page;
      page.once("close", () => { void this.close(); });
      page.once("crash", () => { void this.close(); });
      // Exposed only on this page. Source validation still rejects subframes.
      await page.exposeBinding(this.binding, (source, payload: unknown) => {
        if (this.closed || source.page !== this.page || source.frame !== this.page?.mainFrame()) {
          return { ok: false, error: "This document is not paired with Pi." };
        }
        let current: URL;
        try { current = new URL(source.frame.url()); } catch { return { ok: false, error: "Invalid preview document." }; }
        if (current.origin !== this.origin) return { ok: false, error: "This origin is not paired with Pi. Reopen /preview URL." };
        try {
          if (!payload || typeof payload !== "object" || JSON.stringify(payload).length > 8192) throw new Error("Invalid picker request.");
          const request = payload as Record<string, unknown>;
          if (request.action !== "insert" && request.action !== "copy") throw new Error("Unknown picker action.");
          if (typeof request.documentId !== "string" || !/^[\da-f-]{36}$/.test(request.documentId) ||
            !Number.isSafeInteger(request.selectionId) || (request.selectionId as number) < 1) throw new Error("Invalid selection identity.");
          if (request.action === "insert" && !this.callbacks.canInsert()) throw new Error("Close the Pi dialog before inserting, or use Copy reference.");
          const candidate = parseCandidate(request.candidate, current.pathname);
          const key = `${request.documentId}:${request.selectionId}`;
          let tag = this.registered.get(key);
          if (!tag) {
            if (Date.now() - this.lastRegistration < 100) throw new Error("Please wait a moment before tagging another element.");
            if (this.registered.size >= 999) throw new Error("Reference limit reached. Start a new Pi session.");
            tag = this.callbacks.register(candidate);
            this.registered.set(key, tag);
            this.lastRegistration = Date.now();
          }
          if (request.action === "insert") this.callbacks.insert(tag);
          return { ok: true, tag };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : "Could not register this selection." };
        }
      });
      const source = await readFile(new URL("./picker.js", import.meta.url), "utf8");
      await page.addInitScript({ content: source.replace("__PI_PREVIEW_CONFIG__", JSON.stringify({ origin: this.origin, binding: this.binding })) });
      await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 20_000 });
      if (new URL(page.url()).origin !== this.origin) throw new Error("Preview redirected to another origin. Open its loopback URL explicitly.");
      await page.bringToFront();
      if (!this.isConnected()) throw new Error("Preview was closed before it finished opening.");
      return page;
    } catch (error) {
      this.markClosed();
      // Do not await close(): it waits for this launch task to settle.
      await this.disposeBrowser();
      throw error;
    }
  }

  private markClosed(): void {
    this.closed = true;
    this.page = undefined;
    this.registered.clear();
    if (!this.didDisconnect) {
      this.didDisconnect = true;
      this.callbacks.disconnected();
    }
  }

  private async disposeBrowser(): Promise<void> {
    const browser = this.browser;
    this.browser = undefined;
    if (browser) await browser.close().catch(() => {});
  }

  close(): Promise<void> {
    if (this.closeTask) return this.closeTask;
    this.markClosed(); // Update the host immediately, even during browser startup.
    this.closeTask = (async () => {
      await this.disposeBrowser();
      // If Chromium was still launching, launch() closes it before rejecting.
      // Waiting here prevents a replacement browser racing the old launch.
      await this.openTask?.catch(() => {});
      await this.disposeBrowser();
    })();
    return this.closeTask;
  }
}
