import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';

export const TASK_MARKER = 'pi-clara-subconscious:task';

export const INTERNAL_TOOLS = [
  'subconscious_source',
  'subconscious_return', 'subconscious_finish', 'subconscious_start_chat',
  'subconscious_chats',
];
export const DEFAULT_TOOLS = [
  'read', 'ls', 'find', 'grep', 'type_configuration', 'prepare_memory',
  'search_memory', 'read_memory', 'memory_timeline', 'compose_story',
  'save_memory', 'save_entity', 'save_topic', 'save_story',
  'presence_read', 'presence_write',
];
export const FORBIDDEN_TOOLS = new Set([
  'bash', 'powershell', 'shell', 'exec', 'edit', 'write',
  'exec_command', 'run_command', 'run_shell', 'terminal', 'apply_patch',
  'write_file', 'edit_file', 'execute_code', 'run_code',
  'codemode', 'tool_search', 'subagent', 'spawn_agent', 'spawn_clara_agent',
]);
const guardedMutation = (config, name) => config.profileRoot && config.sessionFactoryModule && ['write', 'edit'].includes(name);
export function expandPath(path, base = process.cwd()) {
  if (typeof path !== 'string' || !path.trim()) throw new Error('Expected a nonempty path');
  return path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : resolve(base, path);
}
export function defaultConfigPath() { return join(process.cwd(), '.pi', 'settings.json'); }
export function assertProfilePath(config, path) {
  if (!config.profileRoot || !path) return;
  const target = resolve(path), roots = [config.profileRoot, ...(config.sourceRoots ?? [])].map(path => resolve(path));
  const inside = (base, value) => { const part = relative(base, value); return part !== '..' && !part.startsWith('../') && !isAbsolute(part); };
  const root = roots.find(root => {
    if (inside(root, target)) return true;
    try { return inside(realpathSync(root), target); } catch { return false; }
  });
  if (!root) throw new Error('This file belongs to another profile.');
  let existing = target;
  while (!existsSync(existing) && existing !== dirname(existing)) existing = dirname(existing);
  if (!inside(realpathSync(root), realpathSync(existing))) throw new Error('This file points outside the profile.');
}
export function loadConfig(path = defaultConfigPath(), overrides = {}) {
  path = expandPath(path);
  const input = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Configuration must be a JSON object');
  const base = dirname(dirname(path));
  const agentDir = expandPath(overrides.agentDir ?? getAgentDir(), base);
  const merged = SettingsManager.create(base, agentDir, { projectTrusted: true }).getSettings();
  const raw = { ...merged.claraSubconscious, ...input.claraSubconscious, ...overrides };
  let dataDir = expandPath(raw.dataDir ?? './subconscious', base);
  // Existing symlink aliases must share a coordinator.
  if (existsSync(dataDir)) dataDir = realpathSync(dataDir);
  const config = {
    configPath: path, dataDir,
    workspace: base,
    agentDir,
    profileRoot: base, sourceRoots: [],
    ...(overrides.sessionFactoryModule ? { sessionFactoryModule: expandPath(overrides.sessionFactoryModule, base) } : {}),
    initiallyPaused: raw.initiallyPaused === true,
    errorRetryMs: raw.errorRetryMs ?? 30000,
    heartbeatMs: raw.heartbeatMs ?? 3000,
    staleClientMs: raw.staleClientMs ?? 15000,
    model: raw.model ?? null,
    allowedTools: raw.allowedTools ?? DEFAULT_TOOLS,
    additionalExtensionPaths: [],
  };
  assertProfilePath(config, dataDir);
  for (const key of ['errorRetryMs', 'heartbeatMs', 'staleClientMs']) {
    if (!Number.isFinite(config[key]) || config[key] < 0) throw new Error(`${key} must be a nonnegative finite number`);
  }
  if (config.heartbeatMs < 100 || config.staleClientMs < config.heartbeatMs * 2) throw new Error('staleClientMs must allow at least two heartbeats (heartbeatMs >= 100)');
  if (!Array.isArray(config.allowedTools) || config.allowedTools.some(t => typeof t !== 'string' || !/^[\w.-]+$/.test(t))) throw new Error('allowedTools must contain exact tool names, without wildcards');
  if (config.allowedTools.some(t => FORBIDDEN_TOOLS.has(t) && !guardedMutation(config, t))) throw new Error('Shell, unguarded mutation, discovery wrappers, and delegation tools cannot be allowed');
  if (config.model !== null && (typeof config.model?.provider !== 'string' || typeof config.model?.id !== 'string' || !config.model.provider || !config.model.id)) throw new Error('model must be null or {provider, id}');
  config.storeId = createHash('sha256').update(dataDir).digest('hex');
  config.socketPath = process.platform === 'win32'
    ? `\\\\.\\pipe\\pi-subconscious-${config.storeId.slice(0, 24)}`
    : join(dataDir, 'service.sock');
  if (process.platform !== 'win32' && Buffer.byteLength(config.socketPath) > 100) throw new Error('dataDir is too long for a local socket; choose a shorter path');
  return config;
}

export function allowedTool(config, name, definitions = []) {
  if (FORBIDDEN_TOOLS.has(name) && !guardedMutation(config, name)) return false;
  if (![...INTERNAL_TOOLS, ...config.allowedTools].includes(name)) return false;
  // General wrappers can reach unapproved services without emitting nested calls.
  const tool = definitions.find(t => t.name === name);
  return !tool?.reachesTools;
}
