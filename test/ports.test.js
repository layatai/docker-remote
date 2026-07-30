import test from 'node:test';
import assert from 'node:assert/strict';

import { mergeForwards, parseComposePorts } from '../src/ports.js';

test('reads Compose JSON Lines and keeps unique TCP published ports', () => {
  const output = [
    JSON.stringify({
      Service: 'web',
      Publishers: [
        { URL: '0.0.0.0', TargetPort: 80, PublishedPort: 8080, Protocol: 'tcp' },
        { URL: '0.0.0.0', TargetPort: 53, PublishedPort: 5353, Protocol: 'udp' },
      ],
    }),
    JSON.stringify({
      Service: 'worker',
      Publishers: [
        { URL: '0.0.0.0', TargetPort: 80, PublishedPort: 8080, Protocol: 'tcp' },
      ],
    }),
  ].join('\n');

  assert.deepEqual(parseComposePorts(output), [{
    localHost: '127.0.0.1',
    localPort: 8080,
    remoteHost: '127.0.0.1',
    remotePort: 8080,
    protocol: 'tcp',
  }]);
});

test('also accepts Compose JSON arrays', () => {
  const output = JSON.stringify([{
    Publishers: [{ PublishedPort: 3000, Protocol: 'tcp' }],
  }]);
  assert.equal(parseComposePorts(output)[0].localPort, 3000);
});

test('an explicit forward wins a local-port collision', () => {
  const explicit = {
    localHost: '127.0.0.1',
    localPort: 8080,
    remoteHost: '127.0.0.1',
    remotePort: 80,
  };
  const discovered = { ...explicit, remotePort: 8080 };
  assert.deepEqual(mergeForwards([explicit], [discovered]), [explicit]);
});
