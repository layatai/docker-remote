import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

import { StateStore, isProcessAlive, sessionFingerprint } from './state.js';

const RECONCILE_INTERVAL_MS = 500;
const READY_AFTER_MS = 750;
const HEALTHY_AFTER_MS = 30_000;
const MAX_STDERR_BYTES = 8_192;
const TAKEOVER_WINDOW_MS = 15_000;
const TERMINATE_TIMEOUT_MS = 2_000;

function iso(timestamp) {
  return new Date(timestamp).toISOString();
}

export function restartDelay(attempt, random = Math.random) {
  const ceiling = Math.min(30_000, 500 * (2 ** Math.min(attempt, 6)));
  return Math.max(250, Math.floor(ceiling * (0.5 + random() * 0.5)));
}

function formatForward(forward) {
  return `${forward.localHost}:${forward.localPort}:${forward.remoteHost}:${forward.remotePort}`;
}

export function sshTunnelArgs(session) {
  const args = [];
  if (session.connection?.identity) args.push('-i', session.connection.identity);
  for (const option of session.connection?.sshOptions ?? []) args.push('-o', option);
  args.push(
    '-N',
    '-T',
    '-o',
    'ExitOnForwardFailure=yes',
    '-o',
    'ServerAliveInterval=10',
    '-o',
    'ServerAliveCountMax=3',
    '-o',
    'ConnectTimeout=10',
  );
  for (const forward of session.forwards) args.push('-L', formatForward(forward));
  args.push(session.target);
  return args;
}

function terminate(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill('SIGTERM');
  } catch {
    // A concurrent process exit already achieved the desired state.
  }
}

export class TunnelSupervisor {
  constructor({
    store = new StateStore(),
    spawnProcess = spawn,
    now = () => Date.now(),
    random = Math.random,
    logger = () => {},
    processAlive = isProcessAlive,
    killProcess = process.kill.bind(process),
  } = {}) {
    this.store = store;
    this.spawnProcess = spawnProcess;
    this.now = now;
    this.random = random;
    this.logger = logger;
    this.processAlive = processAlive;
    this.killProcess = killProcess;
    this.runners = new Map();
    this.stopping = false;
    this.leaseToken = null;
  }

  async reclaimOrphanedSessions(previousAgent) {
    const heartbeatAt = Date.parse(previousAgent?.heartbeatAt ?? '');
    if (
      !previousAgent?.token
      || this.processAlive(previousAgent.pid)
      || !Number.isFinite(heartbeatAt)
      || this.now() - heartbeatAt > TAKEOVER_WINDOW_MS
    ) {
      return;
    }

    const sessions = Object.values(this.store.read().sessions);
    for (const session of sessions) {
      const pid = session.runtime?.pid;
      if (
        session.runtime?.ownerToken !== previousAgent.token
        || !Number.isSafeInteger(pid)
        || pid <= 0
        || !this.processAlive(pid)
      ) {
        continue;
      }

      this.logger(`reclaiming orphaned tunnel ${session.id} (pid ${pid})`);
      try {
        this.killProcess(pid, 'SIGTERM');
      } catch (error) {
        if (error?.code !== 'ESRCH') throw error;
      }
      const deadline = this.now() + TERMINATE_TIMEOUT_MS;
      while (this.now() < deadline && this.processAlive(pid)) {
        await delay(50);
      }
      if (this.processAlive(pid)) {
        try {
          this.killProcess(pid, 'SIGKILL');
        } catch (error) {
          if (error?.code !== 'ESRCH') throw error;
        }
      }
      await this.store.setRuntime(session.id, {
        status: 'pending',
        pid: null,
        ownerToken: null,
        lastError: null,
        nextRetryAt: null,
      });
    }
  }

  async startSession(session) {
    const sshCommand = session.connection?.sshCommand || 'ssh';
    const child = this.spawnProcess(sshCommand, sshTunnelArgs(session), {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
      env: process.env,
    });
    const runner = {
      child,
      fingerprint: sessionFingerprint(session),
      startedAt: this.now(),
      ready: false,
      stderr: '',
      intentional: false,
    };
    this.runners.set(session.id, runner);
    this.logger(`starting ${session.id} (${session.target})`);

    child.stderr?.on('data', (chunk) => {
      runner.stderr = `${runner.stderr}${chunk.toString('utf8')}`.slice(-MAX_STDERR_BYTES);
    });
    child.once('spawn', () => {
      void this.store.setRuntime(session.id, {
        status: 'connecting',
        pid: child.pid ?? null,
        ownerToken: this.leaseToken,
        lastError: null,
        lastStartedAt: iso(runner.startedAt),
        nextRetryAt: null,
      });
    });
    child.once('error', (error) => {
      runner.stderr = error.message;
    });
    child.once('close', (code, signal) => {
      void this.handleExit(session.id, runner, code, signal);
    });
  }

