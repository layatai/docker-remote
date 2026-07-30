import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  sessionFingerprint,
  sessionId,
  StateStore,
  stateDirectory,
} from '../src/state.js';

function temporaryStore() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'docker-remote-state-'));
  return new StateStore({ directory });
}

test('uses platform-appropriate persistent state directories', () => {
  assert.equal(
    stateDirectory({ platform: 'linux', home: '/home/dev', env: {} }),
    '/home/dev/.local/state/docker-remote',
  );
  assert.equal(
    stateDirectory({ platform: 'darwin', home: '/Users/dev', env: {} }),
    '/Users/dev/Library/Application Support/docker-remote',
  );
  assert.equal(
    stateDirectory({ platform: 'win32', home: 'C:\\Users\\dev', env: { LOCALAPPDATA: 'C:\\Local' } }),
    path.join('C:\\Local', 'docker-remote'),
  );
});

test('session identities are stable and target-specific', () => {
  assert.equal(sessionId('host-a', 'project'), sessionId('host-a', 'project'));
  assert.notEqual(sessionId('host-a', 'project'), sessionId('host-b', 'project'));
});

test('session fingerprint changes only for tunnel process configuration', () => {
  const session = {
    target: 'host',
    label: 'first label',
    connection: { identity: '/key', sshOptions: ['BatchMode=yes'] },
    forwards: [{ localPort: 8080, remotePort: 80 }],
  };
  assert.equal(
    sessionFingerprint(session),
    sessionFingerprint({ ...session, label: 'renamed' }),
  );
  assert.notEqual(
    sessionFingerprint(session),
    sessionFingerprint({
      ...session,
      forwards: [{ localPort: 8081, remotePort: 80 }],
    }),
  );
});

test('atomically stores desired sessions and preserves runtime when unchanged', async () => {
  const store = temporaryStore();
  const session = {
    id: 'abc',
    key: 'project',
    label: 'demo',
    target: 'host',
    connection: { identity: '', sshOptions: [] },
    forwards: [{ localPort: 8080, remotePort: 80 }],
  };
  await store.upsertSession(session);
  await store.setRuntime('abc', { status: 'active', pid: 123 });
  await store.upsertSession({ ...session, label: 'new name' });
  assert.equal(store.read().sessions.abc.runtime.status, 'active');
  assert.equal(store.read().sessions.abc.label, 'new name');
  assert.equal(await store.removeSession('abc'), true);
  assert.deepEqual(store.read().sessions, {});
});

test('resets runtime when forward configuration changes', async () => {
  const store = temporaryStore();
  const session = {
    id: 'abc',
    key: 'project',
    label: 'demo',
    target: 'host',
    connection: { identity: '', sshOptions: [] },
    forwards: [{ localPort: 8080, remotePort: 80 }],
  };
  await store.upsertSession(session);
  await store.setRuntime('abc', { status: 'active', pid: 123 });
  await store.upsertSession({
    ...session,
    forwards: [{ localPort: 8081, remotePort: 80 }],
  });
  assert.equal(store.read().sessions.abc.runtime.status, 'pending');
  assert.equal(store.read().sessions.abc.runtime.pid, null);
});
