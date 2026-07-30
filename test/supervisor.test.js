import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import {
  restartDelay,
  sshTunnelArgs,
  TunnelSupervisor,
} from '../src/supervisor.js';
import { StateStore } from '../src/state.js';

function session(overrides = {}) {
  return {
    id: 'session-1',
    key: 'project',
    label: 'demo',
    target: 'dev@example.com',
    connection: {
      identity: '/keys/dev',
      sshOptions: ['BatchMode=yes'],
      sshCommand: 'ssh',
    },
    forwards: [{
      localHost: '127.0.0.1',
      localPort: 8080,
      remoteHost: '127.0.0.1',
      remotePort: 80,
      protocol: 'tcp',
    }],
    ...overrides,
  };
}

class FakeChild extends EventEmitter {
  constructor(pid = 321) {
    super();
    this.pid = pid;
    this.stderr = new PassThrough();
    this.exitCode = null;
    this.signalCode = null;
  }

  kill(signal) {
    this.signalCode = signal;
    return true;
  }
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

test('builds a hardened, keepalive-enabled SSH tunnel command', () => {
  assert.deepEqual(sshTunnelArgs(session()), [
    '-i',
    '/keys/dev',
    '-o',
    'BatchMode=yes',
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
    '-L',
    '127.0.0.1:8080:127.0.0.1:80',
    'dev@example.com',
  ]);
});

test('uses capped exponential backoff with jitter', () => {
  assert.equal(restartDelay(0, () => 0), 250);
  assert.equal(restartDelay(1, () => 1), 1_000);
  assert.equal(restartDelay(20, () => 1), 30_000);
});

test('starts, marks healthy, and restarts a failed tunnel', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'docker-remote-supervisor-'));
  let now = 1_000;
  const store = new StateStore({ directory, now: () => now });
  await store.upsertSession(session());
  const children = [];
  const supervisor = new TunnelSupervisor({
    store,
    now: () => now,
    random: () => 0,
    spawnProcess: () => {
      const child = new FakeChild(100 + children.length);
      children.push(child);
      return child;
    },
  });
  supervisor.leaseToken = 'agent-token';

  await supervisor.reconcile();
  assert.equal(children.length, 1);
  children[0].emit('spawn');
  await tick();
  assert.equal(store.read().sessions['session-1'].runtime.status, 'connecting');
  assert.equal(store.read().sessions['session-1'].runtime.ownerToken, 'agent-token');

  now += 800;
  await supervisor.reconcile();
  assert.equal(store.read().sessions['session-1'].runtime.status, 'active');

  children[0].stderr.write('network unavailable\n');
  children[0].emit('close', 255, null);
  await tick();
  const failed = store.read().sessions['session-1'].runtime;
  assert.equal(failed.status, 'reconnecting');
  assert.match(failed.lastError, /network unavailable/);

  now = Date.parse(failed.nextRetryAt);
  await supervisor.reconcile();
  assert.equal(children.length, 2);
});

test('reclaims a recently orphaned tunnel owned by the crashed agent', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'docker-remote-supervisor-'));
  const now = Date.now();
  const store = new StateStore({ directory, now: () => now });
  await store.upsertSession(session());
  await store.setRuntime('session-1', {
    status: 'active',
    pid: 444,
    ownerToken: 'previous-agent-token',
  });
  const alive = new Set([444]);
  const signals = [];
  const supervisor = new TunnelSupervisor({
    store,
    now: () => now,
    processAlive: (pid) => alive.has(pid),
    killProcess: (pid, signal) => {
      signals.push([pid, signal]);
      alive.delete(pid);
    },
  });

  await supervisor.reclaimOrphanedSessions({
    pid: 111,
    token: 'previous-agent-token',
    heartbeatAt: new Date(now - 2_000).toISOString(),
  });

  assert.deepEqual(signals, [[444, 'SIGTERM']]);
  assert.deepEqual(
    store.read().sessions['session-1'].runtime,
    {
      status: 'pending',
      pid: null,
      ownerToken: null,
      restartCount: 0,
      lastError: null,
      lastStartedAt: null,
      lastHealthyAt: null,
      nextRetryAt: null,
    },
  );
});

test('does not reclaim a tunnel without recent matching ownership', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'docker-remote-supervisor-'));
  const now = Date.now();
  const store = new StateStore({ directory, now: () => now });
  await store.upsertSession(session());
  await store.setRuntime('session-1', {
    status: 'active',
    pid: 444,
    ownerToken: 'different-agent-token',
  });
  const signals = [];
  const supervisor = new TunnelSupervisor({
    store,
    now: () => now,
    processAlive: (pid) => pid === 444,
    killProcess: (...args) => signals.push(args),
  });

  await supervisor.reclaimOrphanedSessions({
    pid: 111,
    token: 'previous-agent-token',
    heartbeatAt: new Date(now - 2_000).toISOString(),
  });
  await supervisor.reclaimOrphanedSessions({
    pid: 111,
    token: 'different-agent-token',
    heartbeatAt: new Date(now - 60_000).toISOString(),
  });

  assert.deepEqual(signals, []);
  assert.equal(store.read().sessions['session-1'].runtime.pid, 444);
});

test('terminates a running tunnel when desired state is removed', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'docker-remote-supervisor-'));
  const store = new StateStore({ directory });
  await store.upsertSession(session());
  const child = new FakeChild();
  const supervisor = new TunnelSupervisor({
    store,
    spawnProcess: () => child,
  });
  await supervisor.reconcile();
  await store.removeSession('session-1');
  await supervisor.reconcile();
  assert.equal(child.signalCode, 'SIGTERM');
});
