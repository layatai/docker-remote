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

  await supervisor.reconcile();
  assert.equal(children.length, 1);
  children[0].emit('spawn');
  await tick();
  assert.equal(store.read().sessions['session-1'].runtime.status, 'connecting');

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
