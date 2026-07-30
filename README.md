# docker-remote

`docker-remote` runs Docker commands on a machine reachable through SSH. For
Docker Compose, it uploads the project, runs Compose in a stable remote working
directory, discovers published TCP ports, and forwards those ports back to
localhost.

```console
$ docker-remote compose up --remote dev@example.com
[docker-remote] syncing /Users/me/app to dev@example.com
[docker-remote] forwarding 127.0.0.1:3000 -> 127.0.0.1:3000
```

## Status

The CLI and forwarding agent support Windows, macOS, and Linux clients. A
lightweight native Tauri tray is included for continuously supervising the
agent and inspecting every forwarded port. The remote Docker CLI still runs
over SSH; the Docker socket is never exposed over TCP.

## Requirements

Local:

- Node.js 20 or newer
- OpenSSH client

The desktop tray additionally uses the operating system's native WebView and
system-tray support. Linux packages require an AppIndicator-compatible desktop.

Remote:

- SSH access
- Docker Engine
- Docker Compose v2 for Compose commands
- `tar` for project upload

## Install

From a checkout:

```sh
npm install
npm link
```

Then verify the CLI:

```sh
docker-remote --version
```

## Usage

The `--remote` flag can appear anywhere, including after the Compose command:

```sh
# Docker
docker-remote ps --remote dev@example.com
docker-remote run --rm alpine uname -a --remote dev@example.com

# Docker Compose (preferred spelling)
docker-remote compose up --build --remote dev@example.com
docker-remote compose ps --remote dev@example.com
docker-remote compose down --remote dev@example.com

# docker-compose compatibility spelling
docker-remote docker-compose up -d --remote dev@example.com
```

Set a default host to omit the flag:

```sh
export DOCKER_REMOTE_HOST=dev@example.com
docker-remote compose up
```

Run `docker-remote --help` for all wrapper options. Docker and Compose flags that
are not prefixed with `--remote-` are passed through unchanged.

### Agent and port inspector

Persistent forwards are desired state managed by one background agent. The CLI
starts that agent automatically; it is safe to run the start command more than
once.

```sh
docker-remote agent start
docker-remote agent status
docker-remote ports
docker-remote ports --json
docker-remote agent stop       # desired sessions remain for the next start
docker-remote agent clear      # remove every desired session
```

The agent keeps one foreground OpenSSH child per remote project. OpenSSH
keepalives detect broken connections, and the agent relaunches failed tunnels
with capped exponential backoff and jitter. Desired sessions survive agent and
machine restarts in an atomic, user-private state file.

### System tray

The windowless desktop app provides a native tray menu on Windows, macOS, and
Linux. It starts at login, relaunches the forwarding agent if it dies, refreshes
every two seconds, and shows:

- agent PID and health;
- project, SSH target, and connection state;
- every local-to-remote port mapping;
- restart count and the most recent SSH error;
- a per-project action to stop forwarding.

For development, install the CLI with `npm link`, then build or run the tray
from `desktop/src-tauri`. Set `DOCKER_REMOTE_BIN` when the CLI is not on the
desktop session's `PATH`.

### Project synchronization

Before each Compose command, the CLI:

1. Finds the nearest parent containing `compose.yaml`, `compose.yml`,
   `docker-compose.yaml`, or `docker-compose.yml`.
2. Creates a tar stream filtered by `.dockerignore`.
3. Replaces only its generated project cache at
   `~/.docker-remote/projects/<project-id>` on the SSH host.
4. Runs Compose with a stable generated project name so edits do not create a
   new Compose project.

Use `--remote-no-sync` when the project is already present in the generated
remote cache. Compose files, env files, and build contexts outside the project
root are rejected because they cannot be uploaded safely.

### Port forwarding

For `compose up`, published TCP ports are read from
`docker compose ps --format json` and bound to the same port on local loopback.
They are never exposed on the client's public interfaces.

- Attached `compose up`: the tunnel exists while Compose is attached.
- Detached `compose up -d` or `compose up --wait`: desired forwarding persists
  and is continuously supervised.
