import { request } from 'node:http';
import { spawn } from 'node:child_process';
import { openSync, closeSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';

export class Client {
  constructor(config) { this.config = typeof config === 'string' || config === undefined ? loadConfig(config) : config; }
  call(method, params = {}, options = {}) {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({ method, params });
      const req = request({ socketPath: this.config.socketPath, path: '/', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, response => {
        let data = '';
        response.setEncoding('utf8');
        response.on('data', chunk => { data += chunk; });
        response.on('end', () => {
          try { const value = JSON.parse(data); value.error ? reject(new Error(value.error)) : resolve(value.result); }
          catch (error) { reject(error); }
        });
      });
      req.on('error', reject);
      if (options.timeout !== 0) req.setTimeout(options.timeout ?? 10000, () => req.destroy(new Error('Coordinator request timed out')));
      const abort = () => req.destroy(new Error('Request aborted'));
      options.signal?.addEventListener('abort', abort, { once: true });
      req.once('close', () => options.signal?.removeEventListener('abort', abort));
      if (options.signal?.aborted) abort();
      req.end(body);
    });
  }
  async ensure() {
    try { await this.call('ping'); return; }
    catch (error) { if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error; }
    if (!this.starting) this.starting = this.start().finally(() => { this.starting = null; });
    return this.starting;
  }
  async start() {
    mkdirSync(this.config.dataDir, { recursive: true, mode: 0o700 });
    const fd = openSync(join(this.config.dataDir, 'service.log'), 'a', 0o600);
    const executable = /^node(?:\.exe)?$/.test(basename(process.execPath)) ? process.execPath : 'node';
    const child = spawn(executable, [fileURLToPath(new URL('./cli.js', import.meta.url)), 'serve', '--config', this.config.configPath], { detached: true, stdio: ['ignore', fd, fd], cwd: this.config.workspace });
    closeSync(fd);
    child.unref();
    let spawnError;
    child.once('error', error => { spawnError = error; });
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      try { await this.call('ping', {}, { timeout: 1000 }); return; }
      catch (error) { if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error; }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('Coordinator did not start. Inspect the private service.log in dataDir.');
  }
  async connect() { await this.ensure(); return this; }
}
