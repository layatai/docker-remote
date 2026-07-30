#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    env,
    path::PathBuf,
    process::{Command, Output},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
    time::Duration,
};

use serde::Deserialize;
use tauri::{
    image::Image,
    menu::{IsMenuItem, Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Wry,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[cfg(target_os = "macos")]
const TRAY_ICON_TEMPLATE: Image<'static> =
    tauri::include_image!("./icons/tray/tray-macos-template.png");

#[cfg(not(target_os = "macos"))]
const TRAY_ICON_IDLE: Image<'static> = tauri::include_image!("./icons/tray/tray-idle.png");
#[cfg(not(target_os = "macos"))]
const TRAY_ICON_ACTIVE: Image<'static> = tauri::include_image!("./icons/tray/tray-active.png");
#[cfg(not(target_os = "macos"))]
const TRAY_ICON_WARNING: Image<'static> =
    tauri::include_image!("./icons/tray/tray-warning.png");
#[cfg(not(target_os = "macos"))]
const TRAY_ICON_ERROR: Image<'static> = tauri::include_image!("./icons/tray/tray-error.png");

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Agent {
    running: bool,
    pid: Option<u32>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Forward {
    local_host: String,
    local_port: u16,
    remote_host: String,
    remote_port: u16,
    protocol: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Session {
    id: String,
    label: String,
    target: String,
    status: String,
    restart_count: u32,
    last_error: Option<String>,
    forwards: Vec<Forward>,
}

#[derive(Clone, Debug, Default, Deserialize)]
struct Snapshot {
    agent: Agent,
    sessions: Vec<Session>,
    #[serde(skip)]
    error: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum TrayState {
    Idle,
    Active,
    Warning,
    Error,
}

fn cli_path() -> PathBuf {
    if let Some(path) = env::var_os("DOCKER_REMOTE_BIN") {
        return PathBuf::from(path);
    }
    if let Ok(current) = env::current_exe() {
        if let Some(directory) = current.parent() {
            #[cfg(windows)]
            let sibling = directory.join("docker-remote.exe");
            #[cfg(not(windows))]
            let sibling = directory.join("docker-remote");
            if sibling.is_file() {
                return sibling;
            }
        }
    }
    PathBuf::from("docker-remote")
}

fn output(args: &[&str]) -> std::io::Result<Output> {
    let mut command = Command::new(cli_path());
    command.args(args);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    command.output()
}

fn ensure_agent() {
    let running = output(&["agent", "status", "--json"])
        .map(|result| result.status.success())
        .unwrap_or(false);
    if !running {
        let _ = output(&["agent", "start"]);
    }
}

fn snapshot() -> Snapshot {
    ensure_agent();
    match output(&["ports", "--json"]) {
        Ok(result) if result.status.success() => match serde_json::from_slice(&result.stdout) {
            Ok(value) => value,
            Err(error) => Snapshot {
                error: Some(format!("Invalid agent response: {error}")),
                ..Snapshot::default()
            },
        },
        Ok(result) => Snapshot {
            error: Some(String::from_utf8_lossy(&result.stderr).trim().to_owned()),
            ..Snapshot::default()
        },
        Err(error) => Snapshot {
            error: Some(format!(
                "docker-remote CLI not found. Set DOCKER_REMOTE_BIN. ({error})"
            )),
            ..Snapshot::default()
        },
    }
}

fn truncate(value: &str, length: usize) -> String {
    let mut output: String = value.chars().take(length).collect();
    if value.chars().count() > length {
        output.push('…');
    }
    output
}

fn menu(app: &AppHandle, snapshot: &Snapshot) -> tauri::Result<Menu<Wry>> {
    let active = snapshot
        .sessions
        .iter()
        .filter(|session| session.status == "active")
        .count();
    let mut items = Vec::new();
    let agent_status = if snapshot.agent.running {
        format!(
            "Agent running{} · {active}/{} sessions active",
            snapshot
                .agent
                .pid
                .map(|pid| format!(" (pid {pid})"))
                .unwrap_or_default(),
            snapshot.sessions.len()
        )
    } else {
        "Agent stopped · relaunching…".to_string()
    };
    items.push(MenuItem::with_id(
        app,
        "status",
        agent_status,
        false,
        None::<&str>,
    )?);

    if let Some(error) = &snapshot.error {
        items.push(MenuItem::with_id(
            app,
            "error",
            truncate(error, 100),
            false,
            None::<&str>,
        )?);
    } else if snapshot.sessions.is_empty() {
        items.push(MenuItem::with_id(
            app,
            "empty",
            "No managed port forwards",
            false,
            None::<&str>,
        )?);
    }

    for session in &snapshot.sessions {
        let marker = match session.status.as_str() {
            "active" => "●",
            "connecting" | "pending" => "◐",
            "reconnecting" => "↻",
            _ => "○",
        };
        items.push(MenuItem::with_id(
            app,
            format!("session:{}", session.id),
            format!("{marker} {} @ {} · {}", session.label, session.target, session.status),
            false,
            None::<&str>,
        )?);
        for forward in &session.forwards {
            items.push(MenuItem::with_id(
                app,
                format!("port:{}:{}", session.id, forward.local_port),
                format!(
                    "    {}:{} → {}:{}/{}",
                    forward.local_host,
                    forward.local_port,
                    forward.remote_host,
                    forward.remote_port,
                    forward.protocol
                ),
                false,
                None::<&str>,
            )?);
        }
        if let Some(error) = &session.last_error {
            items.push(MenuItem::with_id(
                app,
                format!("error:{}", session.id),
                format!(
                    "    Last error (restart #{}): {}",
                    session.restart_count,
                    truncate(error, 80)
                ),
                false,
                None::<&str>,
            )?);
        }
        items.push(MenuItem::with_id(
            app,
            format!("stop:{}", session.id),
            format!("    Stop forwarding {}", session.label),
            true,
            None::<&str>,
        )?);
    }

    items.push(MenuItem::with_id(
        app,
        "refresh",
        "Refresh",
        true,
        None::<&str>,
    )?);
    items.push(MenuItem::with_id(
        app,
        "quit",
        "Quit tray",
        true,
        None::<&str>,
    )?);
    let references: Vec<&dyn IsMenuItem<Wry>> = items
        .iter()
        .map(|item| item as &dyn IsMenuItem<Wry>)
        .collect();
    Menu::with_items(app, &references)
}

fn tray_state(snapshot: &Snapshot) -> TrayState {
    if snapshot.error.is_some() || !snapshot.agent.running {
        TrayState::Error
    } else if snapshot.sessions.is_empty() {
        TrayState::Idle
    } else if snapshot
        .sessions
        .iter()
        .all(|session| session.status == "active")
    {
        TrayState::Active
    } else {
        TrayState::Warning
    }
}

#[cfg(target_os = "macos")]
fn tray_icon(_: TrayState) -> Image<'static> {
    TRAY_ICON_TEMPLATE.clone()
}

#[cfg(not(target_os = "macos"))]
fn tray_icon(state: TrayState) -> Image<'static> {
    match state {
        TrayState::Idle => TRAY_ICON_IDLE.clone(),
        TrayState::Active => TRAY_ICON_ACTIVE.clone(),
        TrayState::Warning => TRAY_ICON_WARNING.clone(),
        TrayState::Error => TRAY_ICON_ERROR.clone(),
    }
}

fn main() {
    let refresh = Arc::new(AtomicBool::new(true));
    let event_refresh = Arc::clone(&refresh);
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|_, _, _| {}))
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .setup(move |app| {
            let _ = app.autolaunch().enable();
            let initial = snapshot();
            let initial_state = tray_state(&initial);
            let initial_menu = menu(app.handle(), &initial)?;
            TrayIconBuilder::with_id("main")
                .icon(tray_icon(initial_state))
                .icon_as_template(cfg!(target_os = "macos"))
                .tooltip("docker-remote port forwarding")
                .menu(&initial_menu)
                .show_menu_on_left_click(true)
                .on_menu_event(move |app, event| {
                    let id = event.id.as_ref();
                    if id == "quit" {
                        app.exit(0);
                    } else if id == "refresh" {
                        event_refresh.store(true, Ordering::Release);
                    } else if let Some(session_id) = id.strip_prefix("stop:") {
                        let _ = output(&["agent", "remove", session_id]);
                        event_refresh.store(true, Ordering::Release);
                    }
                })
                .build(app)?;

            let handle = app.handle().clone();
            let worker_refresh = Arc::clone(&refresh);
            let mut previous_state = initial_state;
            thread::spawn(move || loop {
                if worker_refresh.swap(false, Ordering::AcqRel) {
                    let current = snapshot();
                    let current_state = tray_state(&current);
                    let state_changed = current_state != previous_state;
                    previous_state = current_state;
                    let active = current
                        .sessions
                        .iter()
                        .filter(|session| session.status == "active")
                        .count();
                    let update_handle = handle.clone();
                    let _ = handle.run_on_main_thread(move || {
                        if let Some(tray) = update_handle.tray_by_id("main") {
                            if let Ok(next_menu) = menu(&update_handle, &current) {
                                let _ = tray.set_menu(Some(next_menu));
                            }
                            if state_changed {
                                let _ = tray.set_icon(Some(tray_icon(current_state)));
                            }
                            let _ = tray.set_tooltip(Some(format!(
                                "docker-remote · {active}/{} sessions active",
                                current.sessions.len()
                            )));
                        }
                    });
                }
                thread::sleep(Duration::from_secs(2));
                worker_refresh.store(true, Ordering::Release);
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to run docker-remote tray");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(status: &str) -> Session {
        Session {
            id: "test".to_string(),
            label: "test".to_string(),
            target: "test@example.com".to_string(),
            status: status.to_string(),
            restart_count: 0,
            last_error: None,
            forwards: Vec::new(),
        }
    }

    fn snapshot(sessions: Vec<Session>) -> Snapshot {
        Snapshot {
            agent: Agent {
                running: true,
                pid: Some(42),
            },
            sessions,
            error: None,
        }
    }

    #[test]
    fn state_reflects_agent_and_session_health() {
        assert_eq!(tray_state(&snapshot(Vec::new())), TrayState::Idle);
        assert_eq!(
            tray_state(&snapshot(vec![session("active")])),
            TrayState::Active
        );
        assert_eq!(
            tray_state(&snapshot(vec![session("reconnecting")])),
            TrayState::Warning
        );

        let mut offline = snapshot(Vec::new());
        offline.agent.running = false;
        assert_eq!(tray_state(&offline), TrayState::Error);

        let mut invalid = snapshot(Vec::new());
        invalid.error = Some("invalid response".to_string());
        assert_eq!(tray_state(&invalid), TrayState::Error);
    }

    fn assert_transparent_icon(icon: &Image<'_>, expected_size: u32) {
        assert_eq!(icon.width(), expected_size);
        assert_eq!(icon.height(), expected_size);
        let alphas: Vec<u8> = icon.rgba().iter().skip(3).step_by(4).copied().collect();
        assert!(alphas.contains(&0), "icon must have a transparent background");
        assert!(alphas.iter().any(|alpha| *alpha > 0), "icon must be visible");
    }

    fn pixel(icon: &Image<'_>, x: u32, y: u32) -> [u8; 4] {
        let index = ((y * icon.width() + x) * 4) as usize;
        icon.rgba()[index..index + 4].try_into().unwrap()
    }

    #[test]
    fn tray_assets_have_platform_correct_size_and_transparency() {
        #[cfg(target_os = "macos")]
        {
            let icon = tray_icon(TrayState::Idle);
            assert_transparent_icon(&icon, 44);
            assert!(
                pixel(&icon, 13, 22)[3] < 16,
                "left link must remain hollow"
            );
            assert!(
                pixel(&icon, 31, 22)[3] < 16,
                "right link must remain hollow"
            );
            assert!(pixel(&icon, 22, 22)[3] > 0, "link must remain connected");
        }

        #[cfg(not(target_os = "macos"))]
        {
            let states = [
                TrayState::Idle,
                TrayState::Active,
                TrayState::Warning,
                TrayState::Error,
            ];
            let mut colors = Vec::new();
            for state in states {
                let icon = tray_icon(state);
                assert_transparent_icon(&icon, 32);
                colors.push(pixel(&icon, 16, 5));
            }
            colors.dedup();
            assert_eq!(colors.len(), states.len(), "health colors must be distinct");
        }
    }
}
