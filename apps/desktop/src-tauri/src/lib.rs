use std::env;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use rand::rngs::OsRng;
use rand::RngCore;
use serde::Serialize;
use tauri::{Manager, State};
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;

/// Description of a running sidecar child process, surfaced to the
/// webview once it has announced its port. `token` is a 32-byte random
/// value injected into the sidecar's env on spawn; the webview uses it
/// for the `auth.handshake` RPC.
#[derive(Clone, Debug, Serialize)]
struct SidecarEndpoint {
    host: String,
    port: u16,
    token: String,
}

/// Holds the currently-running sidecar handle plus the endpoint we
/// announced to the webview. `CommandChild` is not `Clone`, so we keep
/// it inside a `Mutex` so multiple Tauri commands can reach it.
struct SidecarState {
    inner: Mutex<Option<RunningSidecar>>,
}

struct RunningSidecar {
    child: CommandChild,
    endpoint: SidecarEndpoint,
}

impl Default for SidecarState {
    fn default() -> Self {
        Self {
            inner: Mutex::new(None),
        }
    }
}

fn generate_handshake_token() -> String {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    // URL-safe hex is plenty — we just need an opaque, unguessable string.
    bytes
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect::<String>()
}

#[derive(Debug)]
enum SidecarError {
    Spawn(String),
    Handshake(String),
}

impl std::fmt::Display for SidecarError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SidecarError::Spawn(msg) => write!(f, "sidecar spawn failed: {msg}"),
            SidecarError::Handshake(msg) => write!(f, "sidecar handshake failed: {msg}"),
        }
    }
}

impl From<SidecarError> for String {
    fn from(err: SidecarError) -> String {
        err.to_string()
    }
}

/// Path where we persist the currently-running sidecar's endpoint so
/// out-of-band tooling (tests, diagnostics, the agent running inside
/// Claude Code) can discover host/port/token without driving the
/// Tauri webview.
///
/// The file is intentionally scoped to the user's TMPDIR — not the
/// workspace — because the handshake token in it is sensitive.
///
/// Format: `{"host":"127.0.0.1","port":56667,"token":"…","pid":86863}`
fn endpoint_file_path() -> PathBuf {
    let tmp = env::temp_dir();
    tmp.join("openhorn-sidecar-endpoint.json")
}

fn write_endpoint_file(endpoint: &SidecarEndpoint) {
    let path = endpoint_file_path();
    // Intentionally use a simple JSON object rather than pulling in
    // serde_json::to_string(&endpoint) since we also want to embed the
    // current process pid for easy lookup.
    let body = format!(
        r#"{{"host":"{}","port":{},"token":"{}","pid":{}}}"#,
        endpoint.host,
        endpoint.port,
        endpoint.token,
        std::process::id(),
    );
    if let Err(e) = fs::write(&path, body) {
        log::warn!("failed to write sidecar endpoint file at {path:?}: {e}");
    } else {
        // Lock down permissions: owner read/write only. On unix this
        // matters because /tmp is world-readable. On windows fs::set_permissions
        // cannot drop read access for "other" with the std API so we
        // just rely on the TMPDIR being per-user.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
        }
    }
}

fn remove_endpoint_file() {
    let path = endpoint_file_path();
    match fs::remove_file(&path) {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => {
            log::warn!("failed to remove sidecar endpoint file at {path:?}: {e}");
        }
    }
}

/// Spawns the sidecar binary if it is not already running. Returns the
/// endpoint (host/port/token) the webview should use to connect.
///
/// Security posture:
///   - host is forced to 127.0.0.1; we ignore any user-set OPENHORN_HOST
///   - port is 0 so the OS assigns a random free port, preventing
///     cross-client collisions
///   - token is a fresh 32-byte random value per spawn; the previous
///     token is useless after this call
fn start_sidecar_internal<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    state: &SidecarState,
) -> Result<SidecarEndpoint, SidecarError> {
    let mut guard = state.inner.lock().unwrap();
    if let Some(existing) = guard.as_ref() {
        // Return the existing endpoint — the webview can reconnect
        // without us respawning the child.
        return Ok(existing.endpoint.clone());
    }

    let token = generate_handshake_token();

    let shell = app.shell();
    let sidecar = shell
        .sidecar("openhorn-sidecar")
        .map_err(|e| SidecarError::Spawn(e.to_string()))?
        .env("OPENHORN_HANDSHAKE_TOKEN", &token)
        .env("OPENHORN_HOST", "127.0.0.1")
        .env("OPENHORN_PORT", "0");

    let (mut rx, child) = sidecar
        .spawn()
        .map_err(|e| SidecarError::Spawn(e.to_string()))?;

    // Block until the sidecar prints its "ready" line so we can hand the
    // real port back to the webview. This matches the sidecar's
    // announcement format in apps/sidecar/src/index.ts:
    //     console.log(JSON.stringify({ type: "ready", host, port }))
    //
    // tauri-plugin-shell gives us an async channel for the child's
    // stdout events; we drain it synchronously here because we only
    // need the first message.
    let port = {
        use tauri_plugin_shell::process::CommandEvent;

        let mut found: Option<u16> = None;
        // Tauri 2's process events are delivered on a tokio channel.
        // We block-recv with a sync bridge via futures-executor because
        // we're still in a command that returns Result<_, String>.
        while let Some(event) = tauri::async_runtime::block_on(rx.recv()) {
            match event {
                CommandEvent::Stdout(bytes) => {
                    let line = String::from_utf8_lossy(&bytes);
                    if let Some(p) = parse_ready_port(&line) {
                        found = Some(p);
                        break;
                    }
                }
                CommandEvent::Stderr(bytes) => {
                    let line = String::from_utf8_lossy(&bytes);
                    log::warn!("sidecar stderr: {line}");
                }
                CommandEvent::Error(err) => {
                    return Err(SidecarError::Handshake(err));
                }
                CommandEvent::Terminated(status) => {
                    return Err(SidecarError::Handshake(format!(
                        "sidecar exited before announcing port: {:?}",
                        status
                    )));
                }
                _ => {}
            }
        }
        match found {
            Some(p) => p,
            None => {
                return Err(SidecarError::Handshake(
                    "sidecar closed stdout before announcing port".to_string(),
                ))
            }
        }
    };

    let endpoint = SidecarEndpoint {
        host: "127.0.0.1".to_string(),
        port,
        token,
    };

    // Persist the endpoint to TMPDIR so out-of-band diagnostic tooling
    // (the sidecar E2E smoke script, agents iterating on the code,
    // `curl` debugging sessions) can discover host/port/token without
    // needing to drive the Tauri webview. The file is chmod 600 on
    // unix; it's cleaned up on stop_sidecar and on window-close.
    write_endpoint_file(&endpoint);

    *guard = Some(RunningSidecar {
        child,
        endpoint: endpoint.clone(),
    });

    Ok(endpoint)
}

