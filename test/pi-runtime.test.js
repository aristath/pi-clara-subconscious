import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { Type } from 'typebox';
import { createAgentSession, SessionManager, ProjectTrustStore } from '@earendil-works/pi-coding-agent';
import { Coordinator } from '../src/service.js';
import { Store } from '../src/store.js';
import { originContext, identityEntries } from '../src/sessions.js';
import { PRIVATE_MARKER } from '../src/private-extension.js';
import { fixture, sdkFactory, fakeStream, deferred, output, call } from './helpers.js';

test('real Pi sessions yield between generation and pending tools without cancelling or losing calls', async t => {
  const { config, root } = fixture(t);
  const path = join(root, 'fiction.txt'); writeFileSync(path, 'A fictional note.');
  const entered = deferred(), finish = deferred(); let generations = 0;
  const coordinator = new Coordinator(config, { createSession: sdkFactory(async ({ options }) => {
    generations++; entered.resolve(); await finish.promise;
    assert.equal(options.signal.aborted, false);
    return output([call('read', { path }, 'read-note'), call('subconscious_chats', { action: 'list' }, 'list-chats')]);
  }) });
  t.after(() => coordinator.stop());
  const work = coordinator.tick(); await entered.promise;
  const foreground = coordinator.gate.foreground('foreground', { pid: process.pid });
  finish.resolve(); await foreground;
  assert.equal(generations, 1);
  assert.equal(Object.keys(coordinator.store.state.actions).length, 0);
  coordinator.gate.update('foreground', { pid: process.pid, busy: false });
  await work;
  const row = coordinator.store.row('sample-reflection');
  assert.equal(row.nextWake, row.lastStep);
  const messages = SessionManager.open(row.sessionFile).buildSessionContext().messages;
  assert.equal(messages.filter(message => message.role === 'toolResult').length, 2);
  assert.match(messages.find(message => message.role === 'toolResult' && message.toolCallId === 'read-note').content[0].text, /fictional note/);
  assert.equal(Object.values(coordinator.store.state.actions).every(action => action.status === 'completed'), true);
});

test('pause lets an executing tool finish, then keeps the conversation and schedule', async t => {
  const f = fixture(t, { allowedTools: ['synthetic_wait'] });
  const entered = deferred(), finish = deferred(); let calls = 0;
  const coordinator = new Coordinator(f.config, { createSession: async options => {
    const result = await createAgentSession({ ...options, customTools: [{ name: 'synthetic_wait', label: 'Synthetic wait', description: 'Controlled fixture', parameters: Type.Object({}), execute: async () => { calls++; entered.resolve(); await finish.promise; return { content: [{ type: 'text', text: 'Completed once.' }] }; } }] });
    result.session.agent.streamFunction = fakeStream(() => output([call('synthetic_wait', {}, 'waiting-tool')]));
    return result;
  } });
  t.after(() => coordinator.stop());
  const work = coordinator.tick(); await entered.promise;
  const actions = await coordinator.call('actions');
  assert.equal(actions[0].active, true);
  assert.equal(actions[0].resolvable, false);
  await assert.rejects(coordinator.call('resolve', { key: actions[0].key, executed: false }), /still running/);
  await coordinator.call('pause', { paused: true });
  assert.equal(coordinator.gate.active.kind, 'tool');
  finish.resolve(); await work;
  assert.equal(calls, 1);
  assert.equal(await coordinator.tick(), false);
  assert.equal(coordinator.store.row('sample-reflection').status, 'active');
  assert.equal(new Store(f.config).state.paused, true);
});

test('inspection retains synthetic image content in native Pi tool results', async t => {
  const f = fixture(t, { allowedTools: ['synthetic_image'] });
  const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
  const coordinator = new Coordinator(f.config, { createSession: async options => {
    const result = await createAgentSession({ ...options, customTools: [{ name: 'synthetic_image', label: 'Synthetic image', description: 'Controlled media fixture', parameters: Type.Object({}), execute: async () => ({ content: [{ type: 'image', data: pixel, mimeType: 'image/png' }] }) }] });
    result.session.agent.streamFunction = fakeStream(() => output([call('synthetic_image', {}, 'image-call')]));
    return result;
  } });
  t.after(() => coordinator.stop());
  await coordinator.tick();
  const transcript = coordinator.inspect('sample-reflection', { limit: 100 });
  const image = transcript.entries.find(entry => entry.type === 'message' && entry.message.role === 'toolResult').message.content.find(part => part.type === 'image');
  assert.equal(image.mimeType, 'image/png'); assert.equal(image.data, pixel);
});