  async handleExit(id, runner, code, signal) {
    if (this.runners.get(id) !== runner) return;
    this.runners.delete(id);
    if (runner.intentional || this.stopping) return;

    const state = this.store.read();
    const session = state.sessions[id];
    if (!session?.desired) return;
    const previousRestarts = session.runtime?.restartCount ?? 0;
    const stable = this.now() - runner.startedAt >= HEALTHY_AFTER_MS;
    const restartCount = stable ? 1 : previousRestarts + 1;
    const retryAt = this.now() + restartDelay(restartCount, this.random);
    const details = runner.stderr.trim();
    const reason = details
      || `ssh exited with ${signal ? `signal ${signal}` : `code ${code ?? 1}`}`;
    this.logger(`tunnel ${id} stopped: ${reason}`);
    await this.store.setRuntime(id, {
      status: 'reconnecting',
      pid: null,
      ownerToken: null,
      restartCount,
      lastError: reason,
      nextRetryAt: iso(retryAt),
    });
  }

  async reconcile() {
    const state = this.store.read();
    const now = this.now();
    for (const [id, runner] of this.runners) {
      const session = state.sessions[id];
      if (!session?.desired || runner.fingerprint !== sessionFingerprint(session)) {
        runner.intentional = true;
        this.runners.delete(id);
        terminate(runner.child);
      }
    }

    for (const session of Object.values(state.sessions)) {
      if (!session.desired) continue;
      const runner = this.runners.get(session.id);
      if (runner) {
        if (!runner.ready && now - runner.startedAt >= READY_AFTER_MS) {
          runner.ready = true;
          await this.store.setRuntime(session.id, {
            status: 'active',
            pid: runner.child.pid ?? null,
            restartCount: now - runner.startedAt >= HEALTHY_AFTER_MS
              ? 0
              : session.runtime?.restartCount ?? 0,
            lastHealthyAt: iso(now),
            nextRetryAt: null,
          });
        } else if (
          runner.ready
          && now - runner.startedAt >= HEALTHY_AFTER_MS
          && (session.runtime?.restartCount ?? 0) > 0
        ) {
          await this.store.setRuntime(session.id, {
            restartCount: 0,
            lastHealthyAt: iso(now),
          });
        }
        continue;
      }
      const nextRetryAt = session.runtime?.nextRetryAt
        ? Date.parse(session.runtime.nextRetryAt)
        : 0;
      if (Number.isFinite(nextRetryAt) && nextRetryAt > now) continue;
      await this.startSession(session);
    }
  }

  async shutdown() {
    this.stopping = true;
    const stopping = [];
    for (const [id, runner] of this.runners) {
      runner.intentional = true;
      terminate(runner.child);
      stopping.push(this.store.setRuntime(id, {
        status: 'stopped',
        pid: null,
        ownerToken: null,
        nextRetryAt: null,
      }));
    }
    this.runners.clear();
    await Promise.all(stopping);
  }

  async run({ signal } = {}) {
    const previousAgent = this.store.readAgent();
    const lease = this.store.acquireAgentLease();
    if (!lease) return false;
    this.leaseToken = lease.token;
    let heartbeat;
    let stop;

    try {
      await this.reclaimOrphanedSessions(previousAgent);
      const startedAt = iso(this.now());
      const writeHeartbeat = () => this.store.writeAgent({
        pid: process.pid,
        token: lease.token,
        startedAt,
        heartbeatAt: iso(this.now()),
      });
      writeHeartbeat();
      heartbeat = setInterval(writeHeartbeat, 2_000);
      heartbeat.unref?.();
      stop = () => {
        this.stopping = true;
      };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      signal?.addEventListener('abort', stop, { once: true });
      this.logger(`agent started (pid ${process.pid})`);

      while (!this.stopping) {
        await this.reconcile();
        await delay(RECONCILE_INTERVAL_MS);
      }
      await this.shutdown();
      return true;
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      if (stop) {
        process.removeListener('SIGINT', stop);
        process.removeListener('SIGTERM', stop);
      }
      this.store.removeAgent(lease.token);
      this.store.releaseAgentLease(lease);
      this.leaseToken = null;
      this.logger('agent stopped');
    }
  }
}

function rotateLog(store) {
  store.ensureDirectory();
  try {
    if (fs.statSync(store.logPath).size < 1_000_000) return;
    fs.renameSync(store.logPath, `${store.logPath}.1`);
  } catch {
    // A missing log needs no rotation.
  }
}

export function createAgentLogger(store = new StateStore()) {
  return (message) => {
    store.ensureDirectory();
    fs.appendFileSync(
      store.logPath,
      `${new Date().toISOString()} ${String(message).replaceAll('\n', ' ')}\n`,
      { mode: 0o600 },
    );
  };
}

export async function ensureAgentRunning({
  store = new StateStore(),
  spawnProcess = spawn,
  executable = process.execPath,
  entrypoint = path.resolve(process.argv[1]),
  timeoutMs = 5_000,
} = {}) {
  const current = store.readAgent();
  if (current.running) return current;
  rotateLog(store);
  const output = fs.openSync(store.logPath, 'a', 0o600);
  const args = process.pkg
    ? ['agent', 'run']
    : [entrypoint, 'agent', 'run'];
  const child = spawnProcess(executable, args, {
    detached: true,
    stdio: ['ignore', output, output],
    windowsHide: true,
    env: process.env,
  });
  child.unref?.();
  fs.closeSync(output);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const agent = store.readAgent();
    if (agent.running) return agent;
    await delay(50);
  }
  throw new Error(`docker-remote agent did not start; inspect ${store.logPath}`);
}
