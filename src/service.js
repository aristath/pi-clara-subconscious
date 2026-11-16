import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, chmodSync, statSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { Store, text } from './store.js';
import { Gate } from './gate.js';
import { assertProfilePath, expandPath } from './config.js';
import { PiSessions, originContext, originPresent, deliveredIds, syncSession, sessionMatches, assistantMessage } from './sessions.js';

function alive(pid) { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } }
function acquireLock(config) {
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const path = join(config.dataDir, 'service.lock');
  const owner = join(path, 'owner.json');
  try { mkdirSync(path, { mode: 0o700 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let record;
    try { record = JSON.parse(readFileSync(owner, 'utf8')); } catch { /* An owner may be publishing its record. */ }
    if (record?.pid && alive(record.pid)) throw new Error('A coordinator is already running or starting for this data store');
    if (!record?.pid && Date.now() - statSync(path).mtimeMs < 10000) throw new Error('A coordinator is starting for this data store');
    rmSync(path, { recursive: true });
    mkdirSync(path, { mode: 0o700 });
  }
  const token = randomUUID();
  writeFileSync(owner, JSON.stringify({ pid: process.pid, token }), { mode: 0o600 });
  return () => {
    try { if (JSON.parse(readFileSync(owner, 'utf8')).token === token) rmSync(path, { recursive: true }); } catch { /* Already released. */ }
  };
}
function readJSON(body) {
  try { return JSON.parse(body); } catch { throw new Error('Request must be valid JSON'); }
}
function boundedPage(entries, args) {
  const offset = Number.isInteger(args.offset) && args.offset >= 0 ? args.offset : 0;
  const limit = Number.isInteger(args.limit) && args.limit > 0 ? Math.min(args.limit, 100) : 30;
  return { entries: entries.slice(offset, offset + limit), total: entries.length, next: offset + limit < entries.length ? offset + limit : null };
}

export class Coordinator {
  constructor(config, options = {}) {
    this.config = config;
    this.store = options.store ?? new Store(config);
    this.gate = new Gate(() => this.store.state.paused, options.isAlive);
    this.controller = new AbortController(); this.signal = this.controller.signal;
    this.errors = new Map(); this.missingTools = new Map();
    this.sessions = options.sessions ?? new PiSessions(this, options);
    this.running = false; this.stopping = false;
    this.sessions.recover?.();
    for (const row of this.store.list()) if (row.stepCompleted) this.completeStep(row.id, row.stepCompleted);
  }
  startChat(args, key, model) {
    const { store, config } = this;
    if (store.state.receipts[key]) return store.state.receipts[key];
    text(args.title, 'title'); text(args.message, 'message');
    let manager;
    const plan = store.state.chatPlans[key];
    if (plan) { assertProfilePath(config, plan.file); manager = SessionManager.open(plan.file); }
    else {
      const settings = SettingsManager.create(config.workspace, config.agentDir);
      // Pi's documented per-workspace session directory convention. An explicit
      // Pi sessionDir setting takes precedence; no private session folder here.
      const safePath = `--${config.workspace.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
      const sessionDirectory = config.profileRoot ? join(config.profileRoot, 'sessions') :
        settings.getSessionDir() ? expandPath(settings.getSessionDir(), config.workspace) : join(config.agentDir, 'sessions', safePath);
      manager = SessionManager.create(config.workspace, sessionDirectory);
      const metadata = { api: model?.api, provider: model?.provider, id: model?.id };
      assistantMessage(args.message, metadata);
      store.change(state => { state.chatPlans[key] = { file: manager.getSessionFile(), title: args.title, message: args.message, model: metadata }; });
    }
    const saved = store.state.chatPlans[key];
    assertProfilePath(config, manager.getSessionFile());
    if (!manager.getEntries().some(entry => entry.type === 'custom' && entry.customType === 'pi-clara-subconscious:opening' && entry.data?.receipt === key)) {
      manager.appendCustomEntry('pi-clara-subconscious:opening', { receipt: key });
      manager.appendSessionInfo(saved.title);
      manager.appendMessage(assistantMessage(saved.message, saved.model));
      const settings = SettingsManager.create(config.workspace, config.agentDir);
      if (settings.getDefaultProvider() && settings.getDefaultModel()) manager.appendModelChange(settings.getDefaultProvider(), settings.getDefaultModel());
      syncSession(manager);
    }
    return store.once(key, state => {
      const id = randomUUID();
      const result = { id, sessionId: manager.getSessionId(), file: manager.getSessionFile(), title: saved.title };
      state.deliveries[id] = { id, kind: 'new-chat', ...result, status: 'available', createdAt: Date.now() };
      return result;
    });
  }
  chats(args) { return this.sessions.chats(args); }
  foreground(params) {
    if (typeof params.id !== 'string' || typeof params.sessionId !== 'string' || typeof params.file !== 'string') throw new Error('A foreground session registration is required');
    const data = { pid: params.pid, busy: params.busy === true, file: params.file, sessionId: params.sessionId, identityEntries: params.identityEntries ?? [] };
    this.gate.update(params.id, data);
    return data;
  }
  sourceClient(id) {
    const client = this.gate.clients.get(id);
    if (!client) throw new Error('Foreground registration expired; reconnect before continuing');
    assertProfilePath(this.config, client.file);
    if (!sessionMatches({ file: client.file, sessionId: client.sessionId })) throw new Error('The registered source Pi session is unavailable');
    return client;
  }
  pending(id) {
    const registered = this.gate.clients.get(id);
    if (!registered) throw new Error('Foreground registration expired; reconnect before continuing');
    // A fresh Pi session has its filename before its first message is persisted.
    if (!registered.file || !existsSync(registered.file)) return [];
    const client = this.sourceClient(id);
    const manager = SessionManager.open(client.file);
    const received = deliveredIds(manager);
    const pending = [];
    let changed = false;
    for (const delivery of Object.values(this.store.state.deliveries)) {
      if (delivery.kind === 'new-chat' || delivery.status !== 'pending') continue;
      if (delivery.source.file !== realpathSync(client.file) || delivery.source.sessionId !== client.sessionId) continue;
      if (received.has(delivery.id)) {
        delivery.status = 'delivered'; delivery.deliveredAt = Date.now(); changed = true;
      } else if (originPresent(manager, delivery.source)) pending.push({ id: delivery.id, content: delivery.content });
    }
    if (changed) this.store.save();
    return pending;
  }
  inspect(id, args = {}) {
    const row = this.store.row(id);
    assertProfilePath(this.config, row.sessionFile);
    const entries = row.sessionFile && existsSync(row.sessionFile) ? SessionManager.open(row.sessionFile).getEntries() : [];
    return { conversation: structuredClone(row), ...boundedPage(entries, args), transcriptWarning: row.sessionFile && !existsSync(row.sessionFile) ? 'The saved transcript is unavailable; it has not been deleted.' : null, live: this.sessions.inspect?.(id) ?? null };
  }
  resolveAction(args) {
    const action = this.store.state.actions[args.key];
    if (!action || action.status !== 'started') throw new Error('No unresolved action with this receipt');
    if (this.gate.active?.id === args.key) throw new Error('The original action is still running; wait for it to settle');
    if (this.store.row(action.conversationId).blockedAction !== args.key) throw new Error('This action is not awaiting resolution; inspect its original run');
    if (typeof args.executed !== 'boolean') throw new Error('Specify whether the action executed after inspecting its real outcome');
    if (args.executed && (!args.result || !Array.isArray(args.result.content))) throw new Error('An executed action needs its observed result content');
    return this.store.change(() => {
      action.status = 'completed';
      action.result = { role: 'toolResult', toolCallId: action.callId, toolName: action.name,
        content: args.executed ? args.result.content : [{ type: 'text', text: 'The operator verified this action did not execute. It may be requested again if still wanted.' }],
        details: args.executed ? args.result.details : undefined, isError: args.executed ? !!args.result.isError : true, timestamp: Date.now() };
      const row = this.store.row(action.conversationId);
      delete row.blocked; delete row.blockedAction; delete row.retryAt; row.nextWake = Date.now();
      // Force reopening so repaired receipts are projected into Pi history.
      const session = this.sessions.sessions?.get(row.id);
      session?.dispose(); this.sessions.sessions?.delete(row.id);
      return { resolved: true };
    });
  }
  async call(method, params = {}) {
    switch (method) {
      case 'ping': return { pid: process.pid, storeId: this.config.storeId, stopping: this.stopping };
      case 'status': return { paused: this.store.state.paused, active: this.gate.active, clients: [...this.gate.clients].map(([id, value]) => ({ id, ...value, stale: Date.now() - value.seen > this.config.staleClientMs })), conversations: this.store.list(), pendingDeliveries: Object.values(this.store.state.deliveries).filter(delivery => delivery.status === 'pending').map(delivery => ({ id: delivery.id, sessionId: delivery.source.sessionId, file: delivery.source.file })), missingTools: Object.fromEntries(this.missingTools), errors: Object.fromEntries(this.errors) };
      case 'pause': this.store.change(state => { state.paused = params.paused !== false; }); this.gate.wake(); return { paused: this.store.state.paused };
      case 'topic': { const result = this.store.topic(params, 'user', params.receipt ?? randomUUID()); this.gate.wake(); return result; }
      case 'list': return this.store.list();
      case 'read': return this.inspect(params.id, params);
      case 'inspect.context': this.store.row(params.id); return this.sessions.inspect?.(params.id, true) ?? { context: null };
      case 'actions': return Object.entries(this.store.state.actions).filter(([, action]) => action.status === 'started').map(([key, action]) => ({ key, ...action, active: this.gate.active?.id === key, resolvable: this.store.row(action.conversationId).blockedAction === key && this.gate.active?.id !== key }));
      case 'resolve': return this.resolveAction(params);
      case 'foreground.update': this.foreground(params); return { registered: true };
      case 'foreground.enter': { const data = this.foreground({ ...params, busy: true }); await this.gate.foreground(params.id, data, this.signal); return { admitted: true }; }
      case 'foreground.leave': this.gate.remove(params.id); return { removed: true };
      case 'reflection.create': {
        const client = this.sourceClient(params.clientId);
        const manager = SessionManager.open(client.file);
        const source = originContext(manager, params.callId);
        const result = this.store.reflect(source.thought, source, `${source.sessionId}:${source.entryId}:${source.callId}`);
        this.gate.wake(); return { id: result.id, status: result.status };
      }
      case 'deliveries': return this.pending(params.clientId);
      case 'notifications': return Object.values(this.store.state.deliveries).filter(row => row.kind === 'new-chat' && row.status === 'available');
      case 'notification.ack': this.store.change(state => { const row = state.deliveries[params.id]; if (!row || row.kind !== 'new-chat') throw new Error('Notification not found'); row.status = 'acknowledged'; }); return { acknowledged: true };
      case 'stop': this.requestStop?.(); return { stopping: true };
      default: throw new Error('Unknown service method');
    }
  }
  async tick() {
    if (this.running || this.stopping || this.store.state.paused || this.gate.busy()) return false;
    const row = this.store.due()[0];
    if (!row) return false;
    this.running = true;
    try {
      this.store.change(() => { const current = this.store.row(row.id); current.wakeId ??= randomUUID(); current.inProgress = true; });
      const result = await this.sessions.step(this.store.row(row.id));
      this.completeStep(row.id, this.store.row(row.id).stepCompleted ?? { ...result, completedAt: Date.now() });
      this.errors.delete(row.id);
    } catch (error) {
      if (!this.stopping) {
        this.errors.set(row.id, error.message);
        this.store.change(() => { const current = this.store.row(row.id); current.error = error.message; current.retryAt = Date.now() + this.config.errorRetryMs; current.lastStep = Date.now(); });
      }
    } finally { this.running = false; }
    return true;
  }
  completeStep(id, result) {
    this.store.change(() => {
      const current = this.store.row(id);
      current.lastStep = result.completedAt; current.updatedAt = current.lastStep;
      delete current.retryAt; delete current.error; delete current.inProgress; delete current.wakeId; delete current.stepCompleted;
      if (current.restMs !== undefined) {
        current.nextWake = current.lastStep + current.restMs;
        current.lastRestMs = current.restMs; delete current.restMs;
      } else if (current.kind === 'reflection' || result.hasTools) current.nextWake = current.lastStep;
      else current.nextWake = current.lastStep + this.config.initialRestMs;
    });
  }
  async stop() {
    this.stopping = true;
    // Let a currently executing model/tool finish. Wake blocked boundaries so
    // they can settle without starting another step. Never kill external work.
    this.gate.stop();
    while (this.running) await new Promise(resolve => setTimeout(resolve, 10));
    this.controller.abort();
    await this.sessions.close();
  }
}

export async function startService(config, options = {}) {
  if (config.sessionFactoryModule && !options.createSession) {
    const { createPrivateSession } = await import(pathToFileURL(config.sessionFactoryModule));
    options = { ...options, createSession: createPrivateSession };
  }
  const releaseLock = acquireLock(config);
  let coordinator, server;
  try {
    coordinator = new Coordinator(config, options);
    if (process.platform !== 'win32' && existsSync(config.socketPath)) rmSync(config.socketPath);
    server = createServer(async (request, response) => {
      try {
        if (request.method !== 'POST' || request.url !== '/') throw new Error('Use POST /');
        let body = '';
        for await (const chunk of request) { body += chunk; if (Buffer.byteLength(body) > 16777216) throw new Error('Request exceeds 16 MiB'); }
        const { method, params } = readJSON(body);
        const result = await coordinator.call(method, params);
        response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ result }));
      } catch (error) {
        response.writeHead(400, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: error.message }));
      }
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.socketPath, resolve); });
    if (process.platform !== 'win32') chmodSync(config.socketPath, 0o600);
    let timer, closed;
    let closing = false;
    const close = async () => {
      if (closing) return closed;
      closing = true;
      closed = (async () => {
        clearTimeout(timer); clearInterval(sweeper);
        await coordinator.stop();
        await new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); });
        if (process.platform !== 'win32' && existsSync(config.socketPath)) rmSync(config.socketPath);
        releaseLock();
      })();
      return closed;
    };
    coordinator.requestStop = () => { setImmediate(() => void close()); };
    const pump = async () => {
      if (closing) return;
      try { await coordinator.tick(); }
      catch (error) { coordinator.errors.set('service', error.message); }
      if (!closing) timer = setTimeout(pump, 25);
    };
    const sweeper = setInterval(() => coordinator.gate.sweep(config.staleClientMs), config.heartbeatMs);
    if (options.schedule !== false) timer = setTimeout(pump, 0);
    return { coordinator, server, close };
  } catch (error) {
    server?.close(); releaseLock(); throw error;
  }
}
