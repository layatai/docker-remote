import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as tar from 'tar';

import { createProject, createProjectArchive, syncCommand } from '../src/project.js';

test('finds the parent Compose root and creates a stable safe identity', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'docker-remote-test-'));
  const child = path.join(root, 'services', 'api');
  fs.mkdirSync(child, { recursive: true });
  fs.writeFileSync(path.join(root, 'compose.yaml'), 'services: {}\n');
  const project = createProject(child);
  assert.equal(project.localRoot, root);
  assert.match(project.id, /^docker-remote-test-[a-z0-9-]+-[a-f0-9]{12}$/);
  assert.equal(project.remoteCwd, `${project.remoteRoot}/services/api`);
});

test('archive honors .dockerignore and always excludes .git', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'docker-remote-archive-'));
  fs.mkdirSync(path.join(root, '.git'));
  fs.writeFileSync(path.join(root, '.git', 'config'), 'secret');
  fs.writeFileSync(path.join(root, '.dockerignore'), 'ignored.txt\n');
  fs.writeFileSync(path.join(root, 'included.txt'), 'yes');
  fs.writeFileSync(path.join(root, 'ignored.txt'), 'no');
  const project = createProject(root);
  const entries = [];
  await new Promise((resolve, reject) => {
    createProjectArchive(project)
      .pipe(tar.list({
        onentry: (entry) => entries.push(entry.path),
      }))
      .once('error', reject)
      .once('end', resolve);
  });
  assert(entries.some((entry) => entry.endsWith('included.txt')));
  assert(!entries.some((entry) => entry.includes('.git/config')));
  assert(!entries.some((entry) => entry.endsWith('ignored.txt')));
});

test('sync command only replaces its generated project directory', () => {
  const command = syncCommand('.docker-remote/projects/demo-123');
  assert.match(command, /remote_stage/);
  assert.match(command, /rm -rf -- "\$remote_root"/);
  assert.throws(() => syncCommand('../../tmp;bad'), /unsafe generated/);
  assert.throws(() => syncCommand('../../tmp'), /unsafe generated/);
});
