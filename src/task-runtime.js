import { TASK_MARKER } from './config.js';

export default function scheduledTask(pi) {
  pi.registerFlag('scheduled-task', { description: 'Scheduled task definition path', type: 'string' });
  let token;
  const release = ctx => { if (token) { ctx.ui.notify('pi-task:release:' + token, 'info'); token = undefined; } };
  pi.on('session_start', (_event, ctx) => {
    if (!ctx.sessionManager.getEntries().some(entry => entry.type === 'custom' && entry.customType === TASK_MARKER)) pi.appendEntry(TASK_MARKER, { file: pi.getFlag('scheduled-task') });
    pi.setActiveTools(pi.getActiveTools().filter(name => !['subconscious_reflect', 'run_task'].includes(name)));
  });
  pi.on('turn_start', async (_event, ctx) => {
    try {
      token = await ctx.ui.input('pi-task:enter:turn');
      if (!token) throw new Error('The scheduler stopped.');
    } catch (error) { ctx.abort(); throw error; }
  });
  pi.on('turn_end', (_event, ctx) => release(ctx));
  pi.on('agent_settled', (_event, ctx) => release(ctx));
  pi.on('session_shutdown', (_event, ctx) => release(ctx));
  pi.registerCommand('task-run', { description: 'Run the scheduled prompt in this task’s conversation', handler: text => {
    const { prompt, owner } = JSON.parse(text);
    pi.sendMessage({ customType: TASK_MARKER, display: false,
      content: `Scheduled task ${owner.task} belongs to ${owner.id}. Its source directory is ${owner.cwd}; resolve that user’s task inputs and daily logs there.\n\n${prompt}`, details: { owner } }, { triggerTurn: true });
  } });
}
