import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { main } from '../src/app.js';

class FakeClient {
  constructor() {
    this.commands = [];
    this.target = 'dev@example.com';
  }

  async run(command) {
    this.commands.push(command);
    return 0;
  }
}

test('runs an ordinary Docker command remotely', async () => {
  const client = new FakeClient();
  const code = await main(
    ['ps', '--all', '--remote', 'dev@example.com'],
    { client },
  );
  assert.equal(code, 0);
  assert.deepEqual(client.commands, [`exec 'docker' 'ps' '--all'`]);
});

test('syncs a Compose project and executes with a stable project name', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'docker-remote-app-'));
  fs.writeFileSync(path.join(root, 'compose.yaml'), 'services: {}\n');
  const client = new FakeClient();
  let syncedProject;
  const code = await main(
    ['compose', 'ps', '--remote', 'dev@example.com'],
    {
      client,
      cwd: root,
      syncProject: async (_client, project) => {
        syncedProject = project;
      },
    },
  );
  assert.equal(code, 0);
  assert.equal(syncedProject.localRoot, root);
  assert.match(client.commands[0], /'docker' 'compose' '--project-name'/);
  assert.match(client.commands[0], /'ps'$/);
  assert.match(client.commands[0], /^cd "\$HOME\/\.docker-remote\/projects\//);
});
