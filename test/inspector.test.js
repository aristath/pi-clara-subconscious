import test from 'node:test';
import assert from 'node:assert/strict';
import { Coordinator } from '../src/service.js';
import { fixture, sdkFactory, deferred, output } from './helpers.js';

test('inspection observes the running request and final usage without starting, pausing or changing work', async t => {
  const { config } = fixture(t);
  const entered = deferred(), finish = deferred(); let generations = 0;
  const coordinator = new Coordinator(config, { createSession: sdkFactory(async () => {
    generations++; entered.resolve(); await finish.promise;
    return output('A controlled private thought.');
  }) });
  t.after(() => coordinator.stop());
  const work = coordinator.tick(); await entered.promise;
  const live = await coordinator.call('read', { id: 'general' });
  assert.equal(live.live.streaming, true);
  assert.ok(live.live.request.startedAt >= live.live.request.queuedAt);
  const snapshot = await coordinator.call('inspect.context', { id: 'general' });
  assert.ok(snapshot.context.messages.length > 0);
  assert.equal(snapshot.request.model.id, 'default');
  assert.equal(generations, 1); assert.equal(coordinator.store.state.paused, false);
  assert.equal(coordinator.gate.active.kind, 'model');
  finish.resolve(); await work;
  const done = await coordinator.call('read', { id: 'general' });
  assert.equal(done.live.streaming, false);
  assert.ok(done.live.request.finishedAt >= done.live.request.startedAt);
  assert.equal(done.live.request.stopReason, 'stop');
  assert.ok(done.entries.some(entry => entry.message?.content?.some?.(part => part.text === 'A controlled private thought.')));
  await assert.rejects(coordinator.call('inspect.context', { id: '../unknown' }), /not found/);
  assert.equal(generations, 1);
});