test('normal configured packages supply identity, memories, web, media and Presence without exposing shell/edit tools', async t => {
  const f = fixture(t, { allowedTools: ['save_memory', 'search_memory', 'web_search', 'generate_image', 'presence_write'] });
  const addon = join(f.root, 'synthetic-addon'); mkdirSync(addon);
  const record = join(f.root, 'effects.jsonl');
  writeFileSync(join(addon, 'package.json'), JSON.stringify({ name: 'synthetic-addon', type: 'module', pi: { extensions: ['./index.js'] } }));
  writeFileSync(join(addon, 'index.js'), `
    import { appendFileSync } from 'node:fs';
    import { Type } from 'typebox';
    export default function(pi) {
      pi.on('before_agent_start', () => ({systemPrompt: 'Synthetic shared SOUL identity.'}));
      for (const name of ['save_memory', 'search_memory', 'web_search', 'generate_image', 'presence_write']) pi.registerTool({name, label: name, description: 'Synthetic integration fixture', parameters: Type.Object({}), execute: async () => {
        appendFileSync(${JSON.stringify(record)}, JSON.stringify({name})+'\\n');
        return {content: [{type: 'text', text: 'Synthetic integration completed.'}]};
      }});
    }`);
  const settings = JSON.parse(readFileSync(join(f.agentDir, 'settings.json'), 'utf8'));
  writeFileSync(join(f.agentDir, 'settings.json'), JSON.stringify({ ...settings, packages: [addon] }));
  let prompt;
  const coordinator = new Coordinator(f.config, { createSession: sdkFactory(({ session, context }) => {
    prompt = context.messages.filter(message => message.role === 'system').map(message => message.content).join('\n');
    assert.equal(session.getActiveToolNames().includes('bash'), false);
    assert.equal(session.getActiveToolNames().includes('write'), false);
    return output(['save_memory', 'search_memory', 'web_search', 'generate_image', 'presence_write'].map((name, index) => call(name, {}, `integration-${index}`)));
  }) });
  t.after(() => coordinator.stop());
  await coordinator.tick();
  assert.match(prompt, /Synthetic shared SOUL identity/);
  assert.deepEqual(readFileSync(record, 'utf8').trim().split('\n').map(line => JSON.parse(line).name), ['save_memory', 'search_memory', 'web_search', 'generate_image', 'presence_write']);
  assert.equal(coordinator.missingTools.get('sample-reflection').length, 0);
});

test('forbidden and nested tool calls cannot execute even when another tool attempts them', async t => {
  const f = fixture(t, { allowedTools: ['synthetic_nested'] });
  const target = join(f.root, 'must-not-exist.txt');
  let nestedResult;
  const coordinator = new Coordinator(f.config, { createSession: async options => {
    const result = await createAgentSession({ ...options, customTools: [{ name: 'synthetic_nested', label: 'Synthetic nested', description: 'Test boundary', parameters: Type.Object({}), execute: async (_id, _args, _signal, _update, ctx) => {
      nestedResult = await ctx.executeTool('write', { path: target, content: 'Forbidden mutation' });
      return nestedResult;
    } }] });
    result.session.agent.streamFunction = fakeStream(() => output([call('bash', { command: 'false' }, 'forbidden-shell'), call('write', { path: target, content: 'Forbidden mutation' }, 'forbidden-write'), call('synthetic_nested', {}, 'nested-attempt')]));
    return result;
  } });
  t.after(() => coordinator.stop());
  await coordinator.tick();
  assert.equal(existsSync(target), false);
  assert.equal(nestedResult.isError, true);
  const row = coordinator.store.row('sample-reflection');
  const results = SessionManager.open(row.sessionFile).buildSessionContext().messages.filter(message => message.role === 'toolResult');
  assert.equal(results.length, 3);
  assert.equal(results.every(result => result.isError), true);
});

