import { randomUUID } from 'node:crypto';
import { TASK_MARKER } from './config.js';

export default function scheduledTask(pi) {
  pi.registerFlag('scheduled-task', { description: 'Scheduled task definition path', type: 'string' });
  let token;
  const release = ctx => { if (token) { ctx.ui.notify('pi-task:release:' + token, 'info'); token = undefined; } };
  pi.on('session_start', (_event, ctx) => {
    if (!ctx.sessionManager.getEntries().some(entry => entry.type === 'custom' && entry.customType === TASK_MARKER)) pi.appendEntry(TASK_MARKER, { file: pi.getFlag('scheduled-task') });
    pi.setActiveTools(pi.getActiveTools().filter(name => name !== 'subconscious_reflect'));
  });
  pi.on('before_provider_request', async (_event, ctx) => { release(ctx); token = await ctx.ui.input('pi-task:enter:model'); if (!token) throw new Error('The scheduler stopped.'); });
  pi.on('message_end', (event, ctx) => { if (event.message.role === 'assistant') release(ctx); });
  pi.on('session_compact', (_event, ctx) => release(ctx));
  pi.on('session_compact_failed', (_event, ctx) => release(ctx));
  const tools = new Map();
  pi.on('tool_call', async (event, ctx) => {
    release(ctx);
    const held = await ctx.ui.input('pi-task:enter:tool');
    if (!held) return { block: true, reason: 'The scheduler stopped.' };
    tools.set(event.toolCallId, held);
  });
  pi.on('tool_execution_end', (event, ctx) => { const held = tools.get(event.toolCallId); if (held) { tools.delete(event.toolCallId); ctx.ui.notify('pi-task:release:' + held, 'info'); } });
  pi.on('agent_settled', (_event, ctx) => release(ctx));
  pi.on('session_shutdown', (_event, ctx) => { release(ctx); for (const held of tools.values()) ctx.ui.notify('pi-task:release:' + held, 'info'); });
  pi.registerCommand('task-run', { description: 'Run the scheduled prompt in this task’s conversation', handler: text => {
    const { prompt, owner } = JSON.parse(text);
    pi.sendMessage({ customType: TASK_MARKER, display: false,
      content: `Scheduled task ${owner.task} belongs to ${owner.id}. Its source directory is ${owner.cwd}; resolve that user’s task inputs and daily logs there.\n\n${prompt}`, details: { owner } }, { triggerTurn: true });
  } });
}