/// Parses a single sidecar stdout line looking for the JSON ready
/// announcement. Returns the port when found, None otherwise.
fn parse_ready_port(line: &str) -> Option<u16> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }
    let value: serde_json::Value = serde_json::from_str(trimmed).ok()?;
    if value.get("type").and_then(|v| v.as_str()) != Some("ready") {
        return None;
    }
    value.get("port").and_then(|v| v.as_u64()).and_then(|p| {
        if p == 0 || p > u16::MAX as u64 {
            None
        } else {
            Some(p as u16)
        }
    })
}

#[tauri::command]
fn start_sidecar(
    app: tauri::AppHandle,
    state: State<'_, SidecarState>,
) -> Result<SidecarEndpoint, String> {
    start_sidecar_internal(&app, &state).map_err(String::from)
}

#[tauri::command]
fn stop_sidecar(state: State<'_, SidecarState>) -> Result<(), String> {
    let mut guard = state.inner.lock().unwrap();
    if let Some(running) = guard.take() {
        running
            .child
            .kill()
            .map_err(|e| format!("sidecar kill failed: {e}"))?;
    }
    // Drop the endpoint file after the child is gone, whether or not
    // anything was actually running — a stale file is worse than a
    // missing one.
    remove_endpoint_file();
    Ok(())
}

#[tauri::command]
fn get_sidecar_endpoint(state: State<'_, SidecarState>) -> Option<SidecarEndpoint> {
    state.inner.lock().unwrap().as_ref().map(|s| s.endpoint.clone())
}

/// Opens the platform directory picker and returns the chosen absolute
/// path as a String. Returns None when the user cancels. We intentionally
/// expose the path to the webview rather than silently pushing it into
/// the sidecar — the renderer should store it and send it back on the
/// next sidecar `workspace.setCurrent` call so the user always sees the
/// same path in its UI.
#[tauri::command]
async fn pick_workspace_dir(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let picked = app
        .dialog()
        .file()
        .blocking_pick_folder()
        .map(|p| p.to_string());

    Ok(picked)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(SidecarState::default())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            if let Some(window) = app.get_webview_window("main") {
                window.on_navigation(|url| {
                    let s = url.as_str();
                    if s.starts_with("http://localhost") || s.starts_with("https://localhost") || s.starts_with("tauri://") {
                        true
                    } else {
                        let _ = open::that(s);
                        false
                    }
                });
            }

            Ok(())
        })
        // Make sure the sidecar child is killed whenever the window is
        // closing, so we do not leave orphaned bun processes if the
        // user quits from the window chrome.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                let handle = window.app_handle();
                if let Some(state) = handle.try_state::<SidecarState>() {
                    if let Ok(mut guard) = state.inner.lock() {
                        if let Some(running) = guard.take() {
                            let _ = running.child.kill();
                        }
                    }
                }
                remove_endpoint_file();
            }
        })
        .invoke_handler(tauri::generate_handler![
            start_sidecar,
            stop_sidecar,
            get_sidecar_endpoint,
            pick_workspace_dir
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ready_parser_accepts_matching_json_line() {
        let port = parse_ready_port(r#"{"type":"ready","host":"127.0.0.1","port":54321}"#);
        assert_eq!(port, Some(54321));
    }

    #[test]
    fn ready_parser_ignores_non_ready_events() {
        assert!(parse_ready_port(r#"{"type":"something-else","port":1234}"#).is_none());
    }

    #[test]
    fn ready_parser_ignores_garbage_lines() {
        assert!(parse_ready_port("not json").is_none());
        assert!(parse_ready_port("").is_none());
        assert!(parse_ready_port("   ").is_none());
    }

    #[test]
    fn ready_parser_rejects_port_zero() {
        // Port 0 would mean "unassigned"; we only accept a real bound port.
        assert!(parse_ready_port(r#"{"type":"ready","port":0}"#).is_none());
    }

    #[test]
    fn ready_parser_rejects_out_of_range_port() {
        assert!(parse_ready_port(r#"{"type":"ready","port":999999}"#).is_none());
    }

    #[test]
    fn handshake_token_is_64_hex_chars() {
        let token = generate_handshake_token();
        assert_eq!(token.len(), 64);
        assert!(token.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn two_handshake_tokens_are_distinct() {
        // Sanity check: we don't want a stubbed RNG to collapse tokens.
        let a = generate_handshake_token();
        let b = generate_handshake_token();
        assert_ne!(a, b);
    }
}

