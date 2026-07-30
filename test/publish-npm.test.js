import test from 'node:test';
import assert from 'node:assert/strict';

import { parseArgs, publishArgs } from '../scripts/publish-npm.js';

test('defaults to a latest-tagged dry run', () => {
  assert.deepEqual(parseArgs([]), {
    publish: false,
    tag: 'latest',
    provenance: false,
    allowDirty: false,
    help: false,
  });
  assert.deepEqual(
    publishArgs('/tmp/package.tgz', parseArgs([])),
    [
      'publish',
      '/tmp/package.tgz',
      '--access',
      'public',
      '--tag',
      'latest',
      '--dry-run',
    ],
  );
});

test('builds explicit publish arguments', () => {
  const options = parseArgs(['--publish', '--tag', 'next', '--provenance']);
  assert.deepEqual(
    publishArgs('/tmp/package.tgz', options),
    [
      'publish',
      '/tmp/package.tgz',
      '--access',
      'public',
      '--tag',
      'next',
      '--provenance',
    ],
  );
});

test('rejects unsafe release option combinations', () => {
  assert.throws(
    () => parseArgs(['--publish', '--allow-dirty']),
    /cannot be combined/,
  );
  assert.throws(() => parseArgs(['--tag', '']), /requires a value/);
  assert.throws(() => parseArgs(['--tag', 'not a tag']), /invalid npm tag/);
  assert.throws(() => parseArgs(['--unknown']), /unknown option/);
});
