import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeInvocation, parseForward, parseOptions } from '../src/cli.js';

test('extracts --remote from any command position', () => {
  const options = parseOptions(
    ['compose', 'up', '--build', '--remote', 'dev@example.com'],
    {},
  );
  assert.equal(options.remote, 'dev@example.com');
  assert.deepEqual(options.command, ['compose', 'up', '--build']);
});

test('accepts Docker-style leading docker command', () => {
  assert.deepEqual(
    normalizeInvocation(['docker', 'compose', 'up']),
    { kind: 'compose', args: ['up'] },
  );
});

test('accepts docker-compose compatibility spelling', () => {
  assert.deepEqual(
    normalizeInvocation(['docker-compose', 'ps']),
    { kind: 'compose', args: ['ps'] },
  );
});

test('keeps Docker flags that are not owned by docker-remote', () => {
  const options = parseOptions(
    ['run', '--rm', '-p', '8080:80', 'nginx', '--remote=host'],
    {},
  );
  assert.deepEqual(options.command, ['run', '--rm', '-p', '8080:80', 'nginx']);
});

test('uses the environment as a remote fallback', () => {
  const options = parseOptions(['ps'], { DOCKER_REMOTE_HOST: 'env-host' });
  assert.equal(options.remote, 'env-host');
});

test('rejects targets that could become SSH options', () => {
  assert.throws(
    () => parseOptions(['ps', '--remote', '-oProxyCommand=bad'], {}),
    /invalid SSH target/,
  );
});

test('parses and validates explicit forwards', () => {
  assert.equal(parseForward('8080:80').localPort, 8080);
  assert.throws(() => parseForward('70000:80'), /between 1 and 65535/);
  assert.throws(() => parseForward('localhost:80'), /expected LOCAL_PORT/);
});
