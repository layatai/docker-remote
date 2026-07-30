import path from 'node:path';

const globalFlagsWithValue = new Set([
  '-f',
  '--file',
  '--env-file',
  '--profile',
  '--project-directory',
  '-p',
  '--project-name',
  '--ansi',
  '--parallel',
  '--progress',
]);

const pathFlags = new Set(['-f', '--file', '--env-file', '--project-directory']);

function isExternalReference(value) {
  return (
    value === '-'
    || /^[a-z][a-z0-9+.-]+:\/\//i.test(value)
    || /^oci:/i.test(value)
    || /^[^/@\s]+@[^:\s]+:.+/.test(value)
  );
}

function remotePath(value, project) {
  if (isExternalReference(value)) {
    if (value === '-') {
      throw new Error('Compose configuration from stdin (-f -) is not supported during project sync');
    }
    return value;
  }
  const absolute = path.resolve(project.localCwd, value);
  const relative = path.relative(project.localRoot, absolute);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Compose path "${value}" is outside the synced project root`);
  }
  return (relative || '.').split(path.sep).join('/');
}

export function rewriteComposePaths(args, project) {
  const output = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (pathFlags.has(token)) {
      if (index + 1 >= args.length) throw new Error(`${token} requires a value`);
      output.push(token, remotePath(args[index + 1], project));
      index += 1;
      continue;
    }
    const longFlag = [...pathFlags].find((flag) => token.startsWith(`${flag}=`));
    if (longFlag) {
      output.push(`${longFlag}=${remotePath(token.slice(longFlag.length + 1), project)}`);
      continue;
    }
    output.push(token);
  }
  return output;
}

export function composeSubcommandIndex(args) {
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === '--') return index + 1 < args.length ? index + 1 : -1;
    if (!token.startsWith('-')) return index;
    if (globalFlagsWithValue.has(token)) {
      index += 1;
    }
  }
  return -1;
}

function hasProjectName(args) {
  const index = composeSubcommandIndex(args);
  const prefix = index === -1 ? args : args.slice(0, index);
  return prefix.some((token) => (
    token === '-p'
    || token === '--project-name'
    || token.startsWith('--project-name=')
  ));
}

export function prepareCompose(args, project) {
  const rewritten = rewriteComposePaths(args, project);
  const composeArgs = hasProjectName(rewritten)
    ? rewritten
    : ['--project-name', project.composeName, ...rewritten];
  const subcommandIndex = composeSubcommandIndex(composeArgs);
  const subcommand = subcommandIndex === -1 ? '' : composeArgs[subcommandIndex];
  const globalArgs = subcommandIndex === -1 ? composeArgs : composeArgs.slice(0, subcommandIndex);
  return {
    args: composeArgs,
    subcommand,
    subcommandArgs: subcommandIndex === -1 ? [] : composeArgs.slice(subcommandIndex + 1),
    globalArgs,
  };
}

export function isDetachedUp(prepared) {
  if (prepared.subcommand !== 'up') return false;
  return prepared.subcommandArgs.some((arg) => (
    arg === '-d'
    || arg === '--detach'
    || arg === '--wait'
    || arg.startsWith('--wait=')
  ));
}
