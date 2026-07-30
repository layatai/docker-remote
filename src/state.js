import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const STATE_VERSION = 1;
const LOCK_TIMEOUT_MS = 5_000;
const STALE_LOCK_MS = 30_000;

function defaultState() {
  return {
    version: STATE_VERSION,
    revision: 0,
    sessions: {},
  };
}

function isProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

export function stateDirectory({
  env = process.env,
  platform = process.platform,
  home = os.homedir(),
} = {}) {
  if (env.DOCKER_REMOTE_STATE_DIR) {
    return path.resolve(env.DOCKER_REMOTE_STATE_DIR);
  }
  if (platform === 'win32') {
    return path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'docker-remote');
  }
  if (platform === 'darwin') {
    return path.posix.join(home, 'Library', 'Application Support', 'docker-remote');
  }
  return path.posix.join(
    env.XDG_STATE_HOME || path.posix.join(home, '.local', 'state'),
    'docker-remote',
  );
}

export function sessionId(target, key) {
  return crypto
    .createHash('sha256')
    .update(`${target}\0${key}`)
    .digest('hex')
    .slice(0, 24);
}

export function sessionFingerprint(session) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({
      target: session.target,
      identity: session.connection?.identity ?? '',
      sshOptions: session.connection?.sshOptions ?? [],
      forwards: session.forwards ?? [],
    }))
    .digest('hex');
}

export class StateStore {
  constructor({ directory = stateDirectory(), now = () => Date.now() } = {}) {
    this.directory = directory;
    this.now = now;
    this.statePath = path.join(directory, 'state.json');
    this.lockPath = path.join(directory, 'state.lock');
    this.agentPath = path.join(directory, 'agent.json');
    this.agentLockPath = path.join(directory, 'agent.lock');
    this.logPath = path.join(directory, 'agent.log');
  }

  ensureDirectory() {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(this.directory, 0o700);
    } catch {
      // Windows applies the current user's profile ACL instead of POSIX modes.
    }
  }

  read() {
    this.ensureDirectory();
    if (!fs.existsSync(this.statePath)) return defaultState();
    const state = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
    if (
      state?.version !== STATE_VERSION
      || !Number.isSafeInteger(state.revision)
      || typeof state.sessions !== 'object'
      || state.sessions === null
      || Array.isArray(state.sessions)
    ) {
      throw new Error(`unsupported or invalid state file: ${this.statePath}`);
    }
    return state;
  }

  async acquireLock() {
    this.ensureDirectory();
    const deadline = this.now() + LOCK_TIMEOUT_MS;
    while (this.now() < deadline) {
      try {
        const handle = fs.openSync(this.lockPath, 'wx', 0o600);
        fs.writeFileSync(handle, JSON.stringify({ pid: process.pid, createdAt: this.now() }));
        return handle;
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        let stale = false;
        try {
          const stat = fs.statSync(this.lockPath);
          const lock = JSON.parse(fs.readFileSync(this.lockPath, 'utf8'));
          stale = this.now() - stat.mtimeMs > STALE_LOCK_MS || !isProcessAlive(lock.pid);
        } catch {
          stale = true;
        }
        if (stale) {
          try {
            fs.unlinkSync(this.lockPath);
          } catch {
            // Another process may have recovered the stale lock.
          }
          continue;
        }
        await delay(20);
      }
    }
    throw new Error(`timed out waiting for state lock: ${this.lockPath}`);
  }

  releaseLock(handle) {
    try {
      fs.closeSync(handle);
    } finally {
      try {
        fs.unlinkSync(this.lockPath);
      } catch {
        // The next writer can recover a stale lock if cleanup was interrupted.
      }
    }
  }

  write(state) {
    this.ensureDirectory();
    const temporary = `${this.statePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, this.statePath);
    try {
      fs.chmodSync(this.statePath, 0o600);
    } catch {
      // Windows applies the current user's profile ACL instead of POSIX modes.
    }
  }

  async update(mutator) {
    const handle = await this.acquireLock();
    try {
      const state = this.read();
      const result = await mutator(state);
      state.revision += 1;
      this.write(state);
      return result;
    } finally {
      this.releaseLock(handle);
    }
  }

  async upsertSession(session) {
    const timestamp = new Date(this.now()).toISOString();
    return this.update((state) => {
      const previous = state.sessions[session.id];
      const changed = !previous || sessionFingerprint(previous) !== sessionFingerprint(session);
      state.sessions[session.id] = {
        ...previous,
        ...session,
        desired: true,
        createdAt: previous?.createdAt ?? timestamp,
        updatedAt: timestamp,
        runtime: changed
          ? {
            status: 'pending',
            pid: null,
            restartCount: previous?.runtime?.restartCount ?? 0,
            lastError: null,
            lastStartedAt: null,
            lastHealthyAt: null,
            nextRetryAt: null,
          }
          : previous.runtime,
      };
      return state.sessions[session.id];
    });
  }

  async removeSession(id) {
    return this.update((state) => {
      const existed = Boolean(state.sessions[id]);
      delete state.sessions[id];
      return existed;
    });
  }

  async clearSessions() {
    return this.update((state) => {
      const count = Object.keys(state.sessions).length;
      state.sessions = {};
      return count;
    });
  }

  async setRuntime(id, runtime) {
    return this.update((state) => {
      const session = state.sessions[id];
      if (!session) return false;
      session.runtime = {
        ...session.runtime,
        ...runtime,
      };
      return true;
    });
  }

  readAgent() {
    this.ensureDirectory();
    if (!fs.existsSync(this.agentPath)) return { running: false, pid: null };
    try {
      const agent = JSON.parse(fs.readFileSync(this.agentPath, 'utf8'));
      return {
        ...agent,
        running: isProcessAlive(agent.pid),
      };
    } catch {
      return { running: false, pid: null };
    }
  }

  writeAgent(agent) {
    this.ensureDirectory();
    const temporary = `${this.agentPath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(agent, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, this.agentPath);
  }

  removeAgent(expectedToken = null) {
    try {
      if (expectedToken) {
        const current = JSON.parse(fs.readFileSync(this.agentPath, 'utf8'));
        if (current.token !== expectedToken) return;
      }
      fs.unlinkSync(this.agentPath);
    } catch {
      // Missing or partially-written agent metadata is already stopped state.
    }
  }

  acquireAgentLease() {
    this.ensureDirectory();
    const attempt = () => {
      const handle = fs.openSync(this.agentLockPath, 'wx', 0o600);
      const token = crypto.randomUUID();
      fs.writeFileSync(handle, JSON.stringify({ pid: process.pid, token }));
      return { handle, token };
    };

    try {
      return attempt();
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      try {
        const lock = JSON.parse(fs.readFileSync(this.agentLockPath, 'utf8'));
        if (isProcessAlive(lock.pid)) return null;
      } catch {
        // An unreadable lock with no live owner is recovered below.
      }
      const agent = this.readAgent();
      if (agent.running) return null;
      try {
        fs.unlinkSync(this.agentLockPath);
      } catch {
        return null;
      }
      return attempt();
    }
  }

  releaseAgentLease(lease) {
    if (!lease) return;
    try {
      fs.closeSync(lease.handle);
    } finally {
      try {
        fs.unlinkSync(this.agentLockPath);
      } catch {
        // A stale lock is recovered on the next start.
      }
    }
  }
}

export { isProcessAlive };
