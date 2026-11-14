import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { Coordinator, startService } from '../src/service.js';
import { Client } from '../src/client.js';
import { Store } from '../src/store.js';
import { originContext } from '../src/sessions.js';
import { RETURN_TYPE } from '../src/private-extension.js';
import { fixture, deferred, call, assistantMessage, syntheticModel } from './helpers.js';

function source(config, id = 'source-call') {
  const manager = SessionManager.create(config.workspace, join(config.agentDir, 'sessions', 'synthetic'));
  manager.appendMessage({ role: 'user', content: [{ type: 'text', text: 'Synthetic question.' }], timestamp: Date.now() });
  manager.appendMessage({ ...assistantMessage(''), content: [call('subconscious_reflect', { content: 'Explore a fictional question.' }, id)], stopReason: 'toolUse' });
  return { manager, source: originContext(manager, id) };
}

test('scheduler respects independent rests and pause, serializes work and retains general conversation', async t => {
  const { config } = fixture(t);
  const entered = deferred(), finish = deferred();
  let count = 0;
  const coordinator = new Coordinator(config, { sessions: {
    async step(row) { count++; entered.resolve(); await finish.promise; coordinator.store.rest(row.id, 0, 'synthetic-rest'); return { hasTools: true }; },
    async close() {},
  } });
  const run = coordinator.tick(); await entered.promise;
  assert.equal(await coordinator.tick(), false);
  await coordinator.call('pause', { paused: true });
  finish.resolve(); await run;
  assert.equal(count, 1);
  assert.equal(coordinator.store.row('general').nextWake, coordinator.store.row('general').lastStep);
  assert.equal(await coordinator.tick(), false);
  assert.equal(new Store(config).state.paused, true);
  await coordinator.call('pause', { paused: false });
  await coordinator.tick(); assert.equal(count, 2);
  await coordinator.stop();
});

test('one failed conversation does not block a healthy topic', async t => {
  const { config } = fixture(t, { errorRetryMs: 60000 });
  const seen = [];
  const coordinator = new Coordinator(config, { sessions: {
    async step(row) { seen.push(row.id); if (row.id === 'general') throw new Error('Synthetic integration unavailable'); return { hasTools: false }; }, async close() {},
  } });
  const topic = coordinator.store.topic({ action: 'create', title: 'Healthy topic', content: 'Fictional subject' }, 'user', 'topic');
  await coordinator.tick(); await coordinator.tick();
  assert.deepEqual(seen, ['general', topic.id]);
  assert.match(coordinator.store.row('general').error, /unavailable/);
  await coordinator.stop();
});

test('reflection source comes from persisted invocation and return waits for the exact source to consume it', async t => {
  const { config } = fixture(t);
  const coordinator = new Coordinator(config, { sessions: { async close() {} } });
  const { manager } = source(config);
  await coordinator.call('foreground.update', { id: 'source-client', pid: process.pid, busy: false, file: manager.getSessionFile(), sessionId: manager.getSessionId() });
  const accepted = await coordinator.call('reflection.create', { clientId: 'source-client', callId: 'source-call', content: 'Ignored untrusted replacement' });
  assert.equal(coordinator.store.row(accepted.id).content, 'Explore a fictional question.');
  assert.equal((await coordinator.call('reflection.create', { clientId: 'source-client', callId: 'source-call' })).id, accepted.id);
  coordinator.store.finish(accepted.id, 'Selected fictional insight.', 'return');
  const before = readFileSync(manager.getSessionFile(), 'utf8');
  assert.deepEqual(await coordinator.call('deliveries', { clientId: 'source-client' }), [{ id: accepted.id, content: 'Selected fictional insight.' }]);
  assert.equal(readFileSync(manager.getSessionFile(), 'utf8'), before, 'Service must not append to the foreground file');
  const other = source(config, 'other-call').manager;
  await coordinator.call('foreground.update', { id: 'other-client', pid: process.pid, busy: false, file: other.getSessionFile(), sessionId: other.getSessionId() });
  assert.deepEqual(await coordinator.call('deliveries', { clientId: 'other-client' }), []);
  manager.appendCustomMessageEntry(RETURN_TYPE, 'Selected fictional insight.', false, { deliveryIds: [accepted.id] });
  assert.deepEqual(await coordinator.call('deliveries', { clientId: 'source-client' }), []);
  assert.equal(coordinator.store.state.deliveries[accepted.id].status, 'delivered');
  assert.equal(manager.getBranch().at(-1).type, 'custom_message');
  assert.equal(manager.getBranch().at(-1).display, false);
  const reloaded = new Coordinator(config, { sessions: { async close() {} } });
  assert.equal(reloaded.store.state.deliveries[accepted.id].status, 'delivered');
  await coordinator.stop(); await reloaded.stop();
});

test('a changed branch cannot consume a reflection for a removed originating invocation', async t => {
  const { config } = fixture(t);
  const coordinator = new Coordinator(config, { sessions: { async close() {} } });
  const { manager, source: origin } = source(config);
  const thought = coordinator.store.reflect('Fictional thought', origin, 'reflect');
  coordinator.store.finish(thought.id, 'Fictional return', 'return');
  manager.branch(manager.getBranch().find(entry => entry.type === 'message' && entry.message.role === 'user').id);
  manager.appendMessage({ role: 'user', content: [{ type: 'text', text: 'A different synthetic branch.' }], timestamp: Date.now() });
  await coordinator.call('foreground.update', { id: 'client', pid: process.pid, file: manager.getSessionFile(), sessionId: manager.getSessionId(), busy: false });
  assert.deepEqual(await coordinator.call('deliveries', { clientId: 'client' }), []);
  assert.equal(coordinator.store.state.deliveries[thought.id].status, 'pending');
  await coordinator.stop();
});

