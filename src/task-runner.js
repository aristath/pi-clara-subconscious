import { spawn } from 'node:child_process';
import { readFile, open, mkdir, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { gateStream, syncSession } from './sessions.js';
import { acquireLock } from './service.js';
import { TASK_MARKER } from './config.js';

// The application owns admission; the child owns one user's cwd and Pi runtime.
export async function runTask(task, context, control) {
  const child = spawn(process.execPath, ['--experimental-strip-types', fileURLToPath(import.meta.url)], {
    cwd: task.folder, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, PI_CODING_AGENT_DIR: context.agentDir },
  });
  let failure, done = false;
  const held = new Map();
  const send = message => { if (child.connected) child.send(message, () => {}); };
  child.stdout.on('data', data => process.stdout.write(data));
  child.stderr.on('data', data => process.stderr.write(data));
  child.on('message', message => {
    if (message.type === 'enter') {
      void control.gate.privateStep(message.kind, task.user.id+'/'+task.name).then(release => {
        if (!child.connected) { release(); return; }
        held.set(message.id, release); send({ type: 'admitted', id: message.id });
      }, error => send({ type: 'admitted', id: message.id, error: error.message }));
    } else if (message.type === 'release') { held.get(message.id)?.(); held.delete(message.id); }
    else if (message.type === 'initialized') control.release();
    else if (message.type === 'session') {
      try { control.saveSession(message.file); send({ type: 'saved', id: message.id }); }
      catch (error) { failure = error; send({ type: 'saved', id: message.id, error: error.message }); }
    } else if (message.type === 'done') { done = true; if (message.error) failure = new Error(message.error); }
  });
  const result = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      for (const release of held.values()) release();
      if (failure) reject(failure);
      else if (!done || code !== 0) reject(new Error(`Task worker stopped (${signal ?? code}); this occurrence will not be replayed.`));
      else resolve();
    });
  });
  send({ type: 'run', task: { ...task, user: { id: task.user.id, admin: task.user.admin } },
    workerConfig: context.workerConfig, factory: context.workerPath, sessionFile: control.sessionFile,
    lockDir: context.taskLockDir });
  return result;
}

async function worker(input) {
  let sequence = 0;
  const waiting = new Map();
  const controller = new AbortController();
  process.on('disconnect', () => {
    controller.abort();
    for (const pending of waiting.values()) pending.reject(new Error('Scheduler stopped'));
    waiting.clear();
  });
  process.on('message', message => {
    const reply = waiting.get(message.id);
    if (reply) { waiting.delete(message.id); message.error ? reply.reject(new Error(message.error)) : reply.resolve(); }
  });
  const ask = message => new Promise((resolve, reject) => {
    if (!process.connected) { reject(new Error('Scheduler stopped')); return; }
    const id = String(++sequence); waiting.set(id, { resolve, reject });
    process.send({ ...message, id });
  });
  const gate = { async privateStep(kind) {
    if (!process.connected) throw new Error('Scheduler stopped');
    const id = String(++sequence);
    await new Promise((resolve, reject) => { waiting.set(id, { resolve, reject }); process.send({ type: 'enter', kind, id }); });
    return () => { if (process.connected) process.send({ type: 'release', id }); };
  } };
  let session, releaseLock;
  try {
    if (input.lockDir) releaseLock = acquireLock({ dataDir: input.lockDir });
    const task = await import(pathToFileURL(input.task.path));
    if (input.task.mode === 'deterministic') {
      if (typeof task.default !== 'function') throw new Error('A deterministic task must export a default function.');
      await task.default({ cwd: input.task.folder, user: input.task.user.id, signal: controller.signal });
      return;
    }
    const prompt = typeof task.default === 'function'
      ? await task.default({ cwd: input.task.folder, user: input.task.user.id, signal: controller.signal }) : task.default;
    if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('An inference task must export a prompt string or a function returning one.');
    if (input.sessionFile && !existsSync(input.sessionFile)) throw new Error('This task’s continued conversation is unavailable; restore it or select @session fresh.');
    const root = await realpath(input.task.folder);
    const check = path => { const part = relative(root, path); if (part === '..' || part.startsWith('../') || isAbsolute(part)) throw new Error('The task conversation belongs to another profile.'); };
    let directory = await realpath(join(root, 'tasks'));
    check(directory);
    for (const name of ['.sessions', input.task.name]) {
      directory = join(directory, name);
      try { await mkdir(directory, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      directory = await realpath(directory); check(directory);
    }
    const previous = input.sessionFile && await realpath(input.sessionFile);
    if (previous) check(previous);
    let manager = previous ? SessionManager.open(previous, directory) : SessionManager.create(input.task.folder, directory);
    if (!input.sessionFile) {
      manager.appendCustomEntry(TASK_MARKER, { file: input.task.name });
      // Pi delays an empty session's first disk write until generation. Retain
      // its identity now so subsequent runs cannot silently replace it.
      const file = await open(manager.getSessionFile(), 'wx', 0o600);
      try { await file.writeFile([manager.getHeader(), ...manager.getEntries()].map(value => JSON.stringify(value)).join('\n')+'\n'); await file.sync(); }
      finally { await file.close(); }
      manager = SessionManager.open(manager.getSessionFile(), directory);
    }
    await ask({ type: 'session', file: manager.getSessionFile() });
    const held = new Map();
    const extension = { name: 'scheduled-task', factory(api) {
      api.on('session_start', () => api.setActiveTools(api.getActiveTools().filter(name => name !== 'subconscious_reflect')));
      api.on('tool_call', async event => {
        try { held.set(event.toolCallId, await gate.privateStep('tool')); }
        catch (error) { return { block: true, reason: error.message }; }
      });
      api.on('tool_execution_end', event => { held.get(event.toolCallId)?.(); held.delete(event.toolCallId); });
      api.on('session_shutdown', () => { for (const release of held.values()) release(); held.clear(); });
    } };
    const { runtimeFactory } = await import(pathToFileURL(input.factory));
    const config = JSON.parse(await readFile(input.workerConfig, 'utf8'));
    const result = await (await runtimeFactory(config, { privateExtension: extension }))({ sessionManager: manager });
    session = result.session;
    session.agent.toolExecution = 'sequential';
    session.agent.streamFunction = gateStream(session.agent.streamFunction, gate, input.task.name, controller.signal);
    const errors = [];
    await session.bindExtensions({ mode: 'rpc', onError: error => errors.push(error.error ?? String(error)) });
    if (errors.length) throw new Error(errors.join('\n'));
    process.send({ type: 'initialized' });
    await session.sendCustomMessage({ customType: TASK_MARKER, content: prompt, display: false }, { triggerTurn: true });
    syncSession(session.sessionManager);
    const last = session.messages.findLast(message => message.role === 'assistant');
    if (last?.stopReason === 'error' || last?.stopReason === 'aborted') throw new Error(last.errorMessage ?? 'Task inference did not finish');
  } finally {
    if (session) { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); await session.dispose(); }
    releaseLock?.();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.once('message', input => {
    const finish = error => {
      const code = error ? 1 : 0;
      if (process.connected) process.send({ type: 'done', ...(error ? { error: error.message } : {}) }, () => process.exit(code));
      else process.exit(code);
    };
    void worker(input).then(() => finish(), finish);
  });
}
