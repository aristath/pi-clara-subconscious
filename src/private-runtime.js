import { randomUUID } from 'node:crypto';
import { Type } from 'typebox';
import { Client } from './client.js';
import { loadConfig, INTERNAL_TOOLS } from './config.js';
import { invocationKey } from './invocations.js';
import { toolResult, PRIVATE_MARKER } from './private-extension.js';

export default function privateRuntime(pi) {
  pi.registerFlag('subconscious-config', { description: 'Originating coordinator configuration', type: 'string' });
  pi.registerFlag('subconscious-id', { description: 'Private conversation identifier', type: 'string' });
  const held = new Map();
  let client, id, row, modelToken, finished = false, allowed;
  const call = (method, args = {}) => client.call(method, { id, ...args }, { timeout: 0 });
  const releaseModel = async () => { if (modelToken) { const token = modelToken; modelToken = undefined; await call('private.release', { token }); } };
  const register = (name, description, parameters) => pi.registerTool({ name, label: name, description, parameters, executionMode: 'sequential', async execute(callId, args, _signal, _update, ctx) {
    const result = await call('private.operation', { tool: name, args, key: invocationKey(ctx.sessionManager, callId), model: ctx.model });
    if (['subconscious_return', 'subconscious_finish'].includes(name)) finished = true;
    return toolResult(result);
  } });
  register('subconscious_source', 'Read the originating context of this reflection.', Type.Object({}));
  register('subconscious_return', 'Finish this reflection and return only the selected passage as private context to its originating chat.', Type.Object({ content: Type.String({ minLength: 1 }) }));
  register('subconscious_finish', 'Finish this private reflection silently.', Type.Object({}));
  register('subconscious_start_chat', 'Start a separate user-facing conversation with a selected opening message.', Type.Object({ title: Type.String(), message: Type.String() }));
  register('subconscious_chats', 'List the originating user’s ordinary conversations or read one by its returned ID.', Type.Object({ action: Type.Union([Type.Literal('list'), Type.Literal('read')]), id: Type.Optional(Type.String()), offset: Type.Optional(Type.Integer()), limit: Type.Optional(Type.Integer()) }));
  pi.on('session_start', async (_event, ctx) => {
    id = pi.getFlag('subconscious-id');
    client = new Client(loadConfig(pi.getFlag('subconscious-config')));
    row = await call('private.row');
    if (!ctx.sessionManager.getEntries().some(entry => entry.type === 'custom' && entry.customType === PRIVATE_MARKER)) throw new Error('Private session marker missing.');
    allowed = new Set(pi.getSettings().subconscious?.allowedTools ?? pi.getActiveTools());
    allowed.delete('subconscious_reflect');
    for (const name of INTERNAL_TOOLS) allowed.add(name);
    pi.setActiveTools([...allowed]);
  });
  pi.on('before_agent_start', () => {
    allowed = new Set(pi.getSettings().subconscious?.allowedTools ?? pi.getActiveTools());
    allowed.delete('subconscious_reflect'); for (const name of INTERNAL_TOOLS) allowed.add(name); pi.setActiveTools([...allowed]);
    return { message: { customType: 'pi-subconscious:instructions', display: false,
    content: 'This is your private thinking, not a message from a user. Keep your existing identity. Follow the thought in this private conversation until you decide it is finished. Use subconscious_return for a selected contribution, or subconscious_finish to end silently. Starting a user-facing chat is a separate, explicit action.\n\nOriginal thought: ' + row.content } };
  });
  pi.on('before_provider_request', async (event, ctx) => {
    await releaseModel(); modelToken = randomUUID();
    await call('private.enter', { token: modelToken, kind: 'model', payload: event.payload, model: { provider: ctx.model.provider, id: ctx.model.id } });
  });
  pi.on('message_end', async event => { if (event.message.role === 'assistant') await releaseModel(); });
  pi.on('session_compact', releaseModel);
  pi.on('session_compact_failed', releaseModel);
  pi.on('tool_call', async (event, ctx) => {
    await releaseModel();
    if (!allowed.has(event.toolName) || event.parentToolCallId) return { block: true, reason: 'This tool is unavailable in this private session.' };
    const key = invocationKey(ctx.sessionManager, event.toolCallId);
    try { await call('private.enter', { token: key, kind: 'tool', tool: event.toolName, args: event.input, callId: event.toolCallId, sessionId: ctx.sessionManager.getSessionId() }); held.set(event.toolCallId, key); }
    catch (error) { return { block: true, reason: error.message }; }
  });
  pi.on('tool_execution_end', async event => {
    const token = held.get(event.toolCallId); if (!token) return;
    held.delete(event.toolCallId);
    await call('private.complete', { token, result: { role: 'toolResult', toolCallId: event.toolCallId, toolName: event.toolName, ...event.result, isError: event.isError, timestamp: Date.now() } });
  });
  pi.on('turn_end', async (_event, ctx) => { await releaseModel(); if (finished) void ctx.abort(); });
  pi.on('agent_settled', releaseModel);
  pi.on('session_shutdown', async () => { await releaseModel(); for (const token of held.values()) await call('private.release', { token }); });
  pi.registerCommand('subconscious-step', { description: 'Continue this private conversation', handler: async text => {
    const { wakeId, content } = JSON.parse(text);
    pi.sendMessage({ customType: 'pi-subconscious:wake', content: 'Continue your private reflection. Original thought:\n' + content, display: false, details: { wakeId } }, { triggerTurn: true });
  } });
}
