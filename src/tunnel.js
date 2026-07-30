import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { waitForChild, RemoteProcessError } from './ssh.js';

function stateDirectory() {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'user';
  return path.join(os.tmpdir(), `docker-remote-${uid}`);
}

export function controlSocket(target, key) {
  const digest = crypto.createHash('sha256').update(`${target}\0${key}`).digest('hex').slice(0, 20);
  return path.join(stateDirectory(), `${digest}.sock`);
}

export function formatForward(forward) {
  return `${forward.localHost}:${forward.localPort}:${forward.remoteHost}:${forward.remotePort}`;
}

export class TunnelManager {
  constructor(client, key) {
    this.client = client;
    this.socket = controlSocket(client.target, key);
  }

  exists() {
    return fs.existsSync(this.socket);
  }

  async stop({ quiet = false } = {}) {
    if (!this.exists()) return false;
    const args = [
      ...this.client.connectionArgs(),
      '-S',
      this.socket,
      '-O',
      'exit',
      this.client.target,
    ];
    const child = this.client.spawn(this.client.sshCommand, args, {
      stdio: quiet ? 'ignore' : ['ignore', 'inherit', 'inherit'],
      env: process.env,
    });
    const result = await waitForChild(child);
    try {
      if (fs.existsSync(this.socket)) fs.unlinkSync(this.socket);
    } catch {
      // A stale control socket should not make cleanup fail.
    }
    return result.code === 0;
  }

  async start(forwards) {
    if (forwards.length === 0) return;
    fs.mkdirSync(path.dirname(this.socket), { recursive: true, mode: 0o700 });
    await this.stop({ quiet: true });
    const args = [
      ...this.client.connectionArgs(),
      '-M',
      '-S',
      this.socket,
      '-f',
      '-N',
      '-o',
      'ExitOnForwardFailure=yes',
    ];
    for (const forward of forwards) args.push('-L', formatForward(forward));
    args.push(this.client.target);
    const child = this.client.spawn(this.client.sshCommand, args, {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: process.env,
    });
    const result = await waitForChild(child);
    if (result.code !== 0) {
      throw new RemoteProcessError(`SSH port forwarding failed with exit code ${result.code}`, result.code);
    }
  }
}
