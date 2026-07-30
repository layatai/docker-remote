import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { VERSION } from '../src/cli.js';

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const packageJson = JSON.parse(
  fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);

export const USAGE = `Usage: npm run release:npm -- [options]

Runs checks, builds the npm tarball, and performs an npm publish dry run.

Options:
  --publish       Publish the validated tarball to npm
  --tag TAG       npm distribution tag (default: latest)
  --provenance    Ask npm to attach build provenance
  --allow-dirty   Allow a dirty worktree for dry runs only
  --help          Show this help
`;

function readValue(args, index, name) {
  const token = args[index];
  if (token === name) {
    if (!args[index + 1] || args[index + 1].startsWith('-')) {
      throw new Error(`${name} requires a value`);
    }
    return { value: args[index + 1], consumed: 2 };
  }
  if (token.startsWith(`${name}=`)) {
    const value = token.slice(name.length + 1);
    if (!value) throw new Error(`${name} requires a value`);
    return { value, consumed: 1 };
  }
  return null;
}

export function parseArgs(args) {
  const options = {
    publish: false,
    tag: 'latest',
    provenance: false,
    allowDirty: false,
    help: false,
  };

  for (let index = 0; index < args.length;) {
    const token = args[index];
    if (token === '--publish') options.publish = true;
    else if (token === '--provenance') options.provenance = true;
    else if (token === '--allow-dirty') options.allowDirty = true;
    else if (token === '--help' || token === '-h') options.help = true;
    else {
      const tag = readValue(args, index, '--tag');
      if (!tag) throw new Error(`unknown option "${token}"`);
      options.tag = tag.value;
      index += tag.consumed;
      continue;
    }
    index += 1;
  }

  if (!/^[a-z][a-z0-9._-]*$/i.test(options.tag)) {
    throw new Error(`invalid npm tag "${options.tag}"`);
  }
  if (options.publish && options.allowDirty) {
    throw new Error('--allow-dirty cannot be combined with --publish');
  }
  return options;
}

function run(command, args, { capture = false, allowedStatuses = [0] } = {}) {
  const result = spawnSync(command, args, {
    cwd: path.resolve(fileURLToPath(new URL('..', import.meta.url))),
    encoding: capture ? 'utf8' : undefined,
    stdio: capture ? 'pipe' : 'inherit',
  });
  if (result.error) throw result.error;
  if (!allowedStatuses.includes(result.status)) {
    const details = capture ? String(result.stderr || result.stdout).trim() : '';
    throw new Error(`${command} ${args.join(' ')} failed${details ? `: ${details}` : ''}`);
  }
  return result;
}

function assertVersion() {
  if (packageJson.version !== VERSION) {
    throw new Error(
      `version mismatch: package.json=${packageJson.version}, CLI=${VERSION}`,
    );
  }
}

function assertWorktree(options) {
  const status = run('git', ['status', '--porcelain'], { capture: true }).stdout.trim();
  if (status && !options.allowDirty) {
    throw new Error('worktree is dirty; commit the intended release or use --allow-dirty for a dry run');
  }
}

function assertUnpublished() {
  const spec = `${packageJson.name}@${packageJson.version}`;
  const result = run(npmCommand, ['view', spec, 'version', '--json'], {
    capture: true,
    allowedStatuses: [0, 1],
  });
  if (result.status === 0) {
    throw new Error(`${spec} is already published`);
  }
  const output = `${result.stdout}\n${result.stderr}`;
  if (!/E404|404 Not Found/i.test(output)) {
    throw new Error(`could not verify ${spec} on npm: ${output.trim()}`);
  }
}

function pack(directory) {
  const result = run(npmCommand, [
    'pack',
    '--json',
    '--pack-destination',
    directory,
  ], { capture: true });
  const metadata = JSON.parse(result.stdout);
  if (!Array.isArray(metadata) || metadata.length !== 1 || !metadata[0].filename) {
    throw new Error('npm pack returned unexpected metadata');
  }
  return path.join(directory, metadata[0].filename);
}

export function publishArgs(tarball, options) {
  const args = [
    'publish',
    tarball,
    '--access',
    'public',
    '--tag',
    options.tag,
  ];
  if (!options.publish) args.push('--dry-run');
  if (options.provenance) args.push('--provenance');
  return args;
}

export function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  if (options.help) {
    process.stdout.write(USAGE);
    return;
  }

  assertVersion();
  assertWorktree(options);
  assertUnpublished();
  if (options.publish) run(npmCommand, ['whoami']);
  run(npmCommand, ['run', 'check']);
  run(npmCommand, ['run', 'test:coverage']);

  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'docker-remote-npm-'));
  try {
    const tarball = pack(temporary);
    run(npmCommand, publishArgs(tarball, options));
    process.stdout.write(
      options.publish
        ? `${packageJson.name}@${packageJson.version} published with tag ${options.tag}\n`
        : `Dry run passed for ${packageJson.name}@${packageJson.version}; rerun with --publish to release\n`,
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

const isEntryPoint = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntryPoint) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`[publish-npm] ${error.message}\n`);
    process.exitCode = 1;
  }
}
