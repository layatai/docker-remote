import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import ignore from 'ignore';
import * as tar from 'tar';

import { waitForChild, RemoteProcessError } from './ssh.js';

const composeFiles = [
  'compose.yaml',
  'compose.yml',
  'docker-compose.yaml',
  'docker-compose.yml',
];

function hasComposeFile(directory) {
  return composeFiles.some((file) => fs.existsSync(path.join(directory, file)));
}

export function findProjectRoot(startDirectory) {
  let current = fs.realpathSync(startDirectory);
  while (true) {
    if (hasComposeFile(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) return fs.realpathSync(startDirectory);
    current = parent;
  }
}

function slug(value) {
  const result = value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 36);
  return result || 'project';
}

export function createProject(cwd = process.cwd()) {
  const localCwd = fs.realpathSync(cwd);
  const localRoot = findProjectRoot(localCwd);
  const digest = crypto.createHash('sha256').update(localRoot).digest('hex').slice(0, 12);
  const base = slug(path.basename(localRoot));
  const id = `${base}-${digest}`;
  const relativeCwd = path.relative(localRoot, localCwd).split(path.sep).join('/');
  const remoteRoot = `.docker-remote/projects/${id}`;
  const remoteCwd = relativeCwd ? `${remoteRoot}/${relativeCwd}` : remoteRoot;
  return {
    localRoot,
    localCwd,
    relativeCwd,
    id,
    composeName: id,
    remoteRoot,
    remoteCwd,
  };
}

function loadIgnore(root) {
  const matcher = ignore();
  matcher.add(['.git', '.git/**', '.docker-remote', '.docker-remote/**']);
  const dockerIgnore = path.join(root, '.dockerignore');
  if (fs.existsSync(dockerIgnore)) {
    matcher.add(fs.readFileSync(dockerIgnore, 'utf8'));
  }
  return matcher;
}

export function createProjectArchive(project) {
  const matcher = loadIgnore(project.localRoot);
  return tar.create(
    {
      cwd: project.localRoot,
      portable: true,
      noMtime: true,
      follow: false,
      filter: (entry, stat) => {
        const relative = entry.replace(/^\.\//, '').replace(/\/$/, '');
        if (!relative || relative === '.') return true;
        const candidate = stat.isDirectory() ? `${relative}/` : relative;
        return !matcher.ignores(candidate);
      },
    },
    ['.'],
  );
}

export function syncCommand(remoteRoot) {
  if (
    !/^[a-zA-Z0-9_./-]+$/.test(remoteRoot)
    || remoteRoot.startsWith('/')
    || remoteRoot.split('/').includes('..')
  ) {
    throw new Error('unsafe generated remote project path');
  }
  return [
    'set -eu',
    'command -v tar >/dev/null 2>&1 || { echo "tar is required on the remote host" >&2; exit 127; }',
    `remote_root="$HOME/${remoteRoot}"`,
    'remote_stage="${remote_root}.tmp.$$"',
    'trap \'rm -rf -- "$remote_stage"\' EXIT HUP INT TERM',
    'rm -rf -- "$remote_stage"',
    'mkdir -p -- "$remote_stage"',
    'tar -xf - -C "$remote_stage"',
    'rm -rf -- "$remote_root"',
    'mv -- "$remote_stage" "$remote_root"',
    'trap - EXIT HUP INT TERM',
  ].join('; ');
}

export async function syncProject(client, project) {
  const child = client.spawnRemote(syncCommand(project.remoteRoot), {
    stdio: ['pipe', 'inherit', 'inherit'],
    tty: false,
  });
  const childResult = waitForChild(child);
  let pipelineError;
  try {
    await pipeline(createProjectArchive(project), child.stdin);
  } catch (error) {
    pipelineError = error;
  }
  const result = await childResult;
  if (result.code !== 0) {
    throw new RemoteProcessError(`project sync failed with exit code ${result.code}`, result.code);
  }
  if (pipelineError) throw pipelineError;
}
