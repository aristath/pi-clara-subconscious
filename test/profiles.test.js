import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, unlinkSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { fixture } from './helpers.js';
import { Coordinator } from '../src/service.js';
import { Store } from '../src/store.js';

test('a profile cannot inspect another profile through private transcript paths or symlinks', async t => {
  const f = fixture(t, { initiallyPaused: true });
  const config = { ...f.config, dataDir: join(f.workspace, 'subconscious'), profileRoot: f.workspace, initiallyPaused: true };
  const coordinator = new Coordinator(config, { sessions: { async close() {} } });
  t.after(() => coordinator.stop());
  assert.equal(coordinator.store.state.paused, true);
  const outside = join(f.root, 'other-user'); mkdirSync(outside);
  const other = SessionManager.create(outside, join(outside, 'sessions'));
  other.appendMessage({ role: 'user', content: 'Private to the other profile', timestamp: 1 });
  coordinator.store.change(state => { state.conversations['sample-reflection'].sessionFile = other.getSessionFile(); });
  assert.throws(() => coordinator.inspect('sample-reflection'), /another profile/);
  symlinkSync(outside, join(f.workspace, 'shortcut'));
  coordinator.store.change(state => { state.conversations['sample-reflection'].sessionFile = join(f.workspace, 'shortcut', 'not-yet-created.jsonl'); });
  assert.throws(() => coordinator.inspect('sample-reflection'), /outside/);
  unlinkSync(coordinator.store.path);
  assert.throws(() => new Store(config), /temporarily unavailable/);
});