test('private model override and fallback use current Pi settings', async t => {
  const f = fixture(t);
  const seen = [];
  const coordinator = new Coordinator(f.config, { createSession: sdkFactory(({ model }) => { seen.push(model.id); return output([call('subconscious_chats', { action: 'list' })]); }) });
  t.after(() => coordinator.stop());
  await coordinator.tick();
  assert.equal(seen[0], 'default');
  const settings = JSON.parse(readFileSync(join(f.agentDir, 'settings.json'), 'utf8'));
  writeFileSync(join(f.agentDir, 'settings.json'), JSON.stringify({ ...settings, defaultModel: 'override' }));
  await coordinator.tick(); assert.equal(seen.at(-1), 'override');
  writeFileSync(join(f.agentDir, 'settings.json'), JSON.stringify(settings));
  await coordinator.stop();
  const overrideConfig = f.writeConfig({ model: { provider: 'synthetic', id: 'override' } });
  const overridden = new Coordinator(overrideConfig, { createSession: sdkFactory(({ model }) => { seen.push(model.id); return output([call('subconscious_chats', { action: 'list' })]); }) });
  t.after(() => overridden.stop());
  await overridden.tick();
  assert.equal(seen.at(-1), 'override');
  await overridden.stop();
  const fallback = new Coordinator(f.writeConfig({ model: null }), { createSession: sdkFactory(({ model }) => { seen.push(model.id); return output([call('subconscious_chats', { action: 'list' })]); }) });
  t.after(() => fallback.stop());
  await fallback.tick(); assert.equal(seen.at(-1), 'default');
});

test('provider tool IDs reused on later turns remain distinct logical invocations', async t => {
  const f = fixture(t);
  const coordinator = new Coordinator(f.config, { createSession: sdkFactory(() => output([call('subconscious_chats', { action: 'list' }, 'provider-reused-id')])) });
  t.after(() => coordinator.stop());
  await coordinator.tick(); await coordinator.tick();
  const results = SessionManager.open(coordinator.store.row('sample-reflection').sessionFile).buildSessionContext().messages.filter(message => message.role === 'toolResult');
  assert.equal(results.length, 2);
  assert.equal(results.every(result => !result.isError), true);
  assert.equal(Object.keys(coordinator.store.state.actions).length, 2);
});

test('previous-chat access covers profile chat folders and excludes private sessions', async t => {
  const f = fixture(t);
  const ordinary = SessionManager.create(f.workspace, join(f.workspace, 'sessions', 'project-a'));
  ordinary.appendSessionInfo('Fictional project chat'); ordinary.appendMessage({ role: 'user', content: [{ type: 'text', text: 'A fictional project question.' }], timestamp: Date.now() });
  const custom = join(f.workspace, 'sessions');
  const other = SessionManager.create(f.workspace, custom);
  other.appendSessionInfo('Fictional custom chat'); other.appendMessage({ role: 'user', content: [{ type: 'text', text: 'A fictional custom question.' }], timestamp: Date.now() });
  const hidden = SessionManager.create(f.workspace, join(f.workspace, 'sessions', 'project-b'));
  hidden.appendCustomEntry(PRIVATE_MARKER, { conversationId: 'synthetic-private' });
  hidden.appendMessage({ role: 'user', content: [{ type: 'text', text: 'A private synthetic instruction.' }], timestamp: Date.now() });
  const settings = JSON.parse(readFileSync(join(f.agentDir, 'settings.json'), 'utf8'));
  writeFileSync(join(f.agentDir, 'settings.json'), JSON.stringify({ ...settings, sessionDir: custom }));
  const coordinator = new Coordinator(f.config);
  t.after(() => coordinator.stop());
  const chats = await coordinator.chats({ action: 'list' });
  assert.deepEqual(chats.map(row => row.title).sort(), ['Fictional custom chat', 'Fictional project chat']);
  const transcript = await coordinator.chats({ action: 'read', id: chats.find(row => row.title === 'Fictional custom chat').id });
  assert.equal(transcript.messages[0].content[0].text, 'A fictional custom question.');
});

test('saved Pi project trust loads project packages/settings and does not change foreground cache warming', async t => {
  const f = fixture(t);
  const project = join(f.workspace, '.pi'); mkdirSync(project, { recursive: true });
  writeFileSync(join(project, 'settings.json'), JSON.stringify({ defaultModel: 'override' }));
  new ProjectTrustStore(f.agentDir).set(f.workspace, true);
  const settingsPath = join(f.agentDir, 'settings.json');
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  writeFileSync(settingsPath, JSON.stringify({ ...settings, cacheWarming: 'idle' }));
  let selected;
  const coordinator = new Coordinator(f.config, { createSession: sdkFactory(({ model, session }) => {
    selected = model.id;
    assert.equal(session.settingsManager.isProjectTrusted(), true);
    assert.equal(session.settingsManager.getCacheWarmingMode(), 'off');
    return output([call('subconscious_chats', { action: 'list' })]);
  }) });
  t.after(() => coordinator.stop());
  await coordinator.tick();
  assert.equal(selected, 'override');
  assert.equal(JSON.parse(readFileSync(settingsPath, 'utf8')).cacheWarming, 'idle');
});

