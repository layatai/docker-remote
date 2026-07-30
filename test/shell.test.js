import test from 'node:test';
import assert from 'node:assert/strict';

import { buildRemoteExec, shellQuote } from '../src/shell.js';

test('quotes shell metacharacters and apostrophes', () => {
  assert.equal(shellQuote("a'b;$(touch nope)"), `'a'"'"'b;$(touch nope)'`);
});

test('builds an exec command in the generated remote directory', () => {
  assert.equal(
    buildRemoteExec(['docker', 'compose', 'up'], '.docker-remote/projects/demo'),
    `cd "$HOME/.docker-remote/projects/demo" && exec 'docker' 'compose' 'up'`,
  );
});

test('rejects an unsafe remote directory', () => {
  assert.throws(
    () => buildRemoteExec(['docker', 'ps'], 'project; rm -rf /'),
    /unsafe generated/,
  );
  assert.throws(
    () => buildRemoteExec(['docker', 'ps'], '../../tmp'),
    /unsafe generated/,
  );
});
