import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { StateStore, sessionId } from './state.js';
import { ensureAgentRunning } from './supervisor.js';

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
  constructor(client, key, {
    store = new StateStore(),
    ensureAgent = ensureAgentRunning,
    label = key,
    readyTimeoutMs = 12_000,
  } = {}) {
    this.client = client;
    this.key = key;
    this.id = sessionId(client.target, key);
    this.label = label;
    this.store = store;
    this.ensureAgent = ensureAgent;
    this.readyTimeoutMs = readyTimeoutMs;
    this.socket = controlSocket(client.target, key);
  }

  exists() {
    return Boolean(this.store.read().sessions[this.id]?.desired);
  }

  async stop({ quiet = false } = {}) {
    void quiet;
    return this.store.removeSession(this.id);
  }

  async start(forwards) {
    if (forwards.length === 0) return;
    await this.store.upsertSession({
      id: this.id,
      key: this.key,
      label: this.label,
      target: this.client.target,
      connection: {
        identity: this.client.identity,
        sshOptions: [...this.client.sshOptions],
        sshCommand: this.client.sshCommand,
      },
      forwards,
    });
    await this.ensureAgent({ store: this.store });

    const deadline = Date.now() + this.readyTimeoutMs;
    let lastRuntime;
    while (Date.now() < deadline) {
      const session = this.store.read().sessions[this.id];
      if (!session) throw new Error('port-forwarding session was removed before it started');
      lastRuntime = session.runtime;
      if (lastRuntime?.status === 'active') return;
      await delay(50);
    }
    const details = lastRuntime?.lastError ? `: ${lastRuntime.lastError}` : '';
    throw new Error(`timed out starting SSH port forwarding${details}`);
  }
}
