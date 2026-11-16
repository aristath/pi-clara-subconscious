import { mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export function durableWrite(path, data) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temp, 'wx', 0o600);
  try { writeFileSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, path);
  if (process.platform !== 'win32') {
    const dir = openSync(dirname(path), 'r');
    try { fsyncSync(dir); } finally { closeSync(dir); }
  }
}

export class Store {
  constructor(config, now = Date.now) {
    this.config = config; this.now = now;
    mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
    chmodSync(config.dataDir, 0o700);
    this.path = join(config.dataDir, 'state.json');
    const initialized = config.configPath && join(dirname(config.configPath), 'runtime', 'subconscious.initialized');
    if (initialized && existsSync(initialized) && !existsSync(this.path)) throw new Error('Private thinking state is temporarily unavailable; restore its original state file.');
    this.state = existsSync(this.path) ? JSON.parse(readFileSync(this.path, 'utf8')) : {
      version: 1, paused: config.initiallyPaused === true, conversations: {}, receipts: {}, deliveries: {}, actions: {}, chatPlans: {},
    };
    if (this.state.version !== 1 || !this.state.conversations || !this.state.receipts || !this.state.deliveries || !this.state.actions) throw new Error('Cannot read package state; original state was preserved');
    if (!existsSync(this.path)) this.save();
    if (initialized && !existsSync(initialized)) durableWrite(initialized, JSON.stringify({ dataDir: config.dataDir }) + '\n');
  }
  save() { durableWrite(this.path, JSON.stringify(this.state, null, 2) + '\n'); }
  change(fn) {
    const snapshot = structuredClone(this.state);
    try { const result = fn(this.state); this.save(); return result; }
    catch (error) { this.state = snapshot; throw error; }
  }
  once(key, fn) {
    if (typeof key !== 'string' || !key) throw new Error('A trusted invocation receipt is required');
    if (Object.hasOwn(this.state.receipts, key)) return structuredClone(this.state.receipts[key]);
    return this.change(state => {
      const result = fn(state);
      Object.defineProperty(state.receipts, key, { value: structuredClone(result), enumerable: true, writable: true, configurable: true });
      return result;
    });
  }
  row(id) {
    if (typeof id !== 'string' || !Object.hasOwn(this.state.conversations, id)) throw new Error('Private conversation not found');
    const row = this.state.conversations[id];
    return row;
  }
  list() { return Object.values(this.state.conversations).map(row => structuredClone(row)); }
  reflect(content, source, key) {
    return this.once(key, state => {
      if (!source?.file || !source?.sessionId || !source?.callId) throw new Error('Reflection needs a trusted originating Pi invocation');
      const id = randomUUID();
      const row = { id, kind: 'reflection', owner: 'agent', title: 'Private reflection', content: text(content, 'content'), source, status: 'active', nextWake: this.now(), createdAt: this.now(), updatedAt: this.now() };
      state.conversations[id] = row;
      return structuredClone(row);
    });
  }
  finish(id, content, key) {
    return this.once(key, state => {
      const row = this.row(id);
      if (row.kind !== 'reflection') throw new Error('Only a private reflection can finish or return');
      if (row.status !== 'active') throw new Error('This reflection has already finished');
      if (content !== undefined) {
        text(content, 'content');
        state.deliveries[id] = { id, source: row.source, content, status: 'pending', createdAt: this.now() };
      }
      row.status = content === undefined ? 'finished' : 'returned';
      row.updatedAt = this.now();
      return { id, status: row.status };
    });
  }
  due() {
    const now = this.now();
    return this.list().filter(row => row.kind === 'reflection' && row.status === 'active' && !row.blocked && (row.retryAt ?? row.nextWake) <= now)
      .sort((a, b) => (a.lastStep ?? 0) - (b.lastStep ?? 0) || a.nextWake - b.nextWake);
  }
}

export function text(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be a nonempty string`);
  return value;
}