test('native Pi compaction uses the same model gate and retains a persisted compaction entry', async t => {
  const f = fixture(t);
  const settingsPath = join(f.agentDir, 'settings.json');
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  writeFileSync(settingsPath, JSON.stringify({ ...settings, compaction: { enabled: false, keepRecentTokens: 64, reserveTokens: 128 } }));
  let requests = 0;
  const coordinator = new Coordinator(f.config, { createSession: sdkFactory(() => { requests++; return output(requests <= 3 ? 'A fictional conversation worth summarizing. '.repeat(100) : 'A synthetic compacted summary.'); }) });
  t.after(() => coordinator.stop());
  await coordinator.tick(); await coordinator.tick(); await coordinator.tick();
  const session = coordinator.sessions.sessions.get('sample-reflection');
  coordinator.gate.update('foreground', { pid: process.pid, busy: true });
  const compacting = session.compact();
  compacting.catch(() => {});
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(requests, 3);
  coordinator.gate.remove('foreground');
  await compacting;
  assert.ok(requests > 3);
  assert.equal(session.sessionManager.getEntries().some(entry => entry.type === 'compaction' && entry.summary.includes('synthetic compacted summary')), true);
});

test('reflections continue without schedules until explicit finish; private history retains thinking and tools', async t => {
  const f = fixture(t, { initialRestMs: 60000 });
  let turns = 0;
  const coordinator = new Coordinator(f.config, { createSession: sdkFactory(() => {
    turns++;
    return turns === 1 ? output([{ type: 'thinking', thinking: 'Synthetic private reasoning.' }, { type: 'text', text: 'Continue exploring.' }]) : output([call('subconscious_finish', {}, 'finish-reflection')]);
  }) });
  t.after(() => coordinator.stop());
  const thought = coordinator.store.reflect('A fictional thought.', { file: join(f.workspace, 'source.jsonl'), sessionId: 'synthetic-source', callId: 'synthetic-origin', context: [] }, 'thought');
  await coordinator.tick(); await coordinator.tick();
  assert.equal(turns, 2);
  assert.equal(coordinator.store.row(thought.id).status, 'finished');
  assert.equal(coordinator.store.state.deliveries[thought.id], undefined);
  const transcript = coordinator.inspect(thought.id, { limit: 100 });
  assert.equal(transcript.entries.some(entry => entry.type === 'message' && entry.message.role === 'assistant' && entry.message.content.some(part => part.type === 'thinking')), true);
  assert.equal(transcript.entries.some(entry => entry.type === 'message' && entry.message.role === 'toolResult'), true);
});

test('native private tools read the bound source, create a separate public chat, and return only selected context', async t => {
  const f = fixture(t, { initialRestMs: 60000 });
  const source = SessionManager.create(f.workspace, join(f.agentDir, 'sessions', 'source'));
  source.appendMessage({ role: 'user', content: [{ type: 'text', text: 'A fictional user question.' }], timestamp: Date.now() });
  source.appendMessage(output([call('subconscious_reflect', { content: 'A fictional private seed that should stay private.' }, 'source-invocation')]));
  const coordinator = new Coordinator(f.config, { createSession: sdkFactory(() => output([
    call('subconscious_source', {}, 'source-context'),
    call('subconscious_start_chat', { title: 'Fictional opening', message: 'A selected public greeting.' }, 'start-chat'),
    call('subconscious_return', { content: 'A selected private contribution.' }, 'return-thought'),
  ])) });
  t.after(() => coordinator.stop());
  const thought = coordinator.store.reflect('A fictional private seed that should stay private.', originContext(source, 'source-invocation'), 'reflection');
  await coordinator.tick();
  assert.equal(coordinator.store.row(thought.id).status, 'returned');
  const notification = (await coordinator.call('notifications'))[0];
  const publicChat = SessionManager.open(notification.file);
  assert.equal(publicChat.buildSessionContext().messages.at(-1).content[0].text, 'A selected public greeting.');
  assert.equal(JSON.stringify(publicChat.getEntries()).includes('fictional private seed'), false);
  assert.equal(publicChat.buildSessionContext().model.modelId, 'default');
  await coordinator.call('foreground.update', { id: 'source', pid: process.pid, file: source.getSessionFile(), sessionId: source.getSessionId(), busy: false });
  assert.deepEqual(await coordinator.call('deliveries', { clientId: 'source' }), [{ id: thought.id, content: 'A selected private contribution.' }]);
  const result = SessionManager.open(coordinator.store.row(thought.id).sessionFile).buildSessionContext().messages.find(message => message.role === 'toolResult' && message.toolCallId === 'source-context');
  assert.match(JSON.stringify(result.details), /fictional user question/);
});

