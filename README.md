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

This is an early MVP for macOS and Linux clients. It deliberately uses the
remote Docker CLI over SSH instead of exposing an unauthenticated Docker socket.

## Requirements

Local:

- Node.js 20 or newer
- OpenSSH client

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
- Detached `compose up -d` or `compose up --wait`: the tunnel persists.
- `compose stop` and `compose down`: the project's persistent tunnel is closed.
- `docker-remote tunnel status|stop`: inspect or close tunnels for the current
  project.

Add a mapping manually for a raw Docker command:

```sh
docker-remote run -d -p 8080:80 nginx \
  --remote dev@example.com \
  --remote-forward 8080:8080
```

If a local port is already occupied, SSH fails rather than silently binding a
different address. Use `--remote-no-forward` to disable forwarding.

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
handling, `.dockerignore` archiving, published-port parsing, and tunnel
identity.

## Current limitations

- Raw `docker run -p` needs `--remote-forward`; automatic discovery currently
  targets Compose projects.
- Project sync is whole-project tar transfer, not incremental rsync.
- Bind mounts that use absolute host paths refer to the remote host and are not
  uploaded.
- UDP ports cannot be forwarded by SSH and are ignored.
- Windows clients and Windows SSH hosts are not yet supported.

## License

MIT
