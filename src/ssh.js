import { spawn } from 'node:child_process';

export class RemoteProcessError extends Error {
  constructor(message, exitCode = 1, stderr = '') {
    super(message);
    this.name = 'RemoteProcessError';
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

export function waitForChild(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      resolve({ code: code ?? (signal ? 1 : 0), signal });
    });
  });
}

export class SSHClient {
  constructor(options, dependencies = {}) {
    this.target = options.remote;
    this.identity = options.identity;
    this.sshOptions = [...options.sshOptions];
    this.tty = options.tty;
    this.sshCommand = dependencies.sshCommand ?? 'ssh';
    this.spawn = dependencies.spawn ?? spawn;
  }

  connectionArgs({ tty = false } = {}) {
    const args = [];
    if (this.identity) args.push('-i', this.identity);
    for (const option of this.sshOptions) args.push('-o', option);
    if (tty) args.push('-tt');
    return args;
  }

  spawnRemote(command, options = {}) {
    const args = [
      ...this.connectionArgs({ tty: options.tty ?? this.tty }),
      this.target,
      command,
    ];
    return this.spawn(this.sshCommand, args, {
      stdio: options.stdio ?? 'inherit',
      env: process.env,
    });
  }

  async run(command, options = {}) {
    const result = await waitForChild(this.spawnRemote(command, options));
    return result.code;
  }

  async capture(command) {
    const child = this.spawnRemote(command, {
      stdio: ['ignore', 'pipe', 'pipe'],
      tty: false,
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    const result = await waitForChild(child);
    const output = Buffer.concat(stdout).toString('utf8');
    const errorOutput = Buffer.concat(stderr).toString('utf8');
    if (result.code !== 0) {
      throw new RemoteProcessError(
        errorOutput.trim() || `remote command exited with code ${result.code}`,
        result.code,
        errorOutput,
      );
    }
    return output;
  }
}
