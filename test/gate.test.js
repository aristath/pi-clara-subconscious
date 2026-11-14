import test from 'node:test';
import assert from 'node:assert/strict';
import { Gate } from '../src/gate.js';
import { deferred } from './helpers.js';

test('foreground waits only for the current private step and blocks further steps', async () => {
  const gate = new Gate();
  const release = await gate.privateStep('model', 'private-model');
  const foreground = gate.foreground('user', { pid: 123, file: 'synthetic', sessionId: 's' });
  let entered = false;
  const next = gate.privateStep('tool', 'pending-tool').then(release => { entered = true; return release; });
  assert.equal(gate.busy(), true);
  release(); await foreground;
  await Promise.resolve();
  assert.equal(entered, false);
  gate.update('user', { pid: 123, busy: false });
  const releaseNext = await next;
  assert.equal(entered, true); releaseNext();
});

test('multiple foreground sessions must all be idle before private work resumes', async () => {
  const gate = new Gate();
  await gate.foreground('one', { pid: 123 }); await gate.foreground('two', { pid: 124 });
  let entered = false;
  const next = gate.privateStep('model', 'private').then(release => { entered = true; return release; });
  gate.remove('one'); await Promise.resolve(); assert.equal(entered, false);
  gate.remove('two'); (await next)();
  assert.equal(entered, true);
});

test('pause lets an active step settle and retains waiting work until resumed', async () => {
  let paused = false;
  const gate = new Gate(() => paused);
  const release = await gate.privateStep('tool', 'active');
  paused = true;
  let resumed = false;
  const next = gate.privateStep('model', 'waiting').then(release => { resumed = true; return release; });
  release(); await Promise.resolve(); assert.equal(resumed, false);
  paused = false; gate.wake(); (await next)(); assert.equal(resumed, true);
});

test('stale live hosts keep their busy claim; dead hosts are removed', async () => {
  const gate = new Gate(() => false, pid => pid === 1);
  gate.update('live', { pid: 1, busy: true }); gate.update('dead', { pid: 2, busy: true });
  for (const client of gate.clients.values()) client.seen = 0;
  gate.sweep(1);
  assert.equal(gate.clients.has('live'), true); assert.equal(gate.clients.has('dead'), false);
  assert.equal(gate.busy(), true);
  gate.remove('live'); assert.equal(gate.busy(), false);
});

test('private work is serialized and shutdown wakes waiting boundaries', async () => {
  const gate = new Gate();
  const release = await gate.privateStep('model', 'first');
  const entered = deferred();
  const second = gate.privateStep('tool', 'second').then(release => { entered.resolve(); return release; });
  release(); const releaseSecond = await second; await entered.promise;
  assert.equal(gate.active.id, 'second');
  const rejected = assert.rejects(gate.privateStep('model', 'third'), /stopping/);
  gate.stop(); releaseSecond(); await rejected;
});
