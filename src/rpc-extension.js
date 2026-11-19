import { nativeOperations } from './native-operations.js';
import { SessionManager, SettingsManager, getAgentDir } from '@earendil-works/pi-coding-agent';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai';
import { openSync, fsyncSync, closeSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export function syncSession(manager) {
  const path = manager.getSessionFile();
  if (path && existsSync(path)) { const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
}
export function persistSession(manager) {
  const path = manager.getSessionFile();
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, [manager.getHeader(), ...manager.getEntries()].map(row => JSON.stringify(row)).join('\n') + '\n', { flag: 'wx', mode: 0o600 });
  }
  syncSession(manager);
}
export function sessionData(manager) {
  return { header: manager.getHeader(), entries: manager.getEntries(), branch: manager.getBranch(), leafId: manager.getLeafId(), messages: manager.buildSessionContext().messages };
}
export function registerCommands(pi, extra = {}) {
  const methods = {
    tools: () => pi.getAllTools().map(({ name, description, exposure, namespace }) => ({ name, description, exposure, namespace })),
    'session.flush': (_args, ctx) => { persistSession(ctx.sessionManager); return ctx.sessionManager.getSessionFile(); },
    settings: (_args, ctx) => { const native = SettingsManager.create(ctx.cwd, getAgentDir(), { projectTrusted: true }); return { settings: pi.getSettings(), defaults: { compaction: native.getCompactionSettings(), retry: native.getRetrySettings() }, models: ctx.modelRegistry.getAvailable().map(model => ({ provider: model.provider, id: model.id, name: model.name, contextWindow: model.contextWindow, thinkingLevels: getSupportedThinkingLevels(model) })) }; },
    'sessions.list': ({ directory }) => SessionManager.listAll(directory),
    'session.header': ({ path }) => SessionManager.open(path).getHeader(),
    'session.entries': ({ path }) => SessionManager.open(path).getEntries(),
    'session.messages': ({ path }) => SessionManager.open(path).buildSessionContext().messages,
    'session.read': ({ path }) => sessionData(SessionManager.open(path)),
    'session.rename': ({ path, name }) => { const manager = SessionManager.open(path); manager.appendSessionInfo(name); syncSession(manager); },
    'session.archive': ({ path, data }) => { const manager = SessionManager.open(path); manager.appendCustomEntry('pi-session-archive:state', data); syncSession(manager); },
    'session.copy': ({ path, entryId, directory, cwd }) => {
      const manager = SessionManager.open(path), entries = manager.getEntries();
      if (entryId === undefined) entryId = manager.getLeafId();
      if (entryId) manager.createBranchedSession(entryId);
      else { const empty = SessionManager.create(cwd ?? manager.getCwd(), directory ?? manager.getSessionDir()); empty.getHeader().parentSession = path; persistSession(empty); return empty.getSessionFile(); }
      persistSession(manager); return manager.getSessionFile();
    },
    ...nativeOperations(persistSession),
    ...extra,
  };
  pi.registerCommand('pi-command', { description: 'Native session and configuration operations for an RPC client', handler: async (text, ctx) => {
    const { id, method, args } = JSON.parse(text);
    try {
      if (!Object.hasOwn(methods, method)) throw new Error('Unknown Pi operation.');
      const data = await methods[method](args ?? {}, ctx);
      ctx.ui.notify('pi-rpc:' + JSON.stringify({ id, data }), 'info');
    } catch (error) { ctx.ui.notify('pi-rpc:' + JSON.stringify({ id, error: error.message }), 'info'); }
  } });
}
export default function rpcCommands(pi) { registerCommands(pi); }
