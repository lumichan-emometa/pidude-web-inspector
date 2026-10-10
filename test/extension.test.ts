import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import extension, { previewFailure, type BrowserFactory, type BrowserHandle } from "../src/index.ts";
import type { BrowserCallbacks } from "../src/browser.ts";
import { REFERENCE_ENTRY, CLEAR_ENTRY } from "../src/core.ts";

function host(makeBrowser?: BrowserFactory) {
  const handlers = new Map<string, (...args: any[]) => any>();
  const commands = new Map<string, any>();
  const entries: any[] = [];
  const notices: string[] = [];
  const statuses: (string | undefined)[] = [];
  let draft = "";
  const pi = {
    on: (name: string, handler: any) => { handlers.set(name, handler); },
    registerCommand: (name: string, definition: any) => commands.set(name, definition),
    appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
  };
  const ctx = {
    mode: "tui", hasUI: true, isIdle: () => true,
    sessionManager: { getEntries: () => entries, getBranch: () => entries },
    ui: {
      notify: (text: string) => notices.push(text),
      setStatus: (_key: string, text: string | undefined) => statuses.push(text),
      setEditorText: (text: string) => { draft = text; },
      pasteToEditor: (text: string) => { draft += text; },
    },
  };
  extension(pi as unknown as ExtensionAPI, makeBrowser);
  const emit = (name: string, event = {}) => handlers.get(name)?.(event, ctx as unknown as ExtensionContext);
  return { emit, commands, entries, notices, statuses, draft: () => draft, ctx };
}

test("host restores refs and enriches model copies without changing user history", async () => {
  const h = host();
  h.entries.push({ type: "custom", customType: REFERENCE_ENTRY, data: { version: 1, reference: { tag: "@element_1", selector: "#hero", element: "h1", text: "Hello", pagePath: "/" } } });
  await h.emit("session_start");
  assert.equal(h.emit("input", { text: "Edit @element_1", source: "interactive" }).action, "continue");
  const messages = [{ role: "user", content: "Edit @element_1" }];
  const result = h.emit("context", { messages });
  assert.match(result.messages[0].content, /Hello/);
  assert.equal(messages[0].content, "Edit @element_1");
  assert.equal(h.entries.length, 1);
  await h.commands.get("preview").handler("clear", h.ctx);
  assert.equal(h.entries.at(-1)?.customType, CLEAR_ENTRY);
  const rejected = h.emit("input", { text: "Edit @element_1", source: "interactive" });
  assert.equal(rejected.action, "handled");
  assert.equal(h.draft(), "Edit @element_1");
  assert.match(h.notices.at(-1)!, /Unknown preview/);
  await h.emit("session_shutdown");
});

test('help aliases explain usage without launching a browser or changing references', async () => {
  const h = host(() => { throw new Error('Help must not create a browser'); });
  await h.emit('session_start');
  const statusesBefore = [...h.statuses];
  for (const arg of ['', 'help', ' help ', '--help', '-h']) {
    await h.commands.get('preview').handler(arg, h.ctx);
    const guide = h.notices.at(-1)!;
    for (const text of ['/preview help', '/preview status', '/preview close', '/preview clear', 'dev server', 'Insert into Pi', 'Make @element_1 smaller', 'minimizes', 'does not erase history']) {
      assert.ok(guide.includes(text), `Missing help content: ${text}`);
    }
  }
  assert.deepEqual(h.statuses, statusesBefore);
  assert.equal(h.entries.length, 0);
  assert.equal(h.draft(), '');
});

