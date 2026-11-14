import { randomUUID } from 'node:crypto';
import { Type } from 'typebox';
import { Client } from './client.js';
import { loadConfig } from './config.js';
import { identityEntries, deliveredIds } from './sessions.js';
import { toolResult, PRIVATE_MARKER, RETURN_TYPE } from './private-extension.js';

export default function subconsciousExtension(pi) {
  let client, ctx, timer, clientId, running = false, entering = 0, disabled = false, lastWarning;
  const warn = error => {
    const message = error.message ?? String(error);
    if (message !== lastWarning) ctx?.ui.notify(`Subconscious: ${message}`, 'warning');
    lastWarning = message;
  };
  const registration = (context = ctx, busy = running) => ({ id: clientId, pid: process.pid, busy, file: context.sessionManager.getSessionFile() ?? '', sessionId: context.sessionManager.getSessionId(), identityEntries: identityEntries(context.sessionManager.getBranch()) });
  async function update(busy = running) {
    if (disabled || !client || !ctx) return;
    await client.call('foreground.update', registration(ctx, busy));
    lastWarning = undefined;
  }
  async function enter(context) {
    if (disabled || !client) return;
    ctx = context; running = true;
    entering++;
    try {
      await client.ensure();
      await client.call('foreground.enter', registration(context, true), { timeout: 0, signal: context.signal });
    } finally { entering--; }
  }
  async function stop() {
    clearInterval(timer); timer = undefined;
    if (client && clientId && !disabled) {
      try { await client.call('foreground.leave', { id: clientId }); } catch { /* Service recovery re-registers live sessions. */ }
    }
    ctx = undefined; client = undefined;
  }
  pi.on('session_start', async (_event, context) => {
    disabled = context.sessionManager.getEntries().some(entry => entry.type === 'custom' && entry.customType === PRIVATE_MARKER);
    if (disabled) return;
    ctx = context; clientId = randomUUID(); running = !context.isIdle();
    client = new Client(loadConfig(pi.getSettings().claraSubconscious?.configPath));
    try { await client.ensure(); await update(); } catch (error) { warn(error); }
    timer = setInterval(() => {
      // Also clears an input claim handled by another extension without a run.
      running = entering > 0 || !ctx.isIdle();
      void update(running).catch(warn);
    }, client.config.heartbeatMs);
    timer.unref?.();
  });
  pi.on('input', async (_event, context) => {
    try { await enter(context); } catch (error) { warn(error); }
    return { action: 'continue' };
  });
  pi.on('before_agent_start', async (_event, context) => {
    if (disabled || !client) return;
    try {
      await enter(context);
      const known = deliveredIds(context.sessionManager);
      const deliveries = (await client.call('deliveries', { clientId })).filter(item => !known.has(item.id));
      if (deliveries.length) return { message: {
        customType: RETURN_TYPE, display: false,
        content: 'Selected reflections from your own private thinking. These are internal context, not new user messages:\n\n' + deliveries.map(item => item.content).join('\n\n'),
        details: { deliveryIds: deliveries.map(item => item.id) },
      } };
    } catch (error) { warn(error); }
  });
  pi.on('before_provider_request', async (_event, context) => {
    if (disabled || !client) return;
    try {
      await enter(context);
      // The before_agent_start custom entry has now been persisted by Pi.
      // The service verifies the actual file before marking deliveries received.
      await client.call('deliveries', { clientId });
    } catch (error) { warn(error); }
  });
  pi.on('agent_settled', async (_event, context) => {
    if (disabled || !client) return;
    ctx = context; running = false;
    try { await update(false); await client.call('deliveries', { clientId }); } catch (error) { warn(error); }
  });
  pi.on('session_compact', async (_event, context) => {
    if (disabled || !client) return;
    running = !context.isIdle();
    try { await update(); } catch (error) { warn(error); }
  });
  pi.on('session_before_compact', async (_event, context) => {
    try { await enter(context); } catch (error) { warn(error); }
  });
  pi.on('session_compact_failed', async (_event, context) => {
    if (disabled || !client) return;
    running = !context.isIdle();
    try { await update(); } catch (error) { warn(error); }
  });
  pi.on('session_shutdown', stop);

  pi.registerTool({
    name: 'subconscious_reflect', label: 'Private reflection', executionMode: 'sequential',
    description: 'Set a thought aside in its own private Pi conversation. The runtime binds it to this exact chat. Only a successful receipt means it was saved.',
    parameters: Type.Object({ content: Type.String({ minLength: 1 }) }),
    async execute(callId, _args, _signal, _update, context) {
      if (disabled) throw new Error('Private reflection creation is a foreground tool');
      await enter(context);
      return toolResult(await client.call('reflection.create', { clientId, callId }));
    },
  });
  pi.registerCommand('subconscious', {
    description: 'Private thinking: status, pause, resume, list, read <id>, topic <JSON>, actions, resolve <JSON>, notifications',
    async handler(args, context) {
      if (disabled || !client) return;
      const [command = 'status', ...tail] = args.trim().split(/\s+/);
      const value = tail.join(' ');
      await client.ensure();
      let result;
      if (command === 'pause' || command === 'resume') result = await client.call('pause', { paused: command === 'pause' });
      else if (command === 'read') result = await client.call('read', { id: tail[0], offset: Number(tail[1] ?? 0) });
      else if (command === 'topic' || command === 'resolve') result = await client.call(command, JSON.parse(value));
      else if (['status', 'list', 'actions', 'notifications'].includes(command)) result = await client.call(command);
      else throw new Error('Use status, pause, resume, list, read <id>, topic <JSON>, actions, resolve <JSON>, or notifications');
      pi.sendMessage({ customType: 'pi-clara-subconscious:inspection', content: JSON.stringify(result, null, 2), display: true }, { triggerTurn: false });
    },
  });
}