test('context edits that remove the originating action do not receive its pending reflection', async t => {
  const { config } = fixture(t);
  const coordinator = new Coordinator(config, { sessions: { async close() {} } });
  const { manager, source: origin } = source(config);
  const thought = coordinator.store.reflect('A fictional thought.', origin, 'thought');
  coordinator.store.finish(thought.id, 'A fictional selected passage.', 'return');
  manager.appendContextEdit(origin.entryId, { content: [{ type: 'text', text: 'An edited synthetic response without that action.' }] });
  await coordinator.call('foreground.update', { id: 'edited', pid: process.pid, file: manager.getSessionFile(), sessionId: manager.getSessionId(), busy: false });
  assert.deepEqual(await coordinator.call('deliveries', { clientId: 'edited' }), []);
  assert.throws(() => originContext(manager, 'source-call'), /unavailable/);
  assert.equal(coordinator.store.state.deliveries[thought.id].status, 'pending');
  await coordinator.stop();
});

test('source compaction preserves delivery to the same conversation even after the action leaves model context', async t => {
  const { config } = fixture(t);
  const coordinator = new Coordinator(config, { sessions: { async close() {} } });
  const { manager, source: origin } = source(config);
  const thought = coordinator.store.reflect('A fictional thought.', origin, 'thought');
  coordinator.store.finish(thought.id, 'A selected reflection after compaction.', 'return');
  manager.appendMessage({ role: 'toolResult', toolCallId: 'source-call', toolName: 'subconscious_reflect', content: [{ type: 'text', text: 'Synthetic accepted receipt' }], isError: false, timestamp: Date.now() });
  const keep = manager.appendMessage({ role: 'user', content: [{ type: 'text', text: 'A later fictional question.' }], timestamp: Date.now() });
  manager.appendCompaction('Synthetic source summary.', keep, 1000);
  assert.equal(manager.buildSessionProjection().entries.some(entry => entry.sourceEntry.id === origin.entryId), false);
  await coordinator.call('foreground.update', { id: 'compacted', pid: process.pid, file: manager.getSessionFile(), sessionId: manager.getSessionId(), busy: false });
  assert.deepEqual(await coordinator.call('deliveries', { clientId: 'compacted' }), [{ id: thought.id, content: 'A selected reflection after compaction.' }]);
  await coordinator.stop();
});

test('starting a user-facing chat is receipt-bound, ordinary Pi storage, and separately notified', async t => {
  const { config } = fixture(t);
  const coordinator = new Coordinator(config, { sessions: { async close() {} } });
  const result = await coordinator.startChat({ title: 'A fictional hello', message: 'A synthetic opening.' }, 'start-chat', syntheticModel);
  assert.deepEqual(await coordinator.startChat({ title: 'Duplicate', message: 'Should not duplicate' }, 'start-chat'), result);
  const manager = SessionManager.open(result.file);
  assert.equal(manager.getSessionName(), 'A fictional hello');
  assert.equal(manager.buildSessionContext().messages.at(-1).role, 'assistant');
  assert.equal(manager.buildSessionContext().messages.at(-1).content[0].text, 'A synthetic opening.');
  assert.equal(result.file.startsWith(join(config.agentDir, 'sessions')), true);
  assert.equal((await coordinator.call('notifications')).length, 1);
  await coordinator.call('notification.ack', { id: result.id });
  assert.equal((await coordinator.call('notifications')).length, 0);
  const reloaded = new Coordinator(config, { sessions: { async close() {} } });
  assert.deepEqual(await reloaded.startChat({ title: 'Duplicate', message: 'Duplicate' }, 'start-chat'), result);
  await coordinator.stop(); await reloaded.stop();
});

test('a completed turn is recovered without another model request or resetting its chosen rest', async t => {
  const { config } = fixture(t);
  const store = new Store(config);
  store.change(() => { Object.assign(store.row('general'), { inProgress: true, wakeId: 'synthetic-wake', restMs: 17, stepCompleted: { wakeId: 'synthetic-wake', completedAt: 1000, hasTools: true } }); });
  const coordinator = new Coordinator(config, { sessions: { async close() {} } });
  assert.equal(coordinator.store.row('general').nextWake, 1017);
  assert.equal(coordinator.store.row('general').inProgress, undefined);
  await coordinator.stop();
});

test('socket service permits one coordinator and handles multiple clients without tying its lifetime to them', async t => {
  const { config } = fixture(t, { initialRestMs: 60000 });
  const service = await startService(config, { schedule: false });
  t.after(() => service.close());
  const one = new Client(config), two = new Client(config);
  assert.equal((await one.call('status')).paused, false);
  await assert.rejects(startService(config), /already running/);
  await one.call('foreground.update', { id: 'one', pid: process.pid, file: 'synthetic-one', sessionId: 'one', busy: true });
  await two.call('foreground.update', { id: 'two', pid: process.pid, file: 'synthetic-two', sessionId: 'two', busy: false });
  assert.equal((await two.call('status')).clients.length, 2);
  await one.call('foreground.leave', { id: 'one' }); await two.call('foreground.leave', { id: 'two' });
  assert.equal((await one.call('status')).clients.length, 0);
  await one.call('pause', { paused: true });
  assert.equal((await two.call('status')).paused, true);
});
