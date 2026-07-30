import path from 'node:path';
import os from 'node:os';

export const VERSION = '0.2.0';

const valueFlags = new Set([
  '--remote',
  '--remote-forward',
  '--remote-identity',
  '--remote-ssh-option',
]);

function readFlagValue(argv, index, name) {
  const token = argv[index];
  if (token === name) {
    if (index + 1 >= argv.length) {
      throw new Error(`${name} requires a value`);
    }
    return { value: argv[index + 1], consumed: 2 };
  }
  if (token.startsWith(`${name}=`)) {
    return { value: token.slice(name.length + 1), consumed: 1 };
  }
  return null;
}

function expandHome(file) {
  if (file === '~') return os.homedir();
  if (file.startsWith(`~${path.sep}`) || file.startsWith('~/')) {
    return path.join(os.homedir(), file.slice(2));
  }
  return file;
}

export function parseForward(value) {
  const match = /^(\d{1,5}):(\d{1,5})$/.exec(value);
  if (!match) {
    throw new Error(`invalid forward "${value}"; expected LOCAL_PORT:REMOTE_PORT`);
  }
  const localPort = Number(match[1]);
  const remotePort = Number(match[2]);
  if (localPort < 1 || localPort > 65535 || remotePort < 1 || remotePort > 65535) {
    throw new Error(`invalid forward "${value}"; ports must be between 1 and 65535`);
  }
  return {
    localHost: '127.0.0.1',
    localPort,
    remoteHost: '127.0.0.1',
    remotePort,
    protocol: 'tcp',
  };
}

function validateRemote(remote) {
  if (!remote) throw new Error('missing --remote TARGET (or DOCKER_REMOTE_HOST)');
  if (remote.startsWith('-') || /[\s\u0000-\u001f\u007f]/u.test(remote)) {
    throw new Error(`invalid SSH target "${remote}"`);
  }
}

export function parseOptions(argv, env = process.env) {
  const options = {
    remote: env.DOCKER_REMOTE_HOST ?? '',
    identity: env.DOCKER_REMOTE_IDENTITY ? expandHome(env.DOCKER_REMOTE_IDENTITY) : '',
    sshOptions: [],
    forwards: [],
    noSync: false,
    noForward: false,
    tty: false,
    help: false,
    version: false,
    command: [],
  };

  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    options.help = true;
    return options;
  }
  if (argv.length === 1 && (argv[0] === '--version' || argv[0] === '-v')) {
    options.version = true;
    return options;
  }

  for (let index = 0; index < argv.length;) {
    const token = argv[index];
    if (token === '--') {
      options.command.push(...argv.slice(index + 1));
      break;
    }
    if (token === '--remote-help') {
      options.help = true;
      index += 1;
      continue;
    }
    if (token === '--remote-version') {
      options.version = true;
      index += 1;
      continue;
    }
    if (token === '--remote-no-sync') {
      options.noSync = true;
      index += 1;
      continue;
    }
    if (token === '--remote-no-forward') {
      options.noForward = true;
      index += 1;
      continue;
    }
    if (token === '--remote-tty') {
      options.tty = true;
      index += 1;
      continue;
    }

    let matched = false;
    for (const name of valueFlags) {
      const result = readFlagValue(argv, index, name);
      if (!result) continue;
      matched = true;
      if (name === '--remote') options.remote = result.value;
      if (name === '--remote-identity') options.identity = expandHome(result.value);
      if (name === '--remote-ssh-option') options.sshOptions.push(result.value);
      if (name === '--remote-forward') options.forwards.push(parseForward(result.value));
      index += result.consumed;
      break;
    }
    if (matched) continue;

    if (token.startsWith('--remote-')) {
      throw new Error(`unknown docker-remote option "${token}"`);
    }
    options.command.push(token);
    index += 1;
  }

  if (options.help || options.version) return options;
  const localCommand = options.command[0] === 'agent' || options.command[0] === 'ports';
  if (!localCommand) validateRemote(options.remote);
  if (options.noForward && options.forwards.length > 0) {
    throw new Error('--remote-no-forward cannot be combined with --remote-forward');
  }
  if (options.command.length === 0) {
    throw new Error('missing Docker command');
  }
  return options;
}

export function normalizeInvocation(command) {
  const args = [...command];
  if (args[0] === 'docker') args.shift();
  if (args[0] === 'compose' || args[0] === 'docker-compose') {
    args.shift();
    return { kind: 'compose', args };
  }
  if (args[0] === 'tunnel') {
    args.shift();
    return { kind: 'tunnel', args };
  }
  if (args[0] === 'agent') {
    args.shift();
    return { kind: 'agent', args };
  }
  if (args[0] === 'ports') {
    args.shift();
    return { kind: 'ports', args };
  }
  return { kind: 'docker', args };
}

export const HELP = `docker-remote ${VERSION}

Run Docker or Docker Compose on a machine reachable through SSH.

Usage:
  docker-remote [docker] COMMAND [ARGS...] --remote USER@HOST
  docker-remote compose COMMAND [ARGS...] --remote USER@HOST
  docker-remote docker-compose COMMAND [ARGS...] --remote USER@HOST
  docker-remote tunnel (status|stop) --remote USER@HOST
  docker-remote ports [--json]
  docker-remote agent (start|status|stop|run|remove|clear)

Examples:
  docker-remote ps --remote dev@example.com
  docker-remote compose up --build --remote dev@example.com
  docker-remote compose up -d --remote dev@example.com
  docker-remote run --rm alpine uname -a --remote dev@example.com
  docker-remote tunnel stop --remote dev@example.com
  docker-remote ports
  docker-remote agent status

Options:
  --remote TARGET              SSH destination; may appear anywhere
  --remote-identity FILE       SSH private key
  --remote-ssh-option OPTION   Repeatable OpenSSH -o option
  --remote-forward LPORT:RPORT Add an explicit TCP forward
  --remote-no-sync             Do not upload the Compose project
  --remote-no-forward          Disable automatic and explicit forwarding
  --remote-tty                 Force pseudo-terminal allocation
  --remote-help                Show this help when Docker arguments are present
  --remote-version             Print the version

Environment:
  DOCKER_REMOTE_HOST
  DOCKER_REMOTE_IDENTITY
`;
