import { setTimeout as delay } from 'node:timers/promises';

import { parseOptions, normalizeInvocation, HELP, VERSION } from './cli.js';
import { SSHClient, waitForChild } from './ssh.js';
import { createProject, syncProject } from './project.js';
import { prepareCompose, isDetachedUp } from './compose.js';
import { buildRemoteExec } from './shell.js';
import { parseComposePorts, mergeForwards } from './ports.js';
import { TunnelManager } from './tunnel.js';

function log(message) {
  process.stderr.write(`[docker-remote] ${message}\n`);
}

function describeForwards(forwards) {
  return forwards
    .map((forward) => `${forward.localHost}:${forward.localPort} -> ${forward.remoteHost}:${forward.remotePort}`)
    .join(', ');
}

async function discoverComposePorts(client, prepared, project) {
  const command = buildRemoteExec(
    ['docker', 'compose', ...prepared.globalArgs, 'ps', '--format', 'json'],
    project.remoteCwd,
  );
  return parseComposePorts(await client.capture(command));
}

async function startTunnel(tunnel, forwards) {
  if (forwards.length === 0) {
    await tunnel.stop({ quiet: true });
    log('no published TCP ports found');
    return false;
  }
  await tunnel.start(forwards);
  log(`forwarding ${describeForwards(forwards)}`);
  return true;
}

async function waitForPorts(client, prepared, project, commandExit, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let exited = false;
  commandExit.then(() => {
    exited = true;
  });

  while (Date.now() < deadline) {
    try {
      const forwards = await discoverComposePorts(client, prepared, project);
      if (forwards.length > 0) return forwards;
    } catch {
      // Compose may not have created its containers yet.
    }
    if (exited) break;
    await delay(400);
  }
  try {
    return await discoverComposePorts(client, prepared, project);
  } catch {
    return [];
  }
}

async function runAttachedUp(client, command, prepared, project, tunnel, explicitForwards) {
  const child = client.spawnRemote(command, { stdio: 'inherit' });
  const commandExit = waitForChild(child);
  const relaySignal = (signal) => {
    if (!child.killed) child.kill(signal);
  };
  process.once('SIGINT', relaySignal);
  process.once('SIGTERM', relaySignal);

  let tunnelStarted = false;
  try {
    const discovered = await waitForPorts(client, prepared, project, commandExit);
    tunnelStarted = await startTunnel(tunnel, mergeForwards(explicitForwards, discovered));
    const result = await commandExit;
    return result.code;
  } finally {
    process.removeListener('SIGINT', relaySignal);
    process.removeListener('SIGTERM', relaySignal);
    if (tunnelStarted) {
      await tunnel.stop({ quiet: true });
      log('closed attached port forwarding');
    }
  }
}

async function runCompose(client, options, project, prepared) {
  const command = buildRemoteExec(
    ['docker', 'compose', ...prepared.args],
    project.remoteCwd,
  );
  const tunnel = new TunnelManager(client, project.id);

  if (prepared.subcommand === 'up' && !options.noForward) {
    if (!isDetachedUp(prepared)) {
      return runAttachedUp(
        client,
        command,
        prepared,
        project,
        tunnel,
        options.forwards,
      );
    }
    const code = await client.run(command);
    if (code !== 0) return code;
    const discovered = await discoverComposePorts(client, prepared, project);
    await startTunnel(tunnel, mergeForwards(options.forwards, discovered));
    return 0;
  }

  const code = await client.run(command);
  if (code === 0 && ['down', 'stop'].includes(prepared.subcommand)) {
    if (await tunnel.stop({ quiet: true })) log('closed port forwarding');
  }
  return code;
}

async function runTunnelCommand(client, args, cwd) {
  const action = args[0] ?? 'status';
  const project = createProject(cwd);
  const tunnels = [
    new TunnelManager(client, project.id),
    new TunnelManager(client, 'default'),
  ];
  if (action === 'status') {
    const active = tunnels.some((tunnel) => tunnel.exists());
    process.stdout.write(active ? 'active\n' : 'inactive\n');
    return 0;
  }
  if (action === 'stop') {
    const results = await Promise.all(tunnels.map((tunnel) => tunnel.stop({ quiet: true })));
    log(results.some(Boolean) ? 'closed port forwarding' : 'no active tunnel found');
    return 0;
  }
  throw new Error(`unknown tunnel command "${action}"; expected status or stop`);
}

export async function main(argv, dependencies = {}) {
  const options = parseOptions(argv, dependencies.env ?? process.env);
  if (options.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (options.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  const invocation = normalizeInvocation(options.command);
  const client = dependencies.client ?? new SSHClient(options, dependencies);
  const cwd = dependencies.cwd ?? process.cwd();

  if (invocation.kind === 'tunnel') {
    return runTunnelCommand(client, invocation.args, cwd);
  }

  if (invocation.kind === 'compose') {
    const project = createProject(cwd);
    const prepared = prepareCompose(invocation.args, project);
    if (!prepared.subcommand) throw new Error('missing Docker Compose command');
    if (!options.noSync) {
      log(`syncing ${project.localRoot} to ${options.remote}`);
      await (dependencies.syncProject ?? syncProject)(client, project);
    }
    return runCompose(client, options, project, prepared);
  }

  const tunnel = new TunnelManager(client, 'default');
  if (!options.noForward && options.forwards.length > 0) {
    await startTunnel(tunnel, options.forwards);
  }
  return client.run(buildRemoteExec(['docker', ...invocation.args]));
}