- `compose stop` and `compose down`: the project's persistent tunnel is closed.
- `docker-remote tunnel status|stop`: inspect or close tunnels for the current
  project.
- `docker-remote ports`: inspect all projects, ports, health, and restart state.

Add a mapping manually for a raw Docker command:

```sh
docker-remote run -d -p 8080:80 nginx \
  --remote dev@example.com \
  --remote-forward 8080:8080
```

If a local port is already occupied, SSH fails rather than silently binding a
different address. The error is retained for inspection while the agent retries
with backoff. Use `--remote-no-forward` to disable forwarding.

## Architecture and language choice

The implementation intentionally uses two small control-plane components:

- Node.js owns Docker-compatible argument handling, project archiving, Compose
  discovery, and short-lived SSH command execution.
- Rust/Tauri owns native tray and login integration.
- OpenSSH owns encryption, authentication, keepalives, and the forwarding data
  path.

Rewriting the CLI in another language would not improve forwarding throughput:
application bytes flow directly through OpenSSH, not through Node.js. Keeping
the tested CLI and using Rust only for the long-lived native shell gives a
smaller desktop footprint than Electron and avoids a high-risk full rewrite.

### SSH configuration

OpenSSH host aliases work:

```sshconfig
Host buildbox
  HostName 10.0.0.20
  User ubuntu
  IdentityFile ~/.ssh/buildbox
  ProxyJump bastion
```

```sh
docker-remote compose up --remote buildbox
```

Or pass settings directly:

```sh
docker-remote ps \
  --remote ubuntu@10.0.0.20 \
  --remote-identity ~/.ssh/buildbox \
  --remote-ssh-option StrictHostKeyChecking=accept-new
```

## Why the command is `docker-remote compose up`

The binary intentionally does not replace the system `docker` executable.
Therefore, the safe default is:

```sh
docker-remote compose up --remote dev@example.com
```

An exact command such as `docker compose up --remote ...` would require a shell
shim named `docker` in front of the official Docker CLI. That can be added
later as an opt-in integration without making the MVP intercept every local
Docker command.

## Security model

- Authentication, host-key checking, jump hosts, and agent forwarding remain
  OpenSSH responsibilities.
- Arguments are shell-quoted before remote execution.
- SSH destinations beginning with `-` or containing whitespace/control
  characters are rejected.
- Automatic forwards bind only to `127.0.0.1`.
- Agent state contains paths and SSH options but never key material; it is
  written atomically below the current user's private state directory.
- SSH subprocesses receive arguments directly without invoking a local shell.
- The uploader only replaces its own generated directory below
  `~/.docker-remote/projects`.
- Docker access on the remote host is equivalent to privileged host access;
  only use hosts and accounts you trust.

## Development

```sh
npm install
npm run check
npm run test:coverage
```

The tests cover wrapper parsing, shell injection resistance, Compose argument
handling, `.dockerignore` archiving, published-port parsing, atomic desired
state, tunnel supervision, retry behavior, and tunnel identity. CI runs Node.js
tests across Windows, macOS, and Linux and compiles the Rust tray on all three.

Validate the tray separately:

```sh
cargo check --manifest-path desktop/src-tauri/Cargo.toml
```

Tagged `desktop-v*` builds create draft macOS, Windows, and Linux bundles
through the release workflow. Configure normal Apple and Windows signing
credentials before promoting those drafts for general distribution.

## Current limitations

- Raw `docker run -p` needs `--remote-forward`; automatic discovery currently
  targets Compose projects.
- Project sync is whole-project tar transfer, not incremental rsync.
- Bind mounts that use absolute host paths refer to the remote host and are not
  uploaded.
- UDP ports cannot be forwarded by SSH and are ignored.
- Windows SSH *clients* are supported; a Windows SSH *remote host* is not,
  because remote project synchronization currently requires POSIX `sh` and
  `tar`.
- Desktop installers currently locate an existing `docker-remote` CLI beside
  the tray binary, through `DOCKER_REMOTE_BIN`, or on `PATH`.

## License

MIT
