import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '../src/client.js';
import { fixture, until } from './helpers.js';

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
test('the real detached daemon runs a native Pi session after its launching CLI exits', async t => {
  const f = fixture(t);
  const provider = join(f.root, 'synthetic-provider.js');
  const marker = join(f.root, 'provider-calls.jsonl');
  // A real Pi provider extension with a controlled stream. No HTTP or inference.
  writeFileSync(provider, `
    import { appendFileSync } from 'node:fs';
    import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
    export default function(pi) {
      pi.registerProvider('synthetic', {
        api: 'synthetic-api', apiKey: 'synthetic-test-value', baseUrl: 'https://synthetic.invalid',
        models: [{ id: 'default', name: 'Synthetic default', reasoning: false, input: ['text'], cost: {input:0,output:0,cacheRead:0,cacheWrite:0}, contextWindow: 262144, maxTokens: 4096 }],
        streamSimple(model, context) {
          appendFileSync(${JSON.stringify(marker)}, JSON.stringify({model:model.id})+'\\n');
          const stream = createAssistantMessageEventStream();
          const message = { role:'assistant', content:[{type:'toolCall',id:'rest-'+Date.now(),name:'subconscious_rest',arguments:{milliseconds:100}}],api:model.api,provider:model.provider,model:model.id,usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'toolUse',timestamp:Date.now() };
          queueMicrotask(() => { stream.push({type:'done',reason:'toolUse',message}); stream.end(message); });
          return stream;
        }
      });
    }`);
  rmSync(join(f.agentDir, 'models.json'));
  const settingsPath = join(f.agentDir, 'settings.json');
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  writeFileSync(settingsPath, JSON.stringify({ ...settings, extensions: [provider] }));
  const config = f.config;
  const client = new Client(config);
  t.after(async () => {
    try { await client.call('stop'); } catch { /* Child may already have stopped after a failed start. */ }
    await until(() => !existsSync(join(config.dataDir, 'service.lock')), 5000).catch(() => {});
  });
  const child = spawn(process.execPath, [cli, 'start', '--config', config.configPath, '--agent-dir', f.agentDir], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
  const code = await new Promise(resolve => child.once('exit', resolve));
  assert.equal(code, 0, stderr);
  assert.match(stdout, /Coordinator running/);
  const count = () => existsSync(marker) ? readFileSync(marker, 'utf8').trim().split('\n').length : 0;
  const atLauncherExit = count();
  await until(async () => count() > atLauncherExit && (await client.call('status')).conversations.find(row => row.id === 'general')?.lastRestMs === 100, 10000).catch(error => { throw new Error(`${error.message}\n${readFileSync(join(config.dataDir, 'service.log'), 'utf8')}`); });
  assert.equal((await client.call('status')).clients.length, 0);
  const list = await client.call('list');
  assert.equal(list[0].kind, 'general');
  const transcript = await client.call('read', { id: 'general' });
  assert.equal(transcript.entries.some(entry => entry.type === 'message' && entry.message.role === 'toolResult'), true);
  await client.call('pause', { paused: true });
  await until(async () => !(await client.call('status')).active);
  const pausedCount = count();
  await client.call('stop');
  await until(() => !existsSync(join(config.dataDir, 'service.lock')));
  await client.ensure();
  assert.equal((await client.call('status')).paused, true);
  assert.equal(count(), pausedCount);
});
