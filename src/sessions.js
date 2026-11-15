import { existsSync, openSync, closeSync, fsyncSync, realpathSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { SessionManager, createAgentSession, DefaultResourceLoader, SettingsManager, ProjectTrustStore, hasTrustRequiringProjectResources } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { createPrivateExtension, PRIVATE_MARKER, RETURN_TYPE } from './private-extension.js';
import { INTERNAL_TOOLS, expandPath } from './config.js';

export function syncSession(manager) {
  const path = manager.getSessionFile();
  if (path && existsSync(path)) { const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
}
function currentSettings(cwd, agentDir) {
  const manager = SettingsManager.create(cwd, agentDir);
  const savedTrust = new ProjectTrustStore(agentDir).get(cwd);
  manager.setProjectTrusted(savedTrust ?? (!hasTrustRequiringProjectResources(cwd) || manager.getDefaultProjectTrust() === 'always'));
  return manager;
}
function privateSettings(cwd, agentDir) {
  const file = currentSettings(cwd, agentDir);
  const values = { global: JSON.stringify({ ...file.getGlobalSettings(), cacheWarming: 'off' }), project: JSON.stringify(file.getProjectSettings()) };
  return SettingsManager.fromStorage({ withLock(scope, fn) { const next = fn(values[scope]); if (next !== undefined) values[scope] = next; } }, { projectTrusted: file.isProjectTrusted() });
}
export function sessionReference(manager) {
  return { file: realpathSync(manager.getSessionFile()), sessionId: manager.getSessionId() };
}
export function originContext(manager, callId) {
  const branch = manager.getBranch();
  const projection = manager.buildSessionProjection().entries;
  const index = projection.findLastIndex(entry => entry.messages.some(message => message.role === 'assistant' && message.content.some(part => part.type === 'toolCall' && part.id === callId && part.name === 'subconscious_reflect')));
  if (index < 0) throw new Error('The originating Pi tool invocation is unavailable');
  const entry = projection[index];
  const message = entry.messages.find(message => message.role === 'assistant' && message.content.some(part => part.type === 'toolCall' && part.id === callId));
  const call = message.content.find(part => part.type === 'toolCall' && part.id === callId);
  const preceding = projection.slice(0, index).flatMap(entry => entry.messages).filter(message => message.role !== 'system').slice(-2);
  return { ...sessionReference(manager), callId, entryId: entry.sourceEntry.id, cwd: manager.getCwd(), context: [...preceding, message], thought: call.arguments.content, identityEntries: identityEntries(branch) };
}
export function originPresent(manager, source) {
  // Compaction changes model context, not the existence of an originating
  // invocation. Inspect its active-branch record and any explicit context edit.
  const branch = manager.getBranch();
  const entry = branch.find(entry => entry.id === source.entryId);
  if (entry?.type !== 'message' || entry.message.role !== 'assistant') return false;
  const edit = branch.findLast(entry => entry.type === 'context_edit' && entry.targetId === source.entryId);
  const content = edit ? edit.replacement?.content : entry.message.content;
  return Array.isArray(content) && content.some(part => part.type === 'toolCall' && part.id === source.callId && part.name === 'subconscious_reflect' && part.arguments.content === source.thought);
}
export function identityEntries(branch) {
  const selected = branch.findLast(entry => entry.type === 'custom' && entry.customType === 'pi-modular-soul:selection')
    ?? branch.findLast(entry => entry.type === 'custom' && entry.customType === 'pi-souls:selection');
  return selected ? [{ customType: selected.customType, data: structuredClone(selected.data) }] : [];
}
function applyIdentity(manager, row, settings) {
  const identity = row.source?.identityEntries?.at(-1);
  if (settings.modularSoul || identity?.customType === 'pi-modular-soul:selection') {
    const current = manager.getBranch().findLast(entry => entry.type === 'custom' && entry.customType === 'pi-modular-soul:selection')?.data;
    const soul = identity?.customType === 'pi-modular-soul:selection' ? identity.data?.soul
      : identity?.data?.name && Object.hasOwn(settings.modularSoul?.souls ?? {}, identity.data.name) ? identity.data.name
        : current?.soul ?? settings.modularSoul?.defaultSoul;
    // A new private conversation inherits the identity, not foreground flags.
    // Once bound, preserve this conversation's own optional selections each turn.
    if (typeof soul === 'string' && current?.soul !== soul) manager.appendCustomEntry('pi-modular-soul:selection', { version: 1, soul, modules: [] });
    return;
  }
  const source = identity?.data;
  const soul = settings.modelSouls?.[`${settings.defaultProvider}/${settings.defaultModel}`] ?? settings.defaultSoul;
  const selection = source ?? (typeof soul === 'string' ? { version: 1, name: soul } : settings.modelSouls || identityEntries(manager.getBranch()).length ? { version: 1, name: null, disabled: true } : undefined);
  if (selection && JSON.stringify(identityEntries(manager.getBranch()).at(-1)?.data) !== JSON.stringify(selection)) manager.appendCustomEntry('pi-souls:selection', selection);
}
export function deliveredIds(manager) {
  return new Set(manager.getBranch().filter(entry => entry.type === 'custom_message' && entry.customType === RETURN_TYPE).flatMap(entry => entry.details?.deliveryIds ?? []));
}
export function sessionMatches(source) {
  if (!existsSync(source.file)) return false;
  return SessionManager.open(source.file).getSessionId() === source.sessionId;
}
export function assistantMessage(content, model) {
  if (!model?.api || !model?.provider || !model?.id) throw new Error('Pi model metadata is required for an assistant contribution');
  return { role: 'assistant', content: [{ type: 'text', text: content }], api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: Date.now() };
}

// Decorate Pi's stream, rather than replacing the model/runtime or agent loop.
// Pump independently: compaction can consume result() without iterating events.
export function gateStream(original, gate, id, serviceSignal, observe = () => {}) {
  return (model, context, options = {}) => {
    const output = createAssistantMessageEventStream();
    const observation = { queuedAt: Date.now(), model: { provider: model.provider, id: model.id }, context };
    observe(observation);
    void (async () => {
      let release;
      try {
        release = await gate.privateStep('model', id, options.signal ?? serviceSignal);
        observation.startedAt = Date.now();
        const stream = await original(model, context, options);
        for await (const event of stream) {
          if (event.type.endsWith('_delta') && !observation.firstOutputAt) observation.firstOutputAt = Date.now();
          output.push(event);
        }
        const result = await stream.result();
        observation.usage = result.usage; observation.stopReason = result.stopReason;
        output.end(result);
      } catch (error) {
        const message = { ...assistantMessage('', model), stopReason: options.signal?.aborted || serviceSignal?.aborted ? 'aborted' : 'error', errorMessage: error.message };
        observation.error = error.message;
        output.push({ type: 'error', reason: message.stopReason, error: message }); output.end(message);
      } finally { observation.finishedAt = Date.now(); release?.(); }
    })();
    return output;
  };
}

export class PiSessions {
  constructor(runtime, options = {}) { this.runtime = runtime; this.sessions = new Map(); this.observations = new Map(); this.createSession = options.createSession ?? createAgentSession; }
  inspect(id, includeContext = false) {
    const session = this.sessions.get(id);
    const observation = this.observations.get(id);
    const { context, ...request } = observation ?? {};
    return {
      streaming: session?.isStreaming ?? false,
      currentMessage: session?.agent.state.streamingMessage ?? null,
      pendingToolCalls: [...(session?.agent.state.pendingToolCalls ?? [])],
      contextUsage: session?.getContextUsage() ?? null,
      request: observation ? { ...request, messageCount: context?.messages?.length ?? 0 } : null,
      ...(includeContext ? { context: context ?? null } : {}),
    };
  }
  async open(row) {
    if (this.sessions.has(row.id)) return this.sessions.get(row.id);
    const { config, store } = this.runtime;
    const cwd = row.source?.cwd ?? config.workspace;
    let manager;
    if (row.sessionFile && existsSync(row.sessionFile)) {
      manager = SessionManager.open(row.sessionFile);
      if (row.sessionId && manager.getSessionId() !== row.sessionId || !manager.getEntries().some(entry => entry.type === 'custom' && entry.customType === PRIVATE_MARKER && entry.data?.conversationId === row.id)) throw new Error('Private transcript identity does not match; the existing file and accepted state were preserved');
    }
    else {
      if (row.transcriptCommitted || Object.values(store.state.actions).some(action => action.conversationId === row.id)) throw new Error('Private transcript is temporarily unavailable; accepted work was preserved');
      manager = row.sessionFile ? SessionManager.open(row.sessionFile) : SessionManager.create(cwd, join(config.dataDir, 'sessions'));
      manager.appendCustomEntry(PRIVATE_MARKER, { version: 1, storeId: config.storeId, conversationId: row.id, kind: row.kind });
      manager.appendSessionInfo(row.title);
      const settings = currentSettings(cwd, config.agentDir).getSettings();
      applyIdentity(manager, row, settings);
      store.change(() => { Object.assign(store.row(row.id), { sessionFile: manager.getSessionFile(), sessionId: manager.getSessionId() }); });
    }
    this.recoverTools(row, manager);
    if (store.row(row.id).blocked) throw new Error(store.row(row.id).blocked);
    const settingsManager = privateSettings(cwd, config.agentDir);
    const resourceLoader = new DefaultResourceLoader({
      cwd, agentDir: config.agentDir, additionalExtensionPaths: config.additionalExtensionPaths,
      settingsManager,
      extensionFactories: [{ name: 'pi-clara-subconscious-private', factory: createPrivateExtension(this.runtime, row) }],
    });
    await resourceLoader.reload();
    const result = await this.createSession({ cwd, agentDir: config.agentDir, sessionManager: manager, resourceLoader, settingsManager, tools: [...config.allowedTools, ...INTERNAL_TOOLS] });
    const { session } = result;
    if (result.extensionsResult?.errors?.some(error => error.path?.includes('pi-clara-subconscious-private'))) {
      session.dispose(); throw new Error('Private tool enforcement failed to load');
    }
    await this.selectModel(session, cwd);
    session.agent.toolExecution = 'sequential';
    session.agent.streamFunction = gateStream(session.agent.streamFunction, this.runtime.gate, row.id, this.runtime.signal, observation => this.observations.set(row.id, observation));
    // The public Agent boundary hook ends one native Pi turn (assistant + tool
    // batch). Pi still performs all execution, persistence, compaction and retry.
    const finishTurn = session.agent.finishTurn;
    session.agent.finishTurn = async (...args) => {
      await finishTurn?.(...args);
      const message = args[0].message;
      if (!['error', 'aborted'].includes(message.stopReason)) {
        syncSession(manager);
        store.change(() => { const current = store.row(row.id); current.transcriptCommitted = true; current.stepCompleted = { wakeId: current.wakeId, hasTools: message.content.some(part => part.type === 'toolCall'), completedAt: Date.now() }; });
      }
      return { action: 'end' };
    };
    await session.bindExtensions({ mode: 'rpc', onError: error => this.runtime.errors.set(row.id, error.error ?? String(error)) });
    this.sessions.set(row.id, session);
    return session;
  }
  recoverTools(row, manager) {
    const entries = manager.getBranch();
    const assistantIndex = entries.findLastIndex(entry => entry.type === 'message' && entry.message.role === 'assistant');
    if (assistantIndex < 0) return;
    const assistant = entries[assistantIndex];
    const results = new Map(entries.slice(assistantIndex + 1).filter(entry => entry.type === 'message' && entry.message.role === 'toolResult').map(entry => [entry.message.toolCallId, entry.message]));
    const calls = assistant.message.content.filter(part => part.type === 'toolCall');
    for (const call of calls) {
      const key = `${manager.getSessionId()}:${assistant.id}:${call.id}`;
      let action = this.runtime.store.state.actions[key];
      if (results.has(call.id)) {
        if (action?.status === 'started') this.runtime.store.change(state => { state.actions[key].status = 'completed'; state.actions[key].result = results.get(call.id); });
        continue;
      }
      if (action?.status === 'started' && call.name === 'subconscious_start_chat' && this.runtime.store.state.chatPlans[key]) {
        this.runtime.startChat(this.runtime.store.state.chatPlans[key], key, this.runtime.store.state.chatPlans[key].model);
      }
      // Package-owned operations commit their receipt with their state mutation.
      // They can be settled from that receipt without running any tool again.
      if (action?.status === 'started' && this.runtime.store.state.receipts[key] && INTERNAL_TOOLS.includes(call.name)) {
        this.runtime.store.change(state => {
          action = state.actions[key]; action.status = 'completed';
          action.result = { role: 'toolResult', toolCallId: call.id, toolName: call.name, content: [{ type: 'text', text: JSON.stringify(state.receipts[key]) }], details: state.receipts[key], isError: false, timestamp: Date.now() };
        });
      }
      if (action?.status === 'completed') manager.appendMessage(action.result);
      else if (action?.status === 'started') {
        if (INTERNAL_TOOLS.includes(call.name)) {
          manager.appendMessage({ role: 'toolResult', toolCallId: call.id, toolName: call.name, content: [{ type: 'text', text: 'This package transaction did not commit before shutdown. No change was accepted. You may request it again.' }], isError: true, timestamp: Date.now() });
          continue;
        }
        this.runtime.store.change(() => { Object.assign(this.runtime.store.row(row.id), { blocked: `Unknown outcome for ${call.name} (${call.id}). Inspect and resolve the action before continuing.`, blockedAction: key }); });
        return;
      } else {
        // Pi cannot resume an interrupted tool batch through a public API.
        // Settle never-admitted calls truthfully; the model can issue them anew.
        manager.appendMessage({ role: 'toolResult', toolCallId: call.id, toolName: call.name, content: [{ type: 'text', text: 'The service stopped before this call was admitted. It was not executed. Re-issue it if still wanted.' }], isError: true, timestamp: Date.now() });
      }
    }
    const current = this.runtime.store.row(row.id);
    if (current.blockedAction && this.runtime.store.state.actions[current.blockedAction]?.status === 'completed') {
      this.runtime.store.change(() => { delete current.blocked; delete current.blockedAction; current.nextWake = Date.now(); });
    }
    syncSession(manager);
  }
  async step(row) {
    const session = await this.open(row);
    applyIdentity(session.sessionManager, row, currentSettings(row.source?.cwd ?? this.runtime.config.workspace, this.runtime.config.agentDir).getSettings());
    await this.selectModel(session, row.source?.cwd ?? this.runtime.config.workspace);
    const wakeId = this.runtime.store.row(row.id).wakeId;
    await session.sendCustomMessage({ customType: 'pi-clara-subconscious:wake', content: row.kind === 'reflection' ? `Continue your private reflection. Original thought:\n${row.content}` : 'Continue your private time. The runtime has admitted this turn while foreground chats are idle.', display: false, details: { wakeId } }, { triggerTurn: true });
    syncSession(session.sessionManager);
    const last = session.messages.findLast(message => message.role === 'assistant');
    if (last?.stopReason === 'error' || last?.stopReason === 'aborted') throw new Error(last.errorMessage ?? 'Private generation failed');
    return { hasTools: last?.content.some(part => part.type === 'toolCall') ?? false };
  }
  async selectModel(session, cwd) {
    const { config } = this.runtime;
    const settings = currentSettings(cwd, config.agentDir);
    const provider = config.model?.provider ?? settings.getDefaultProvider();
    const id = config.model?.id ?? settings.getDefaultModel();
    if (provider && id) {
      const model = session.modelRuntime.getModel(provider, id);
      if (!model) throw new Error('The selected private/default model is not available in Pi');
      if (session.model?.provider !== provider || session.model?.id !== id) await session.setModel(model);
    }
  }
  recover() {
    for (const row of this.runtime.store.list()) {
      if (!row.sessionFile || !existsSync(row.sessionFile)) continue;
      try {
        const manager = SessionManager.open(row.sessionFile);
        this.recoverTools(row, manager);
        if (!row.inProgress || row.stepCompleted || this.runtime.store.row(row.id).blocked) continue;
        const branch = manager.getBranch();
        const wake = branch.findLastIndex(entry => entry.type === 'custom_message' && entry.customType === 'pi-clara-subconscious:wake' && entry.details?.wakeId === row.wakeId);
        const assistant = branch.slice(wake + 1).findLast(entry => entry.type === 'message' && entry.message.role === 'assistant');
        if (wake >= 0 && assistant && !['error', 'aborted'].includes(assistant.message.stopReason)) {
          this.runtime.store.change(() => { this.runtime.store.row(row.id).stepCompleted = { wakeId: row.wakeId, hasTools: assistant.message.content.some(part => part.type === 'toolCall'), completedAt: Date.parse(assistant.timestamp) }; });
        }
      } catch (error) { this.runtime.errors.set(row.id, error.message); }
    }
  }
  async close() {
    for (const session of this.sessions.values()) {
      try { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); }
      finally { session.dispose(); }
    }
    this.sessions.clear();
  }
  async chats(args) {
    const { config } = this.runtime;
    const root = join(config.agentDir, 'sessions');
    const dirs = new Set([root]);
    if (existsSync(root)) for (const dir of readdirSync(root, { withFileTypes: true })) if (dir.isDirectory() || dir.isSymbolicLink()) dirs.add(join(root, dir.name));
    const custom = SettingsManager.create(config.workspace, config.agentDir).getSessionDir();
    if (custom) dirs.add(expandPath(custom, config.workspace));
    const all = [...new Map((await Promise.all([...dirs].map(async dir => {
      try { return await SessionManager.listAll(dir); } catch (error) { this.runtime.errors.set(`chats:${dir}`, error.message); return []; }
    }))).flat().map(row => [row.path, row])).values()].sort((a, b) => new Date(b.modified) - new Date(a.modified));
    const rows = all.filter(row => {
      try { return !SessionManager.open(row.path).getEntries().some(entry => entry.type === 'custom' && entry.customType === PRIVATE_MARKER); } catch { return false; }
    });
    const key = path => createHash('sha256').update(path).digest('hex');
    if (args.action === 'list') return rows.slice(args.offset ?? 0, (args.offset ?? 0) + (args.limit ?? 30)).map(row => ({ id: key(row.path), title: row.name ?? row.firstMessage, modified: row.modified }));
    const row = rows.find(row => key(row.path) === args.id);
    if (!row) throw new Error('Conversation not found');
    const messages = SessionManager.open(row.path).buildSessionContext().messages;
    return { id: args.id, messages: messages.slice(args.offset ?? 0, (args.offset ?? 0) + (args.limit ?? 30)), total: messages.length };
  }
}