test("TUI command refuses remote URLs before browser launch", async () => {
  const h = host();
  await h.emit("session_start");
  await h.commands.get("preview").handler("https://example.com", h.ctx);
  assert.match(h.notices.at(-1)!, /loopback/);
  await h.commands.get("preview").handler("", h.ctx);
  assert.match(h.notices.at(-1)!, /\/preview close/);
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

class FakeBrowser implements BrowserHandle {
  alive = false;
  closes = 0;
  opening = deferred();
  cleanup?: ReturnType<typeof deferred>;
  failure?: Error;
  constructor(readonly callbacks: BrowserCallbacks) {}
  async open() {
    await this.opening.promise;
    if (this.failure) throw this.failure;
  }
  ready() { this.alive = true; this.opening.resolve(); }
  disconnect() { this.alive = false; this.callbacks.disconnected(); }
  isConnected() { return this.alive; }
  async close() {
    this.closes++;
    this.disconnect();
    this.opening.resolve();
    await this.cleanup?.promise;
  }
}

async function nextTick() { await new Promise((resolve) => setImmediate(resolve)); }

function lifecycleHost() {
  const browsers: FakeBrowser[] = [];
  const h = host((callbacks) => {
    const browser = new FakeBrowser(callbacks);
    browsers.push(browser);
    return browser;
  });
  const command = (args: string) => h.commands.get('preview').handler(args, h.ctx);
  return { ...h, browsers, command };
}

test('footer distinguishes browser lifecycle from saved references; stale callbacks cannot close a replacement', async () => {
  const h = lifecycleHost();
  await h.emit('session_start');
  const firstOpen = h.command('http://localhost:3010');
  await nextTick();
  assert.match(h.statuses.at(-1)!, /opening.*3010.*0 saved refs/);
  const first = h.browsers[0];
  first.ready();
  await firstOpen;
  const tag = first.callbacks.register({ selector: '#hero', element: 'h1', pagePath: '/' });
  assert.equal(tag, '@element_1');
  assert.match(h.statuses.at(-1)!, /connected.*1 saved refs/);
  first.disconnect();
  assert.equal(h.statuses.at(-1), 'Preview closed · 1 saved refs');
  assert.equal(first.callbacks.canInsert(), false);
  assert.throws(() => first.callbacks.register({ selector: '#bad', element: 'div', pagePath: '/' }));
  const secondOpen = h.command('http://localhost:3020');
  await nextTick();
  const second = h.browsers[1];
  second.ready();
  await secondOpen;
  first.callbacks.disconnected(); // Delayed notification from a prior browser.
  assert.match(h.statuses.at(-1)!, /connected.*3020.*1 saved refs/);
  await h.command('status');
  assert.match(h.notices.at(-1)!, /not browser windows/);
  await h.command('close');
  await h.command('close');
  assert.equal(h.statuses.at(-1), 'Preview closed · 1 saved refs');
  assert.equal(second.closes, 1);
  await h.command('clear');
  assert.equal(h.statuses.at(-1), 'Preview closed · 0 saved refs');
  await h.emit('session_shutdown');
  assert.equal(h.statuses.at(-1), undefined);
});

test('concurrent opens wait for cleanup and only the newest request launches', async () => {
  const h = lifecycleHost();
  await h.emit('session_start');
  const opening = h.command('http://localhost:3010');
  await nextTick();
  const first = h.browsers[0];
  first.ready();
  await opening;
  first.cleanup = deferred();
  const secondOpen = h.command('http://localhost:3020');
  const thirdOpen = h.command('http://localhost:3030');
  await nextTick();
  assert.equal(h.browsers.length, 1);
  first.cleanup.resolve();
  await nextTick();
  assert.equal(h.browsers.length, 2);
  h.browsers[1].ready();
  await Promise.all([secondOpen, thirdOpen]);
  assert.match(h.statuses.at(-1)!, /connected.*3030/);
  await h.emit('session_shutdown');
});

test('close or shutdown during launch cannot revive connected status', async () => {
  for (const shutdown of [false, true]) {
    const h = lifecycleHost();
    await h.emit('session_start');
    const opening = h.command('http://localhost:3010');
    await nextTick();
    await (shutdown ? h.emit('session_shutdown') : h.command('close'));
    await opening;
    assert.equal(h.statuses.at(-1), shutdown ? undefined : 'Preview closed · 0 saved refs');
    assert.equal(h.browsers[0].callbacks.canInsert(), false);
    assert.ok(!h.statuses.some((status) => status?.includes('connected')));
  }
});

test('status reconciles a missed close notification and failed launch stays closed', async () => {
  const h = lifecycleHost();
  await h.emit('session_start');
  const opening = h.command('http://localhost:3010');
  await nextTick();
  h.browsers[0].ready();
  await opening;
  h.browsers[0].alive = false; // No disconnected event.
  await h.command('status');
  assert.equal(h.statuses.at(-1), 'Preview closed · 0 saved refs');
  const failed = h.command('http://localhost:3020');
  await nextTick();
  h.browsers[1].failure = new Error('net::ERR_CONNECTION_REFUSED');
  h.browsers[1].opening.resolve();
  await failed;
  assert.equal(h.statuses.at(-1), 'Preview closed · 0 saved refs');
  assert.match(h.notices.at(-1)!, /dev server/);
  await h.emit('session_shutdown');
});

test('navigation failures give relevant hints without leaking URL queries', () => {
  assert.doesNotMatch(previewFailure(new Error('net::ERR_CONNECTION_REFUSED')), /Chromium/);
  assert.match(previewFailure(new Error("Executable doesn't exist at /tmp/chrome")), /playwright install chromium/);
  assert.doesNotMatch(previewFailure(new Error('Timeout navigating to http://localhost:3010/?token=secret')), /secret/);
});