test('known completed tool results are recovered; unknown side effects are isolated until explicitly resolved', async t => {
  const f = fixture(t, { initialRestMs: 60000 });
  const coordinator = new Coordinator(f.config);
  t.after(() => coordinator.stop());
  const row = coordinator.store.reflect('A synthetic recovery thought.', { file: join(f.workspace, 'source.jsonl'), sessionId: 'synthetic-source', callId: 'recovery', context: [] }, 'recovery');
  const manager = SessionManager.create(f.workspace, join(f.config.dataDir, 'sessions'));
  manager.appendCustomEntry(PRIVATE_MARKER, { conversationId: row.id });
  manager.appendMessage({ role: 'user', content: [{ type: 'text', text: 'Synthetic wake' }], timestamp: Date.now() });
  const assistantId = manager.appendMessage({ ...output([call('save_memory', {}, 'known'), call('generate_image', {}, 'unknown')]) });
  const known = `${manager.getSessionId()}:${assistantId}:known`, unknown = `${manager.getSessionId()}:${assistantId}:unknown`;
  coordinator.store.change(state => {
    coordinator.store.row(row.id).sessionFile = manager.getSessionFile();
    state.actions[known] = { status: 'completed', conversationId: row.id, name: 'save_memory', callId: 'known', result: { role: 'toolResult', toolCallId: 'known', toolName: 'save_memory', content: [{ type: 'text', text: 'Saved exactly once.' }], isError: false, timestamp: Date.now() } };
    state.actions[unknown] = { status: 'started', conversationId: row.id, name: 'generate_image', callId: 'unknown', args: {}, sessionId: manager.getSessionId() };
  });
  coordinator.sessions.recover();
  assert.match(coordinator.store.row(row.id).blocked, /Unknown outcome/);
  assert.equal(SessionManager.open(manager.getSessionFile()).buildSessionContext().messages.filter(message => message.role === 'toolResult' && message.toolCallId === 'known').length, 1);
  coordinator.sessions.recover();
  assert.equal(SessionManager.open(manager.getSessionFile()).buildSessionContext().messages.filter(message => message.role === 'toolResult' && message.toolCallId === 'known').length, 1);
  await coordinator.call('resolve', { key: unknown, executed: true, result: { content: [{ type: 'text', text: 'Observed synthetic media result.' }] } });
  coordinator.sessions.recover();
  assert.equal(coordinator.store.row(row.id).blocked, undefined);
  assert.equal(SessionManager.open(manager.getSessionFile()).buildSessionContext().messages.filter(message => message.role === 'toolResult').length, 2);
});

test('a missing committed transcript is preserved as unavailable and resumes when the same file returns', async t => {
  const f = fixture(t);
  const coordinator = new Coordinator(f.config, { createSession: sdkFactory(() => output([call('subconscious_chats', { action: 'list' })])) });
  t.after(() => coordinator.stop());
  await coordinator.tick();
  const row = coordinator.store.row('sample-reflection');
  const file = row.sessionFile, retained = `${file}.temporarily-unavailable`;
  await coordinator.sessions.close();
  renameSync(file, retained);
  await assert.rejects(coordinator.sessions.open(row), /temporarily unavailable/);
  assert.equal(existsSync(file), false);
  assert.equal(row.sessionFile, file);
  renameSync(retained, file);
  const session = await coordinator.sessions.open(row);
  assert.equal(session.sessionManager.getSessionId(), row.sessionId);
});

