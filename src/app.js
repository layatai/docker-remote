import { setTimeout as delay } from 'node:timers/promises';

import { parseOptions, normalizeInvocation, HELP, VERSION } from './cli.js';
import { SSHClient, waitForChild } from './ssh.js';
import { createProject, syncProject } from './project.js';
import { prepareCompose, isDetachedUp } from './compose.js';
import { buildRemoteExec } from './shell.js';
import { parseComposePorts, mergeForwards } from './ports.js';
import { TunnelManager } from './tunnel.js';
import { StateStore, isProcessAlive } from './state.js';
import {
  TunnelSupervisor,
  createAgentLogger,
  ensureAgentRunning,
} from './supervisor.js';

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

function createTunnel(client, key, label, dependencies = {}) {
  return new TunnelManager(client, key, {
    store: dependencies.store,
    ensureAgent: dependencies.ensureAgent,
    label,
    readyTimeoutMs: dependencies.readyTimeoutMs,
  });
}

async function runCompose(client, options, project, prepared, dependencies = {}) {
  const command = buildRemoteExec(
    ['docker', 'compose', ...prepared.args],
    project.remoteCwd,
  );
  const tunnel = createTunnel(client, project.id, pathLabel(project.localRoot), dependencies);

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

function pathLabel(directory) {
  const parts = directory.replaceAll('\\', '/').split('/').filter(Boolean);
  return parts.at(-1) ?? 'project';
}

async function runTunnelCommand(client, args, cwd, dependencies = {}) {
  const action = args[0] ?? 'status';
  const project = createProject(cwd);
  const tunnels = [
    createTunnel(client, project.id, pathLabel(project.localRoot), dependencies),
    createTunnel(client, 'default', 'docker', dependencies),
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

function publicSession(session) {
  return {
    id: session.id,
    label: session.label,
    target: session.target,
    status: session.runtime?.status ?? 'pending',
    pid: session.runtime?.pid ?? null,
    restartCount: session.runtime?.restartCount ?? 0,
    lastError: session.runtime?.lastError ?? null,
    nextRetryAt: session.runtime?.nextRetryAt ?? null,
    updatedAt: session.updatedAt,
    forwards: session.forwards,
  };
}

function snapshot(store) {
  const state = store.read();
  return {
    agent: store.readAgent(),
    sessions: Object.values(state.sessions)
      .map(publicSession)
      .sort((left, right) => left.label.localeCompare(right.label)),
  };
}

function writeJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function runPortsCommand(args, dependencies = {}) {
  const unknown = args.filter((arg) => arg !== '--json');
  if (unknown.length > 0) throw new Error(`unknown ports option "${unknown[0]}"`);
  const store = dependencies.store ?? new StateStore();
  const value = snapshot(store);
  if (args.includes('--json')) {
    writeJson(value);
    return 0;
  }
  if (value.sessions.length === 0) {
    process.stdout.write('No managed port forwards.\n');
    return 0;
  }
  for (const session of value.sessions) {
    process.stdout.write(`${session.status.padEnd(12)} ${session.label} @ ${session.target}\n`);
    for (const forward of session.forwards) {
      process.stdout.write(
        `  ${forward.localHost}:${forward.localPort} -> ${forward.remoteHost}:${forward.remotePort}/${forward.protocol}\n`,
      );
    }
    if (session.lastError) process.stdout.write(`  last error: ${session.lastError}\n`);
  }
  return 0;
}

async function waitForAgentStop(store, pid, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && isProcessAlive(pid)) {
    await delay(50);
  }
  return !isProcessAlive(pid);
}

async function runAgentCommand(args, dependencies = {}) {
  const positional = args.filter((arg) => arg !== '--json');
  const action = positional[0] ?? 'status';
  const store = dependencies.store ?? new StateStore();
  const json = args.includes('--json');
  if (action === 'run') {
    const supervisor = dependencies.supervisor ?? new TunnelSupervisor({
      store,
      logger: dependencies.logger ?? createAgentLogger(store),
    });
    await supervisor.run({ signal: dependencies.signal });
    return 0;
  }
  if (action === 'start') {
    const agent = await (dependencies.ensureAgent ?? ensureAgentRunning)({ store });
    if (json) writeJson(agent);
    else process.stdout.write(`running (pid ${agent.pid})\n`);
    return 0;
  }
  if (action === 'status') {
    const value = snapshot(store);
    if (json) writeJson(value);
    else process.stdout.write(value.agent.running ? `running (pid ${value.agent.pid})\n` : 'stopped\n');
    return value.agent.running ? 0 : 1;
  }
  if (action === 'stop') {
    const agent = store.readAgent();
    if (!agent.running) {
      if (!json) process.stdout.write('already stopped\n');
      return 0;
    }
    process.kill(agent.pid, 'SIGTERM');
    const stopped = await waitForAgentStop(store, agent.pid);
    if (!stopped) throw new Error(`agent ${agent.pid} did not stop`);
    if (!json) process.stdout.write('stopped\n');
    return 0;
  }
  if (action === 'remove') {
    const id = positional[1];
    if (!id || id.startsWith('-')) throw new Error('agent remove requires a session ID');
    const removed = await store.removeSession(id);
    if (!json) process.stdout.write(removed ? 'removed\n' : 'not found\n');
    return removed ? 0 : 1;
  }
  if (action === 'clear') {
    const count = await store.clearSessions();
    if (!json) process.stdout.write(`removed ${count} session${count === 1 ? '' : 's'}\n`);
    return 0;
  }
  throw new Error(`unknown agent command "${action}"`);
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
  const cwd = dependencies.cwd ?? process.cwd();

  if (invocation.kind === 'agent') return runAgentCommand(invocation.args, dependencies);
  if (invocation.kind === 'ports') return runPortsCommand(invocation.args, dependencies);

  const client = dependencies.client ?? new SSHClient(options, dependencies);
  if (invocation.kind === 'tunnel') {
    return runTunnelCommand(client, invocation.args, cwd, dependencies);
  }

  if (invocation.kind === 'compose') {
    const project = createProject(cwd);
    const prepared = prepareCompose(invocation.args, project);
    if (!prepared.subcommand) throw new Error('missing Docker Compose command');
    if (!options.noSync) {
      log(`syncing ${project.localRoot} to ${options.remote}`);
      await (dependencies.syncProject ?? syncProject)(client, project);
    }
    return runCompose(client, options, project, prepared, dependencies);
  }

  const tunnel = createTunnel(client, 'default', 'docker', dependencies);
  if (!options.noForward && options.forwards.length > 0) {
    await startTunnel(tunnel, options.forwards);
  }
  return client.run(buildRemoteExec(['docker', ...invocation.args]));
}
