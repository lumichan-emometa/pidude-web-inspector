import { test } from "node:test";
import assert from "node:assert/strict";
import { Registry, parseCandidate, previewURL, references, enrichMessages, contextBlock, REFERENCE_ENTRY, CLEAR_ENTRY } from "../src/core.ts";

const candidate = () => parseCandidate({ selector: "#hero > button", element: "button", text: "Start free" }, "/pricing");
const entry = (reference: unknown) => ({ type: "custom", customType: REFERENCE_ENTRY, data: { version: 1, reference } });

test("metadata is bounded, sanitized, allowlisted and uses trusted pathname", () => {
  const result = parseCandidate({ selector: "#a\x1b[31m", element: "button", text: " x\u202e\n" + "z".repeat(1000), role: "b".repeat(100), ariaLabel: "c".repeat(300), value: "secret", outerHTML: "secret", pagePath: "https://evil" }, "/safe?token=secret#fragment");
  assert.equal(result.text?.length, 240);
  assert.equal(result.role?.length, 80);
  assert.equal(result.ariaLabel?.length, 160);
  assert.equal(result.pagePath, "/safe");
  assert.ok(!JSON.stringify(result).includes("secret"));
  assert.ok(!JSON.stringify(result).includes("\\u001b"));
  for (const raw of [null, [], {}, { selector: "", element: "div" }, { selector: "#a", element: "SCRIPT!" }, { selector: "x".repeat(9000), element: "div" }]) assert.throws(() => parseCandidate(raw, "/"));
  assert.throws(() => parseCandidate(candidate(), "//evil"));
});

test("only explicit loopback HTTP(S) targets without credentials", () => {
  for (const url of ["http://localhost:5173", "https://127.0.0.1:3000/x", "http://[::1]:8080"]) assert.ok(previewURL(url));
  for (const url of ["https://example.com", "http://localhost.evil", "file:///tmp/a", "http://a:b@localhost", "javascript:alert(1)"]) assert.throws(() => previewURL(url));
});

test("aliases match exactly and deduplicate", () => {
  assert.deepEqual(references("@element_1 @element_10 @element_1 @element_1000 @element_01 @element_2x foo@element_3 @@element_4"), ["@element_1", "@element_10", "@element_1000"]);
});

test("registry persistence precedes allocation; restore is branch-aware and aliases never recycle", () => {
  const registry = new Registry();
  assert.throws(() => registry.add(candidate(), () => { throw new Error("disk"); }));
  const a = registry.add(candidate(), () => {});
  assert.equal(a.tag, "@element_1");
  const b = registry.add(candidate(), () => {});
  const all = [entry(a), entry(b)];
  registry.restore(all, [entry(a)]);
  assert.equal(registry.items.size, 1);
  assert.equal(registry.add(candidate(), () => {}).tag, "@element_3");
  registry.restore(all, [...all, { type: "custom", customType: CLEAR_ENTRY }]);
  assert.equal(registry.items.size, 0);
  assert.equal(registry.add(candidate(), () => {}).tag, "@element_3");
  registry.clear();
  assert.equal(registry.add(candidate(), () => {}).tag, "@element_4");
});

test("allocation limit and malformed stored entries", () => {
  const registry = new Registry();
  registry.restore([entry({ ...candidate(), tag: "@element_999" })], []);
  assert.throws(() => registry.add(candidate(), () => {}), /999/);
  registry.restore([entry({ tag: "@element_666" }), entry({ ...candidate(), tag: "bad" })], []);
  assert.equal(registry.add(candidate(), () => {}).tag, "@element_1");
});

test("only referenced metadata reaches request-time copies, including queued messages", () => {
  const registry = new Registry();
  registry.add(candidate(), () => {});
  registry.add({ ...candidate(), text: "not referenced" }, () => {});
  const messages = [{ role: "user", content: "Change @element_1" }, { role: "assistant", content: "@element_2" }, { role: "user", content: [{ type: "text", text: "And @element_1" }, { type: "image", data: "abc" }] }];
  const before = structuredClone(messages);
  const enriched = enrichMessages(messages, registry);
  assert.deepEqual(messages, before);
  assert.match(enriched[0].content as string, /Start free/);
  assert.ok(!JSON.stringify(enriched).includes("not referenced"));
  assert.equal((enriched[2].content as unknown[]).length, 3);
  assert.equal((enriched[2].content as { type: string }[])[1].type, "image");
});

test("context block budgets and missing/omitted reference reporting", () => {
  const registry = new Registry();
  for (let i = 0; i < 14; i++) registry.add({ ...candidate(), text: "t".repeat(240), selector: "s".repeat(500) }, () => {});
  const text = Array.from({ length: 14 }, (_, i) => `@element_${i + 1}`).join(" ");
  const block = contextBlock(text, registry, 1500);
  assert.ok(block.length <= 1500);
  assert.match(block, /"omitted":/);
  assert.match(contextBlock("@element_999", registry, 1000), /"unavailable":\["@element_999"\]/);
  assert.equal(contextBlock(text, registry, 10), "");
  const messages = Array.from({ length: 30 }, () => ({ role: "user", content: text }));
  const enriched = enrichMessages(messages, registry, 16000);
  const added = enriched.reduce((n, m, i) => n + m.content.length - messages[i].content.length, 0);
  assert.ok(added <= 16000);
  assert.notEqual(enriched.at(-1)?.content, text);
});
