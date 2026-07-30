# docker-remote tray

The desktop component is a windowless Tauri 2 application. It provides:

- a native system tray on Windows, macOS, and Linux;
- automatic launch at user login;
- automatic relaunch of the `docker-remote` agent when it is not healthy;
- live session state, local/remote port mappings, restart counts, and errors;
- a per-session action to stop forwarding.

The tray looks for the CLI in this order:

1. `DOCKER_REMOTE_BIN`;
2. a `docker-remote` executable beside the tray executable;
3. `docker-remote` on `PATH`.

This lets release installers bundle the CLI beside the tray while development
builds can use `npm link`.

## Development

Install the platform prerequisites from the
[Tauri documentation](https://v2.tauri.app/start/prerequisites/), then run:

```sh
cargo check --manifest-path desktop/src-tauri/Cargo.toml
cargo tauri build --config desktop/src-tauri/tauri.conf.json
```
