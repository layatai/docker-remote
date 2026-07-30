import test from 'node:test';
import assert from 'node:assert/strict';

import { controlSocket, formatForward } from '../src/tunnel.js';

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
