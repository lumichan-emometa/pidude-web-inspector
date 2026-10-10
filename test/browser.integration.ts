import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir } from "node:fs/promises";
import { PreviewBrowser } from "../src/browser.ts";
import type { Candidate } from "../src/core.ts";

const html = `<!doctype html><html><head><title>Picker fixture</title><style>
body{font:16px system-ui;padding:40px;color:#20334d;background:#edf3fa}button{padding:14px 20px}section{margin:20px 0;padding:20px;background:white;width:500px}svg{width:20px;height:20px}textarea{display:block}
</style></head><body>
<h1>Preview selection test</h1>
<section id="hero"><h2>Build something useful.</h2><button id="start" aria-label="Start free trial"><span>Start free</span><svg viewBox="0 0 20 20"><path d="M2 2h16v16H2z"/></svg></button><a id="nav" href="/next?token=do-not-capture">Next page</a></section>
<section id="private"><p>Public copy</p><input value="INPUT_SECRET"><textarea>TEXTAREA_SECRET</textarea><select><option>SELECT_SECRET</option></select><div contenteditable>EDITABLE_SECRET</div><span hidden>HIDDEN_SECRET</span><span style="display:none">CSS_SECRET</span><script type="application/json">SCRIPT_SECRET</script></section>
<div id="duplicate">One</div><div id="duplicate">Two</div>
<iframe src="/frame" title="Embedded frame"></iframe>
<script>window.counts={down:0,click:0};document.getElementById('start').addEventListener('pointerdown',()=>window.counts.down++);document.getElementById('start').addEventListener('click',()=>window.counts.click++);</script>
</body></html>`;

