import test from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { controlSocket, formatForward, TunnelManager } from '../src/tunnel.js';
import { StateStore } from '../src/state.js';

test('formats a loopback-only SSH local forward', () => {
  assert.equal(formatForward({
    localHost: '127.0.0.1',
    localPort: 8080,
    remoteHost: '127.0.0.1',
    remotePort: 80,
  }), '127.0.0.1:8080:127.0.0.1:80');
});

test('control socket identity is stable and target-specific', () => {
  assert.equal(controlSocket('host-a', 'project'), controlSocket('host-a', 'project'));
  assert.notEqual(controlSocket('host-a', 'project'), controlSocket('host-b', 'project'));
  assert(controlSocket('host-a', 'project').length < 100);
});

test('registers forwarding as desired state and starts the agent', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'docker-remote-tunnel-'));
  const store = new StateStore({ directory });
  const client = {
    target: 'host-a',
    identity: '/key',
    sshOptions: ['BatchMode=yes'],
    sshCommand: 'ssh',
  };
  let agentStarts = 0;
  const tunnel = new TunnelManager(client, 'project', {
    store,
    label: 'demo',
    ensureAgent: async () => {
      agentStarts += 1;
      const id = Object.keys(store.read().sessions)[0];
      await store.setRuntime(id, { status: 'active', pid: 123 });
    },
  });
  const forwards = [{
    localHost: '127.0.0.1',
    localPort: 8080,
    remoteHost: '127.0.0.1',
    remotePort: 80,
    protocol: 'tcp',
  }];

  await tunnel.start(forwards);
  const saved = store.read().sessions[tunnel.id];
  assert.equal(agentStarts, 1);
  assert.equal(saved.label, 'demo');
  assert.deepEqual(saved.forwards, forwards);
  assert.equal(tunnel.exists(), true);
  assert.equal(await tunnel.stop(), true);
  assert.equal(tunnel.exists(), false);
});
