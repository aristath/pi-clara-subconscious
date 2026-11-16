import { readFile, readdir, realpath } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { Gate } from './gate.js';
import { durableWrite } from './store.js';

export function interval(value) {
  const match = String(value).trim().match(/^(?:every\s+)?(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|seconds?|m|minutes?|h|hours?|d|days?|w|weeks?|months?|y|years?)$/i);
  if (!match || Number(match[1]) <= 0) throw new Error('Use an interval such as 5 minutes, 13h, or 6 months.');
  const amount = Number(match[1]), unit = match[2].toLowerCase();
  if (!Number.isFinite(amount)) throw new Error('The interval must be a finite positive number.');
  if (unit.startsWith('month') || unit === 'y' || unit.startsWith('year')) {
    if (!Number.isInteger(amount)) throw new Error('Calendar months and years must be whole numbers.');
    return { months: amount * (unit.startsWith('month') ? 1 : 12) };
  }
  const scale = unit === 'ms' || unit.startsWith('millisecond') ? 1 :
    unit.startsWith('s') ? 1000 : unit.startsWith('m') ? 60000 : unit.startsWith('h') ? 3600000 : unit.startsWith('d') ? 86400000 : 604800000;
  if (!Number.isFinite(amount * scale)) throw new Error('The interval is too large.');
  return { milliseconds: amount * scale };
}

export function nextRun(time, every) {
  if (every.milliseconds) {
    const next = time + every.milliseconds;
    if (!Number.isFinite(new Date(next).getTime())) throw new Error('The interval exceeds the supported calendar range.');
    return next;
  }
  const date = new Date(time), day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + every.months);
  const end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, end));
  if (!Number.isFinite(date.getTime())) throw new Error('The interval exceeds the supported calendar range.');
  return date.getTime();
}

export function taskHeader(source) {
  const header = source.match(/^\s*\/\*\*?([\s\S]*?)\*\//)?.[1];
  if (!header) throw new Error('Start the task file with a comment containing @every and @mode.');
  const fields = Object.fromEntries([...header.matchAll(/^\s*\*?\s*@([a-z]+)\s+([^\r\n]+)/gm)].map(match => [match[1], match[2].trim()]));
  const every = interval(fields.every);
  if (!['deterministic', 'inference'].includes(fields.mode)) throw new Error('@mode must be deterministic or inference.');
  const session = fields.session ?? 'fresh';
  if (!['fresh', 'continue'].includes(session)) throw new Error('@session must be fresh or continue.');
  return { every, mode: fields.mode, session };
}

const inside = (root, path) => { const part = relative(root, path); return part !== '..' && !part.startsWith('../') && !isAbsolute(part); };

// One scheduler belongs to the host application; each profile owns its progress.
export class TaskScheduler {
  constructor({ users, prepare, execute, gate = new Gate(), tickMs = 30000, now = Date.now, report = console.error }) {
    this.users = users; this.prepare = prepare; this.execute = execute; this.gate = gate;
    this.tickMs = tickMs; this.now = now; this.report = report;
    if (!Number.isFinite(tickMs) || tickMs <= 0) throw new Error('tasks.tickMs must be a positive number of milliseconds.');
    this.states = new Map(); this.errors = new Map(); this.running = null; this.stopping = false;
  }
  state(folder) {
    if (!this.states.has(folder)) {
      const path = join(folder, '.pi/runtime/tasks.json');
      const value = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { tasks: {} };
      if (!value.tasks || typeof value.tasks !== 'object' || Array.isArray(value.tasks)) throw new Error('Task progress is unreadable; its existing file has been preserved.');
      this.states.set(folder, { path, value });
    }
    return this.states.get(folder);
  }
  save(folder) { const state = this.state(folder); durableWrite(state.path, JSON.stringify(state.value, null, 2) + '\n'); }
  error(key, error) {
    if (this.errors.get(key) !== error.message) this.report(`Scheduled task ${key}: ${error.message}`);
    this.errors.set(key, error.message);
  }
  async pending() {
    const pending = [];
    for (const user of await this.users()) {
      const folder = user.folder;
      try {
        const root = await realpath(folder), directory = join(folder, 'tasks');
        let files;
        try { files = await readdir(directory, { withFileTypes: true }); }
        catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        const state = this.state(folder);
        let changed = false;
        for (const file of files.sort((a,b) => a.name.localeCompare(b.name))) {
          if (!file.isFile() || !/\.(?:js|ts)$/.test(file.name)) continue;
          const key = user.id + '/' + file.name;
          try {
            const path = await realpath(join(directory, file.name));
            if (!inside(root, path)) throw new Error('Task file points outside its owner’s profile.');
            const header = taskHeader(await readFile(path, 'utf8'));
            let row = state.value.tasks[file.name];
            if (!row) { row = state.value.tasks[file.name] = { createdAt: this.now(), every: header.every, nextRun: nextRun(this.now(), header.every) }; changed = true; }
            else if (JSON.stringify(row.every) !== JSON.stringify(header.every)) {
              row.every = header.every; row.nextRun = nextRun(row.lastStarted ?? row.createdAt, header.every); changed = true;
            }
            this.errors.delete(key);
            if (row.nextRun <= this.now()) pending.push({ ...header, user, folder, name: file.name, path, due: row.nextRun });
          } catch (error) { this.error(key, error); }
        }
        // Deleting a task removes only its schedule. Its conversations remain.
        const names = new Set(files.map(file => file.name));
        for (const name of Object.keys(state.value.tasks)) if (!names.has(name)) { delete state.value.tasks[name]; changed = true; }
        if (changed) this.save(folder);
      } catch (error) { this.error(user.id, error); }
    }
    return pending.sort((a,b) => a.due - b.due || (a.user.id+'/'+a.name).localeCompare(b.user.id+'/'+b.name));
  }
  async tick() {
    if (this.running || this.stopping || this.gate.busy()) return false;
    const task = (await this.pending())[0];
    if (!task || this.running || this.stopping) return false;
    const work = this.run(task);
    this.running = work;
    try { await work; } finally { this.running = null; }
    return true;
  }
  async run(task) {
    let release;
    try {
      release = await this.gate.privateStep('task', task.user.id+'/'+task.name);
      const row = this.state(task.folder).value.tasks[task.name];
      // Record the occurrence before executing user code. A service crash does
      // not replay already-started deterministic effects.
      row.lastStarted = this.now(); row.nextRun = nextRun(row.lastStarted, task.every);
      this.save(task.folder);
      const context = await this.prepare(task.user);
      if (this.stopping) return;
      await this.execute(task, context, {
        gate: this.gate,
        release: () => { release?.(); release = undefined; },
        sessionFile: task.session === 'continue' ? row.sessionFile : undefined,
        saveSession: file => { row.sessionFile = file; this.save(task.folder); },
      });
      this.errors.delete(task.user.id+'/'+task.name);
    } catch (error) { if (!this.stopping) this.error(task.user.id+'/'+task.name, error); }
    finally { release?.(); }
  }
  start() {
    const pump = async () => {
      if (this.stopping) return;
      try { await this.tick(); } catch (error) { this.error('scheduler', error); }
      if (!this.stopping) this.timer = setTimeout(pump, this.tickMs);
    };
    this.timer = setTimeout(pump, 0);
  }
  async close() {
    this.stopping = true; clearTimeout(this.timer); this.gate.stop();
    await this.running;
  }
}
