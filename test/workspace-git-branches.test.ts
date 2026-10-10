import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import gitBranches from '../optional/workspace-git-branches.ts';

type Result = { code: number; stdout: string; stderr: string; killed: boolean };
const ok = (stdout = ''): Result => ({ code: 0, stdout, stderr: '', killed: false });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
async function until(condition: () => boolean) {
  for (let i = 0; i < 2000; i++) {
    if (condition()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail('Timed out waiting for asynchronous scan');
}

async function host(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'pi-git-lifecycle-'));
  const cwd = await realpath(dir);
  const handlers = new Map<string, (...args: any[]) => any>();
  const statuses: (string | undefined)[] = [];
  const calls: { args: string[]; signal: AbortSignal }[] = [];
  let stale = false, staleExecs = 0, staleUI = 0;
  let behavior: (args: string[], signal: AbortSignal, index: number) => Promise<Result> = async (args) => standard(args);
  const standard = (args: string[]): Result => {
    if (args.includes('--show-toplevel')) return ok(cwd);
    if (args.includes('symbolic-ref')) return ok('main');
    if (args.includes('--short')) return ok('abc1234');
    return ok('# branch.upstream origin/main\n# branch.ab +0 -0\n');
  };
  const pi = {
    on: (name: string, handler: any) => handlers.set(name, handler),
    exec: async (command: string, args: string[], options: { signal: AbortSignal; timeout: number }) => {
      if (stale) { staleExecs++; throw new Error('This extension ctx is stale after session replacement or reload.'); }
      assert.equal(command, 'git');
      assert.equal(options.timeout, 1500);
      assert.ok(options.signal instanceof AbortSignal);
      calls.push({ args, signal: options.signal });
      return behavior(args, options.signal, calls.length - 1);
    },
  };
  const ctx = {
    cwd, hasUI: true,
    ui: {
      theme: { fg: (_color: string, text: string) => text },
      setStatus: (_key: string, text: string | undefined) => {
        if (stale) { staleUI++; throw new Error('stale UI context'); }
        statuses.push(text);
      },
    },
  };
  gitBranches(pi as unknown as ExtensionAPI);
  const emit = (name: string) => handlers.get(name)?.({}, ctx as unknown as ExtensionContext);
  t.after(async () => { stale = false; await emit('session_shutdown'); await rm(dir, { recursive: true, force: true }); });
  return {
    calls, statuses, emit, standard,
    setBehavior: (fn: typeof behavior) => { behavior = fn; },
    setStale: (value: boolean) => { stale = value; },
    staleCounts: () => ({ exec: staleExecs, ui: staleUI }),
  };
}

test('Git footer cancels at each command boundary without stale API calls or a replacement timer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const boundary of [0, 1, 2]) {
    const h = await host(t);
    const gate = deferred<Result>();
    h.setBehavior(async (args, _signal, index) => index === boundary ? gate.promise : h.standard(args));
    const starting = h.emit('session_start');
    await until(() => h.calls.length === boundary + 1);
    const shuttingDown = h.emit('session_shutdown');
    assert.equal(h.calls[boundary].signal.aborted, true);
    h.setStale(true); // Mimic Pi invalidating the old runtime while work resolves.
    gate.resolve(h.standard(h.calls[boundary].args)); // Deliberately ignore the abort in the mock.
    await Promise.all([starting, shuttingDown]);
    assert.deepEqual(h.staleCounts(), { exec: 0, ui: 0 });
    assert.equal(h.statuses.at(-1), undefined);
    t.mock.timers.tick(20_000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.calls.length, boundary + 1);
    h.setStale(false);
  }
});

test('Git footer cancels a timer-triggered refresh and does not overlap scans', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = await host(t);
  await h.emit('session_start');
  assert.match(h.statuses.at(-1)!, /main/);
  assert.equal(h.calls.length, 3);
  const gate = deferred<Result>();
  h.setBehavior(async () => gate.promise);
  t.mock.timers.tick(2000);
  await until(() => h.calls.length === 4);
  t.mock.timers.tick(20_000);
  assert.equal(h.calls.length, 4);
  const shutdown = h.emit('session_shutdown');
  assert.equal(h.calls[3].signal.aborted, true);
  gate.reject(new Error('AbortError'));
  await shutdown;
  t.mock.timers.tick(20_000);
  assert.equal(h.calls.length, 4);
  assert.equal(h.statuses.at(-1), undefined);
});

test('Git footer contains background errors including invalidated UI and can retry', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = await host(t);
  h.setBehavior(async () => { throw new Error('git process failed'); });
  await h.emit('session_start');
  assert.equal(h.statuses.at(-1), 'Git status unavailable');
  h.setBehavior(async (args) => h.standard(args));
  t.mock.timers.tick(2000);
  await until(() => h.statuses.at(-1)?.includes('main') === true);
  h.setStale(true); // Invalidation can precede the shutdown event.
  t.mock.timers.tick(2000);
  await until(() => h.staleCounts().ui > 0);
  // Stale exec and best-effort UI errors are contained, not unhandled rejections.
  await h.emit('session_shutdown');
  const calls = h.calls.length;
  t.mock.timers.tick(20_000);
  assert.equal(h.calls.length, calls);
});

test('old Git scan cannot publish status or schedule timers into a new run', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = await host(t);
  const old = deferred<Result>();
  h.setBehavior(async (args, _signal, index) => index === 0 ? old.promise : h.standard(args));
  const first = h.emit('session_start');
  await until(() => h.calls.length === 1);
  await h.emit('session_start');
  assert.equal(h.calls[0].signal.aborted, true);
  const count = h.statuses.length;
  old.resolve(ok('obsolete-repo'));
  await first;
  assert.equal(h.statuses.length, count);
  assert.match(h.statuses.at(-1)!, /main/);
  assert.equal(h.calls.length, 4);
  await h.emit('session_shutdown');
  t.mock.timers.tick(20_000);
  assert.equal(h.calls.length, 4);
});

test('shutdown immediately after startup prevents all Git calls after filesystem discovery', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = await host(t);
  const starting = h.emit('session_start');
  const shutdown = h.emit('session_shutdown');
  h.setStale(true);
  await Promise.all([starting, shutdown]);
  assert.equal(h.calls.length, 0);
  assert.deepEqual(h.staleCounts(), { exec: 0, ui: 0 });
  t.mock.timers.tick(20_000);
  assert.equal(h.calls.length, 0);
});
