import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const rpcExtension = fileURLToPath(new URL('./rpc-extension.js', import.meta.url));
// Transport only: Pi owns settings, sessions, extensions and the agent loop.
export class PiProcess {
  constructor({ cwd = process.cwd(), command = 'pi', args = [], env = process.env, onEvent = () => {} } = {}) {
    this.pending = new Map(); this.onEvent = onEvent;
    this.child = spawn(command, ['--mode', 'rpc', ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let diagnostic = '';
    this.child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-4096); });
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on('line', line => {
      let event; try { event = JSON.parse(line); } catch { return; }
      if (event.type === 'response') {
        const pending = this.pending.get(event.id);
        if (pending) { this.pending.delete(event.id); event.success ? pending.resolve(event.data) : pending.reject(new Error(event.error)); }
      } else if (event.type === 'extension_ui_request' && event.method === 'notify' && event.message.startsWith('pi-rpc:')) {
        const reply = JSON.parse(event.message.slice(7)), pending = this.pending.get(reply.id);
        if (pending) { this.pending.delete(reply.id); reply.error ? pending.reject(new Error(reply.error)) : pending.resolve(reply.data); }
      } else this.onEvent(event);
    });
    const fail = error => { for (const p of this.pending.values()) p.reject(error); this.pending.clear(); };
    this.child.on('error', fail);
    this.exited = new Promise(resolve => this.child.once('exit', (code, signal) => { fail(new Error(`Pi exited (${signal ?? code}): ${diagnostic}`)); resolve(); }));
    this.child.stdin.on('error', fail);
  }
  send(data) { this.child.stdin.write(JSON.stringify(data) + '\n'); }
  request(type, data = {}) {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(JSON.stringify({ id, type, ...data }) + '\n', error => { if (error) { this.pending.delete(id); reject(error); } });
    });
  }
  async invoke(method, args = {}) {
    const { commands } = await this.request('get_commands');
    if (!commands.some(command => command.name === 'pi-command')) throw new Error('The native Pi command extension failed to load.');
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.request('prompt', { message: '/pi-command ' + JSON.stringify({ id, method, args }) }).catch(error => { this.pending.delete(id); reject(error); });
    });
  }
  async close() { this.child.stdin.end(); await this.exited; this.lines.close(); }
}
export async function piRequest(config, method, args = {}) {
  const peer = new PiProcess({ cwd: config.workspace ?? config.cwd, command: config.piCommand ?? 'pi',
    args: ['--no-session', '--no-extensions', '--offline', '--approve', '-e', rpcExtension],
    env: { ...process.env, ...(config.agentDir ? { PI_CODING_AGENT_DIR: config.agentDir } : {}) } });
  try { await peer.request('get_state'); return await peer.invoke(method, args); }
  finally { await peer.close(); }
}