async function fixture() {
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end(req.url === "/frame" ? "<button>Frame button</button>" : html);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No port");
  return { url: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

const waitFor = async (condition: () => boolean) => {
  for (let i = 0; i < 100; i++) { if (condition()) return; await new Promise((r) => setTimeout(r, 20)); }
  assert.fail("Timed out waiting for callback");
};

test("real browser selection, native behavior, privacy, parent, copy, navigation and cleanup", async () => {
  const app = await fixture();
  const registered: Candidate[] = [], inserted: string[] = [];
  let disconnected = false, canInsert = true;
  const browser = new PreviewBrowser({
    register: (candidate) => { registered.push(candidate); return `@element_${registered.length}`; },
    insert: (tag) => { inserted.push(tag); }, canInsert: () => canInsert,
    disconnected: () => { disconnected = true; },
  });
  try {
    const page = await browser.open(app.url, { headless: true });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewportSize({ width: 1100, height: 900 });
    const picker = page.locator("pidude-web-inspector");
    await picker.getByRole("button", { name: "Select", exact: true }).waitFor();
    await page.locator("#start span").click();
    assert.deepEqual(await page.evaluate(() => (window as any).counts), { down: 1, click: 1 });
    await picker.getByRole("button", { name: "Select", exact: true }).click();
    await page.locator("#start path").click();
    assert.deepEqual(await page.evaluate(() => (window as any).counts), { down: 1, click: 1 });
    assert.match(await picker.locator("h2").innerText(), /^button · Start free trial/);
    assert.equal(await picker.locator("code").innerText(), "#start");
    await picker.getByRole("button", { name: "Insert into Pi" }).click();
    await waitFor(() => inserted.length === 1);
    assert.equal(inserted[0], "@element_1");
    assert.equal(registered[0].text, "Start free");
    // Copy retries and insert reuse the same immutable snapshot/tag.
    await picker.getByRole("button", { name: "Copy reference" }).click();
    await page.waitForFunction(() => /Copied|Clipboard unavailable/.test(document.querySelector('pidude-web-inspector')!.shadowRoot!.querySelector('[role=status]')!.textContent!));
    assert.equal(registered.length, 1);
    await picker.getByRole("button", { name: "Insert into Pi" }).click();
    await waitFor(() => inserted.length === 2);
    assert.equal(inserted[1], "@element_1");
    canInsert = false;
    await picker.getByRole("button", { name: "Insert into Pi" }).click();
    await page.waitForFunction(() => document.querySelector('pidude-web-inspector')!.shadowRoot!.querySelector('[role=status]')!.textContent!.includes('Close the Pi dialog'));
    assert.equal(inserted.length, 2);
    canInsert = true;
    await page.locator("#private p").click();
    await picker.getByRole("button", { name: "Parent", exact: true }).click();
    await picker.getByRole("button", { name: "Insert into Pi" }).click();
    await waitFor(() => registered.length === 2);
    assert.equal(registered[1].selector, "#private");
    assert.equal(registered[1].text, "Public copy");
    assert.ok(!JSON.stringify(registered).includes("SECRET"));
    await page.locator("#nav").click();
    assert.equal(new URL(page.url()).pathname, "/");
    // Frame shields select the containing iframe, rather than activating its controls.
    const frameRect = await page.locator('iframe').boundingBox();
    assert.ok(frameRect);
    await page.mouse.click(frameRect.x + 30, frameRect.y + 20);
    assert.match(await picker.locator('h2').innerText(), /^iframe/);
    assert.equal(await page.locator('iframe').getAttribute('inert'), '');
    // Escape restores ordinary interaction and removes ephemeral inert state.
    await page.keyboard.press("Escape");
    assert.equal(await page.locator('iframe').getAttribute('inert'), null);
    assert.equal(await picker.getByRole("button", { name: "Interact" }).getAttribute("aria-pressed"), "true");
    await page.locator("#nav").click();
    await page.waitForURL("**/next?token=do-not-capture");
    await picker.getByRole("button", { name: "Select", exact: true }).click();
    await page.locator("#start").focus();
    await page.keyboard.press("Enter");
    assert.deepEqual(await page.evaluate(() => (window as any).counts), { down: 0, click: 0 });
    await picker.getByRole("button", { name: "Insert into Pi" }).click();
    await waitFor(() => registered.length === 3);
    assert.equal(registered[2].pagePath, "/next");
    assert.ok(!JSON.stringify(registered).includes("do-not-capture"));
    // Duplicate IDs are not incorrectly considered unique.
    await page.locator('[id="duplicate"]').nth(1).click();
    assert.notEqual(await picker.locator("code").innerText(), "#duplicate");
    const selector = await picker.locator("code").innerText();
    assert.equal(await page.locator(selector).count(), 1);
    await mkdir("artifacts", { recursive: true });
    await page.screenshot({ path: "artifacts/picker.png" });
    // No picker in frames; binding rejects even an explicit forged frame call.
    const binding = await page.evaluate(() => Object.getOwnPropertyNames(window).find((key) => key.startsWith("__piPreview_"))!);
    const frame = page.frames().find((f) => f !== page.mainFrame())!;
    assert.equal(await frame.locator("pidude-web-inspector").count(), 0);
    const rejected = await frame.evaluate(async (binding) => (window as any)[binding]({}), binding);
    assert.equal(rejected.ok, false);
    assert.match(rejected.error, /not paired/);
    // Off-origin navigation has no picker and cannot use the preserved binding.
    const other = await fixture();
    try {
      await page.goto(other.url);
      assert.equal(await page.locator("pidude-web-inspector").count(), 0);
      const rejected = await page.evaluate(async (binding) => (window as any)[binding]({}), binding);
      assert.equal(rejected.ok, false);
      assert.match(rejected.error, /origin/);
    } finally { await other.close(); }
    assert.deepEqual(errors, []);
    await browser.close();
    assert.equal(page.isClosed(), true);
    assert.equal(disconnected, true);
  } finally { await browser.close(); await app.close(); }
});

test("manual page closure, browser quit and renderer crash notify once and allow a fresh preview", { timeout: 15000 }, async () => {
  const app = await fixture();
  try {
    for (const exit of ['page', 'browser', 'crash'] as const) {
      let notifications = 0;
      const browser = new PreviewBrowser({ register: () => '@element_1', insert: () => {}, canInsert: () => true, disconnected: () => { notifications++; } });
      try {
        const page = await browser.open(app.url, { headless: true });
        assert.equal(browser.isConnected(), true);
        if (exit === 'page') await page.close();
        else if (exit === 'browser') await page.context().browser()!.close();
        else {
          const cdp = await page.context().newCDPSession(page);
          await cdp.send('Page.crash').catch(() => {});
        }
        await waitFor(() => notifications === 1);
        assert.equal(browser.isConnected(), false);
        await Promise.all([browser.close(), browser.close()]);
        assert.equal(notifications, 1);
        assert.equal(page.isClosed(), true);
      } finally { await browser.close(); }
    }
  } finally { await app.close(); }
});

test("closing during pending navigation settles launch and closes Chromium", { timeout: 15000 }, async () => {
  let arrived!: () => void;
  const request = new Promise<void>((resolve) => { arrived = resolve; });
  const server = createServer(() => { arrived(); }); // Intentionally never send a response.
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  let notifications = 0;
  const browser = new PreviewBrowser({ register: () => '', insert: () => {}, canInsert: () => true, disconnected: () => { notifications++; } });
  try {
    const opening = browser.open(`http://127.0.0.1:${port}`, { headless: true });
    const rejected = assert.rejects(opening, /closed|cancelled|ERR_ABORTED/i);
    await request;
    await browser.close();
    await rejected;
    assert.equal(browser.isConnected(), false);
    assert.equal(notifications, 1);
  } finally {
    await browser.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("closing during browser startup does not revive the browser", async () => {
  const app = await fixture();
  const browser = new PreviewBrowser({ register: () => "", insert: () => {}, canInsert: () => true, disconnected: () => {} });
  try {
    const opening = browser.open(app.url, { headless: true });
    await browser.close();
    await assert.rejects(opening, /cancelled|closed/i);
  } finally { await browser.close(); await app.close(); }
});

test("minimize preserves mode and selection, restores with keyboard, and uncovers page controls", async () => {
  const app = await fixture();
  const browser = new PreviewBrowser({ register: () => "@element_1", insert: () => {}, canInsert: () => true, disconnected: () => {} });
  try {
    const page = await browser.open(app.url, { headless: true });
    await page.setViewportSize({ width: 1100, height: 900 });
    const picker = page.locator('pidude-web-inspector');
    const dialog = picker.locator('#picker-panel');
    const restore = picker.getByRole('button', { name: /Restore Pi Preview/ });
    await picker.getByRole('button', { name: 'Minimize Pi Preview' }).click();
    assert.equal(await dialog.isVisible(), false);
    assert.equal(await restore.getAttribute('aria-expanded'), 'false');
    assert.equal(await restore.evaluate((el) => el.getRootNode() instanceof ShadowRoot && (el.getRootNode() as ShadowRoot).activeElement === el), true);
    const rect = await restore.boundingBox();
    assert.ok(rect && rect.width < 180 && rect.height < 60);
    // The old dialog footprint is now clickable through the transparent host.
    await page.evaluate(() => {
      const button = document.createElement('button');
      button.id = 'uncovered';
      button.textContent = 'Previously covered';
      button.style.cssText = 'position:fixed;right:30px;bottom:120px';
      button.onclick = () => { button.dataset.clicked = 'yes'; };
      document.body.append(button);
    });
    await page.locator('#uncovered').click();
    assert.equal(await page.locator('#uncovered').getAttribute('data-clicked'), 'yes');
    await restore.focus();
    await page.keyboard.press('Enter');
    assert.equal(await dialog.isVisible(), true);
    await picker.getByRole('button', { name: 'Select', exact: true }).click();
    await page.locator('#start').click();
    await picker.getByRole('button', { name: 'Minimize Pi Preview' }).click();
    assert.equal(await restore.innerText(), 'Pi · Select');
    await restore.click();
    assert.equal(await picker.locator('code').innerText(), '#start');
    assert.equal(await picker.getByRole('button', { name: 'Select', exact: true }).getAttribute('aria-pressed'), 'true');
    await picker.getByRole('button', { name: 'Minimize Pi Preview' }).click();
    await page.locator('#private p').click();
    assert.equal(await dialog.isVisible(), true);
    assert.match(await picker.locator('h2').innerText(), /Public copy/);
    assert.deepEqual(await page.evaluate(() => (window as any).counts), { down: 0, click: 0 });
    await picker.getByRole('button', { name: 'Minimize Pi Preview' }).click();
    await page.keyboard.press('Escape');
    assert.equal(await dialog.isVisible(), false);
    assert.equal(await restore.innerText(), 'Pi · Preview');
    await page.setViewportSize({ width: 375, height: 700 });
    const compact = await restore.boundingBox();
    assert.ok(compact && compact.x >= 0 && compact.x + compact.width <= 375);
    await mkdir('artifacts', { recursive: true });
    await page.screenshot({ path: 'artifacts/picker-minimized.png' });
    await restore.click();
    const expanded = await dialog.boundingBox();
    assert.ok(expanded && expanded.x >= 0 && expanded.x + expanded.width <= 375);
  } finally { await browser.close(); await app.close(); }
});
