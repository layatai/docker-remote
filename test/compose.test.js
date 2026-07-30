import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

import { isDetachedUp, prepareCompose } from '../src/compose.js';

const root = path.join(os.tmpdir(), 'docker-remote-project');
const project = {
  localRoot: root,
  localCwd: root,
  composeName: 'demo-1234',
};

test('adds a stable project name and finds up', () => {
  const prepared = prepareCompose(['-f', 'compose.yaml', 'up', '--build'], project);
  assert.deepEqual(prepared.args, [
    '--project-name',
    'demo-1234',
    '-f',
    'compose.yaml',
    'up',
    '--build',
  ]);
  assert.equal(prepared.subcommand, 'up');
  assert.equal(isDetachedUp(prepared), false);
});

test('recognizes detached and wait modes', () => {
  assert.equal(isDetachedUp(prepareCompose(['up', '-d'], project)), true);
  assert.equal(isDetachedUp(prepareCompose(['up', '--wait'], project)), true);
});

test('preserves a user-provided Compose project name', () => {
  const prepared = prepareCompose(['-p', 'custom', 'ps'], project);
  assert.deepEqual(prepared.args, ['-p', 'custom', 'ps']);
});

test('rejects local compose paths outside the project sync root', () => {
  assert.throws(
    () => prepareCompose(['-f', '../compose.yaml', 'up'], project),
    /outside the synced project root/,
  );
});