test('a persisted Pi result automatically settles a previously unknown tool outcome', async t => {
  const f = fixture(t, { initialRestMs: 60000 });
  const store = new Store(f.config);
  const row = store.reflect('Synthetic recovery thought.', { file: join(f.workspace, 'source.jsonl'), sessionId: 'synthetic', callId: 'create', context: [] }, 'create');
  const manager = SessionManager.create(f.workspace, join(f.config.dataDir, 'sessions'));
  manager.appendCustomEntry(PRIVATE_MARKER, { conversationId: row.id });
  manager.appendMessage({ role: 'user', content: [{ type: 'text', text: 'Synthetic wake' }], timestamp: Date.now() });
  const entry = manager.appendMessage(output([call('save_memory', {}, 'receipt-call')]));
  const key = `${manager.getSessionId()}:${entry}:receipt-call`;
  manager.appendMessage({ role: 'toolResult', toolCallId: 'receipt-call', toolName: 'save_memory', content: [{ type: 'text', text: 'Observed committed result.' }], isError: false, timestamp: Date.now() });
  store.change(state => {
    Object.assign(store.row(row.id), { sessionFile: manager.getSessionFile(), blocked: 'Unknown outcome', blockedAction: key });
    state.actions[key] = { status: 'started', conversationId: row.id, name: 'save_memory', callId: 'receipt-call' };
  });
  const coordinator = new Coordinator(f.config);
  t.after(() => coordinator.stop());
  assert.equal(coordinator.store.state.actions[key].status, 'completed');
  assert.equal(coordinator.store.row(row.id).blocked, undefined);
  assert.deepEqual(await coordinator.call('actions'), []);
});

test('a missing optional integration is reported while independent thinking remains usable', async t => {
  const f = fixture(t, { allowedTools: ['missing_optional_tool'] });
  const coordinator = new Coordinator(f.config, { createSession: sdkFactory(() => output('A fictional thought without the optional integration.')) });
  t.after(() => coordinator.stop());
  await coordinator.tick();
  assert.deepEqual(coordinator.missingTools.get('sample-reflection'), ['missing_optional_tool']);
  assert.equal(coordinator.store.row('sample-reflection').error, undefined);
});

test('modular identity inheritance resets foreground flags and preserves private flags on later steps', async t => {
  const f = fixture(t);
  const path = join(f.agentDir, 'settings.json'), settings = JSON.parse(readFileSync(path, 'utf8'));
  writeFileSync(path, JSON.stringify({ ...settings, modularSoul: { defaultSoul: 'fictional-default', souls: {} } }));
  let turns = 0;
  const coordinator = new Coordinator(f.config, { createSession: sdkFactory(({ session }) => {
    turns++;
    const current = identityEntries(session.sessionManager.getBranch()).at(-1);
    assert.equal(current.customType, 'pi-modular-soul:selection');
    assert.equal(current.data.soul, 'fictional-user');
    assert.deepEqual(current.data.modules, turns === 1 ? [] : ['private-notes']);
    if (turns === 1) session.sessionManager.appendCustomEntry('pi-modular-soul:selection', { version: 1, soul: 'fictional-user', modules: ['private-notes'] });
    return output([call('subconscious_chats', { action: 'list' })]);
  }) });
  t.after(() => coordinator.stop());
  coordinator.store.change(() => { coordinator.store.row('sample-reflection').source = { identityEntries: [{ customType: 'pi-modular-soul:selection', data: { version: 1, soul: 'fictional-user', modules: ['foreground-only'] } }] }; });
  await coordinator.tick(); await coordinator.tick();
  assert.equal(turns, 2);
  const manager = SessionManager.open(coordinator.store.row('sample-reflection').sessionFile);
  assert.deepEqual(identityEntries(manager.getBranch()).at(-1).data.modules, ['private-notes']);
});

test('modular configuration autoloads private defaults', async t => {
  const f = fixture(t);
  const path = join(f.agentDir, 'settings.json'), settings = JSON.parse(readFileSync(path, 'utf8'));
  writeFileSync(path, JSON.stringify({ ...settings, modularSoul: { defaultSoul: 'fictional-current', souls: {} } }));
  const coordinator = new Coordinator(f.config, { createSession: sdkFactory(({ session }) => {
    const entries = identityEntries(session.sessionManager.getBranch());
    assert.deepEqual(entries.at(-1).data, { version: 1, soul: 'fictional-current', modules: [] });
    return output([call('subconscious_chats', { action: 'list' })]);
  }) });
  t.after(() => coordinator.stop()); await coordinator.tick();
});
