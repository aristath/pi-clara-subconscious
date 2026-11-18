import { Type } from 'typebox';
import { allowedTool } from './config.js';
import { invocationKey } from './invocations.js';

const str = () => Type.String({ minLength: 1 });
const optional = () => Type.Optional(str());
export function toolResult(value) { return { content: [{ type: 'text', text: JSON.stringify(value) }], details: value }; }
export const PRIVATE_MARKER = 'pi-subconscious:private';
export const RETURN_TYPE = 'pi-subconscious:reflection';

export function createPrivateExtension(runtime, conversation) {
  return pi => {
    const { store, gate, config } = runtime;
    const held = new Map();
    const register = (name, description, parameters, execute) => pi.registerTool({
      name, label: name, description, parameters, executionMode: 'sequential',
      async execute(callId, args, _signal, _update, ctx) {
        const receipt = invocationKey(ctx.sessionManager, callId);
        return toolResult(await execute(args, receipt, ctx));
      },
    });
    register('subconscious_source', 'Read the originating context of this reflection. The source is selected by the runtime.', Type.Object({}), () => {
      const row = store.row(conversation.id);
      if (row.kind !== 'reflection') throw new Error('Only reflections have an originating chat');
      return row.source.context;
    });
    register('subconscious_return', 'Finish this reflection and return only the selected passage as context for the original chat’s next response. Does not send a user message.', Type.Object({ content: str() }),
      (args, receipt) => store.finish(conversation.id, args.content, receipt));
    register('subconscious_finish', 'Finish this private reflection silently. No result or explanation is required.', Type.Object({}),
      (_args, receipt) => store.finish(conversation.id, undefined, receipt));
    register('subconscious_start_chat', 'Start a separate user-facing Pi conversation with a selected opening message. Distinct from returning a private reflection.', Type.Object({ title: str(), message: str() }),
      (args, receipt, ctx) => runtime.startChat(args, receipt, ctx.model));
    register('subconscious_chats', 'List previous ordinary Pi conversations or read one by the ID returned by list. Private transcript contents are not published automatically.', Type.Object({ action: Type.Union([Type.Literal('list'), Type.Literal('read')]), id: optional(), offset: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }),
      args => runtime.chats(args));

    pi.on('before_agent_start', () => {
      const row = store.row(conversation.id);
      const unavailable = config.allowedTools.filter(name => !pi.getAllTools().some(tool => tool.name === name));
      runtime.missingTools.set(row.id, unavailable);
      return { message: {
        customType: 'pi-subconscious:instructions', display: false,
        content: [
          'This is your private thinking, not a message from a user. Keep your existing identity. You may explore without producing a useful conclusion or a report.',
          'Follow the thought in this private conversation until you decide it is finished. Use subconscious_return for a selected contribution, or subconscious_finish to end silently.',
          'Use only the tools available in this private session. Starting a user-facing chat is a separate, explicit action.',
          `Original thought: ${row.content}`,
          unavailable.length ? `Configured integrations currently unavailable: ${unavailable.join(', ')}. Continue with the tools that are available; do not claim unavailable actions occurred.` : '',
        ].filter(Boolean).join('\n\n'),
      } };
    });
    pi.on('session_start', () => {
      pi.setActiveTools(pi.getAllTools().filter(tool => allowedTool(config, tool.name, pi.getAllTools())).map(tool => tool.name));
    });
    pi.on('tool_call', async (event, ctx) => {
      try {
      if (!allowedTool(config, event.toolName, pi.getAllTools()) || event.parentToolCallId) {
        return { block: true, reason: 'This tool or nested/delegated execution is not allowed during private thinking.' };
      }
      const row = store.row(conversation.id);
      if (row.status !== 'active' || row.blocked) return { block: true, reason: 'This private conversation has finished or requires recovery.' };
      const key = invocationKey(ctx.sessionManager, event.toolCallId);
      const previous = store.state.actions[key];
      if (previous) {
        return { block: true, reason: 'This invocation already has a receipt. Inspect its recorded outcome instead of executing it again.' };
      }
      const release = await gate.privateStep('tool', key, ctx.signal ?? runtime.signal);
      held.set(event.toolCallId, { release, key });
      store.change(state => { state.actions[key] = { status: 'started', conversationId: row.id, name: event.toolName, args: event.input, callId: event.toolCallId, sessionId: ctx.sessionManager.getSessionId(), startedAt: Date.now() }; });
      } catch (error) {
        held.get(event.toolCallId)?.release(); held.delete(event.toolCallId);
        return { block: true, reason: error.message };
      }
    });
    pi.on('tool_execution_end', event => {
      const heldStep = held.get(event.toolCallId);
      if (!heldStep) return;
      try {
        const key = heldStep.key;
        store.change(state => {
          const action = state.actions[key];
          if (!action) throw new Error('Accepted tool receipt is unavailable');
          action.status = 'completed';
          action.result = { role: 'toolResult', toolCallId: event.toolCallId, toolName: event.toolName, content: event.result.content, details: event.result.details, isError: event.isError, timestamp: Date.now() };
        });
      } finally { held.delete(event.toolCallId); heldStep.release(); }
    });
    pi.on('session_shutdown', () => { for (const step of held.values()) step.release(); held.clear(); });
  };
}
