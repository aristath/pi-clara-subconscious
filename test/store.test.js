import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { loadConfig, allowedTool } from '../src/config.js';
import { fixture } from './helpers.js';

test('topic ownership is enforced, own topics can change and retire, receipts are idempotent', t => {
  const { config } = fixture(t);
  const store = new Store(config);
  const user = store.topic({ action: 'create', title: 'Synthetic topic', content: 'A fictional subject.' }, 'user', 'user-create');
  const own = store.topic({ action: 'create', title: 'Agent topic', content: 'A different fictional subject.' }, 'agent', 'agent-create');
  assert.deepEqual(store.topic({ action: 'create', title: 'Ignored duplicate', content: 'Duplicate' }, 'agent', 'agent-create'), own);
  assert.throws(() => store.topic({ action: 'update', id: user.id, content: 'Forbidden change' }, 'agent', 'bad-update'), /User-supplied/);
  assert.throws(() => store.topic({ action: 'retire', id: user.id }, 'agent', 'bad-retire'), /User-supplied/);
  assert.equal(store.row(user.id).content, 'A fictional subject.');
  store.topic({ action: 'update', id: own.id, content: 'Revised fictional subject.' }, 'agent', 'own-update');
  store.topic({ action: 'retire', id: own.id }, 'agent', 'own-retire');
  const reloaded = new Store(config);
  assert.equal(reloaded.row(own.id).status, 'retired');
  assert.equal(reloaded.row(own.id).content, 'Revised fictional subject.');
  assert.equal(reloaded.row('general').kind, 'general');
});

test('separate rest schedules allow zero without a hidden minimum', t => {
  const { config } = fixture(t);
  let now = 1000;
  const store = new Store(config, () => now);
  const a = store.topic({ action: 'create', title: 'Topic A', content: 'A' }, 'agent', 'a');
  const b = store.topic({ action: 'create', title: 'Topic B', content: 'B' }, 'agent', 'b');
  store.rest(a.id, 0, 'rest-a'); store.rest(b.id, 123, 'rest-b');
  assert.equal(store.row(a.id).restMs, 0);
  assert.equal(store.row(b.id).restMs, 123);
  assert.equal(store.row('general').restMs, undefined);
  assert.throws(() => store.rest(a.id, -1, 'negative'), /nonnegative/);
});

test('each reflection has its own source and can finish silently or return once', t => {
  const { config } = fixture(t);
  const store = new Store(config);
  const source = { file: '/synthetic/source.jsonl', sessionId: 'synthetic-session', callId: 'synthetic-call', entryId: 'synthetic-entry', context: [] };
  const a = store.reflect('A synthetic thought.', source, 'reflect-a');
  const b = store.reflect('Another synthetic thought.', { ...source, callId: 'other-call' }, 'reflect-b');
  assert.notEqual(a.id, b.id);
  assert.equal(store.reflect('Duplicate', source, 'reflect-a').id, a.id);
  assert.throws(() => store.rest(a.id, 100, 'bad-rest'), /not reflections/);
  store.finish(a.id, undefined, 'finish-a');
  assert.equal(store.row(a.id).status, 'finished');
  assert.equal(store.state.deliveries[a.id], undefined);
  store.finish(b.id, 'A selected fictional reflection.', 'return-b');
  assert.equal(store.state.deliveries[b.id].content, 'A selected fictional reflection.');
  assert.equal(store.state.deliveries[b.id].status, 'pending');
  assert.equal(Object.keys(store.state.deliveries).length, 1);
  assert.equal(new Store(config).row(b.id).status, 'returned');
});

test('an invalid mutation does not lose previously accepted state', t => {
  const { config } = fixture(t);
  const store = new Store(config);
  store.change(state => { state.paused = true; });
  assert.throws(() => store.change(state => { state.paused = false; throw new Error('synthetic failure'); }), /synthetic failure/);
  assert.equal(store.state.paused, true);
  assert.equal(new Store(config).state.paused, true);
});

test('tool allowlist uses exact names and excludes execution, mutation and wrappers', t => {
  const f = fixture(t);
  assert.equal(allowedTool(f.config, 'read'), true);
  for (const name of ['bash', 'write', 'edit', 'codemode', 'tool_search', 'subagent', 'not_configured']) assert.equal(allowedTool(f.config, name), false);
  assert.equal(allowedTool(f.config, 'read', [{ name: 'read', reachesTools: () => 'all' }]), false);
  assert.throws(() => f.writeConfig({ allowedTools: ['bash'] }), /cannot be allowed/);
  assert.throws(() => f.writeConfig({ allowedTools: ['*'] }), /without wildcards/);
  assert.throws(() => f.writeConfig({ model: { provider: 'synthetic' } }), /model must be/);
});
