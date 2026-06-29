use std::env;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use rand::rngs::OsRng;
use rand::RngCore;
use serde::Serialize;
use tauri::{Manager, State, WebviewUrl, WebviewWindowBuilder};
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

/// One MCP server discovered in (or parsed out of) an existing client
/// config on the user's machine, normalised into OpenHorn's shape.
#[derive(Clone, Debug, Serialize)]
struct DiscoveredServer {
    /// The source this entry was parsed from, e.g. "CC-Switch".
    client: String,
    /// Every platform this same tool was found in, accumulated during dedup so
    /// the UI can show coverage (e.g. "CC-Switch · Codex · Gemini") on one row.
    clients: Vec<String>,
    name: String,
    #[serde(rename = "type")]
    server_type: String,
    config: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    /// Tool-identity key used to dedup the same tool seen across platforms.
    signature: String,
}

/// Normalise a single server entry into OpenHorn's shape. Tolerant of the
/// field variations seen across clients:
///   - `type`: explicit "stdio"/"http"/"sse" is respected; OpenCode's
///     "local"/"remote" map to stdio/http; otherwise inferred from command/url.
///   - `command`: string, or an array whose first item is the command.
///   - args/env: `args`, `env` or OpenCode's `environment`.
///   - url/headers: `url` or `httpUrl`; `headers` or Codex's `http_headers`.
/// A foreign `disabled` flag is ignored — import is opt-in per checkbox, and
/// OpenHorn carries its own enable toggle, so we never hide a server just
/// because another client has it switched off.
fn normalize_entry(
    client: &str,
    name: &str,
    val: &serde_json::Value,
    description: Option<String>,
) -> Option<DiscoveredServer> {
    let obj = val.as_object()?;

    let declared = obj.get("type").and_then(|v| v.as_str()).unwrap_or("");
    let url = obj
        .get("url")
        .or_else(|| obj.get("httpUrl"))
        .and_then(|v| v.as_str());

    let is_remote = url.is_some()
        || declared.eq_ignore_ascii_case("http")
        || declared.eq_ignore_ascii_case("sse")
        || declared.eq_ignore_ascii_case("remote");

    if is_remote {
        let url = url?;
        let server_type = if declared.eq_ignore_ascii_case("sse") {
            "sse"
        } else {
            "http"
        };
        let mut config = serde_json::Map::new();
        config.insert("url".into(), serde_json::Value::String(url.to_string()));
        if let Some(headers) = obj.get("headers").or_else(|| obj.get("http_headers")) {
            config.insert("headers".into(), headers.clone());
        }
        let config = serde_json::Value::Object(config);
        let signature = config_signature(server_type, name, &config);
        return Some(DiscoveredServer {
            client: client.to_string(),
            clients: vec![client.to_string()],
            name: name.to_string(),
            server_type: server_type.to_string(),
            config,
            description,
            signature,
        });
    }

    // stdio: `command` is a string, or an array whose first item is the binary.
    let mut args: Vec<serde_json::Value> = Vec::new();
    let command = match obj.get("command") {
        Some(serde_json::Value::String(s)) => s.clone(),
        Some(serde_json::Value::Array(items)) => {
            let strings: Vec<String> = items
                .iter()
                .filter_map(|x| x.as_str().map(|s| s.to_string()))
                .collect();
            let mut iter = strings.into_iter();
            let cmd = iter.next()?;
            args.extend(iter.map(serde_json::Value::String));
            cmd
        }
        _ => return None,
    };

    if let Some(serde_json::Value::Array(extra)) = obj.get("args") {
        args.extend(extra.iter().cloned());
    }

    let mut config = serde_json::Map::new();
    config.insert("command".into(), serde_json::Value::String(command));
    if !args.is_empty() {
        config.insert("args".into(), serde_json::Value::Array(args));
    }
    if let Some(env) = obj.get("env").or_else(|| obj.get("environment")) {
        config.insert("env".into(), env.clone());
    }

    let config = serde_json::Value::Object(config);
    let signature = config_signature("stdio", name, &config);
    Some(DiscoveredServer {
        client: client.to_string(),
        clients: vec![client.to_string()],
        name: name.to_string(),
        server_type: "stdio".to_string(),
        config,
        description,
        signature,
    })
}

/// Pull MCP servers out of an already-parsed JSON value, accepting the various
/// top-level keys used across clients: `mcpServers` (Claude/Cursor/Gemini),
/// `servers` (VS Code), `mcp_servers` (Codex), `mcp` (OpenCode).
fn extract_servers(client: &str, root: &serde_json::Value) -> Vec<DiscoveredServer> {
    let mut out = Vec::new();
    let servers = root
        .get("mcpServers")
        .or_else(|| root.get("servers"))
        .or_else(|| root.get("mcp_servers"))
        .or_else(|| root.get("mcp"));
    if let Some(serde_json::Value::Object(map)) = servers {
        for (name, val) in map {
            if let Some(ds) = normalize_entry(client, name, val, None) {
                out.push(ds);
            }
        }
    }
    out
}

fn parse_json_mcp(client: &str, content: &str) -> Vec<DiscoveredServer> {
    match serde_json::from_str::<serde_json::Value>(content) {
        Ok(root) => extract_servers(client, &root),
        Err(_) => Vec::new(),
    }
}

fn parse_toml_mcp(client: &str, content: &str) -> Vec<DiscoveredServer> {
    let toml_val: toml::Value = match toml::from_str(content) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    match serde_json::to_value(&toml_val) {
        Ok(json) => extract_servers(client, &json),
        Err(_) => Vec::new(),
    }
}

/// Reads CC Switch's SQLite store (the user's global MCP manager). Its
/// `mcp_servers` table is the authoritative list — each row's `server_config`
/// is the per-server JSON. Opened read-only; missing/locked DBs are skipped.
fn read_ccswitch_db(path: &std::path::Path) -> Vec<DiscoveredServer> {
    let mut out = Vec::new();
    if !path.exists() {
        return out;
    }
    let conn = match rusqlite::Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    ) {
        Ok(c) => c,
        Err(_) => return out,
    };
    let mut stmt = match conn.prepare("SELECT name, server_config, description FROM mcp_servers") {
        Ok(s) => s,
        Err(_) => return out,
    };
    let rows = stmt.query_map([], |row| {
        let name: String = row.get(0)?;
        let cfg: String = row.get(1)?;
        let desc: Option<String> = row.get(2).ok().flatten();
        Ok((name, cfg, desc))
    });
    if let Ok(rows) = rows {
        for (name, cfg, desc) in rows.flatten() {
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(&cfg) {
                let desc = desc.filter(|d| !d.trim().is_empty());
                if let Some(ds) = normalize_entry("CC-Switch", &name, &val, desc) {
                    out.push(ds);
                }
            }
        }
    }
    out
}

/// Strips a trailing `@version` (e.g. `firecrawl-mcp@latest` → `firecrawl-mcp`)
/// while leaving a scoped package's leading `@` intact (`@scope/pkg`).
fn strip_version(arg: &str) -> String {
    if let Some(idx) = arg.rfind('@') {
        if idx > 0 && !arg[idx + 1..].contains('/') {
            return arg[..idx].to_string();
        }
    }
    arg.to_string()
}

/// A signature identifying the underlying tool, so the same server collapses
/// even when different clients gave it different display names (e.g. ccswitch's
/// `firecrawl-mcp` vs VS Code's `firecrawl`, both `npx … firecrawl-mcp`).
/// Remote servers key on URL; stdio servers key on command + package args with
/// version suffixes and leading flags (`-y`, …) removed. Differing args (e.g. a
/// filesystem root path) keep distinct signatures, avoiding false merges.
fn config_signature(server_type: &str, name: &str, config: &serde_json::Value) -> String {
    if server_type != "stdio" {
        if let Some(url) = config.get("url").and_then(|v| v.as_str()) {
            return format!("url:{}", url.trim().trim_end_matches('/').to_lowercase());
        }
        return format!("name:{}", name.to_lowercase());
    }
    let command = config.get("command").and_then(|v| v.as_str()).unwrap_or("");
    let mut tokens: Vec<String> = vec![command.to_lowercase()];
    if let Some(serde_json::Value::Array(args)) = config.get("args") {
        for a in args {
            if let Some(s) = a.as_str() {
                if s.starts_with('-') {
                    continue;
                }
                tokens.push(strip_version(s).to_lowercase());
            }
        }
    }
    // No package arg to key on — fall back to the name to avoid over-merging
    // unrelated bare-command entries.
    if tokens.len() == 1 {
        tokens.push(name.to_lowercase());
    }
    format!("stdio:{}", tokens.join(" "))
}

/// Scans the known config locations of common MCP clients (plus the CC Switch
/// store) and returns each distinct tool once, with `clients` listing every
/// platform it was found in (CC Switch first, then Claude Code, …). Dedup is by
/// tool signature. Missing/unreadable sources are skipped.
#[tauri::command]
fn mcp_discover_configs(app: tauri::AppHandle) -> Vec<DiscoveredServer> {
    let mut all: Vec<DiscoveredServer> = Vec::new();
    let home = app.path().home_dir().ok();
    let config = app.path().config_dir().ok();

    // CC Switch first — it's the user's global source of truth, and carries
    // descriptions, so it wins the dedup against per-client copies.
    if let Some(dir) = &home {
        all.extend(read_ccswitch_db(&dir.join(".cc-switch").join("cc-switch.db")));
    }
    // Claude Code (CLI) — global config and project-scoped file.
    if let Some(dir) = &home {
        if let Ok(content) = fs::read_to_string(dir.join(".claude.json")) {
            all.extend(parse_json_mcp("Claude Code", &content));
        }
        if let Ok(content) = fs::read_to_string(dir.join(".claude").join(".mcp.json")) {
            all.extend(parse_json_mcp("Claude Code", &content));
        }
    }
    // Codex CLI (TOML).
    if let Some(dir) = &home {
        if let Ok(content) = fs::read_to_string(dir.join(".codex").join("config.toml")) {
            all.extend(parse_toml_mcp("Codex CLI", &content));
        }
    }
    // Gemini CLI.
    if let Some(dir) = &home {
        if let Ok(content) = fs::read_to_string(dir.join(".gemini").join("settings.json")) {
            all.extend(parse_json_mcp("Gemini CLI", &content));
        }
    }
    // Cursor.
    if let Some(dir) = &home {
        if let Ok(content) = fs::read_to_string(dir.join(".cursor").join("mcp.json")) {
            all.extend(parse_json_mcp("Cursor", &content));
        }
    }
    // OpenCode.
    if let Some(dir) = &home {
        let path = dir.join(".config").join("opencode").join("opencode.json");
        if let Ok(content) = fs::read_to_string(&path) {
            all.extend(parse_json_mcp("OpenCode", &content));
        }
    }
    // Claude Desktop app.
    if let Some(dir) = &config {
        let path = dir.join("Claude").join("claude_desktop_config.json");
        if let Ok(content) = fs::read_to_string(&path) {
            all.extend(parse_json_mcp("Claude Desktop", &content));
        }
    }

    // Dedup by tool signature so each tool appears once, accumulating the list
    // of platforms it was found in. First occurrence (CC Switch, then Claude
    // Code, …) wins its name/config; later matches just contribute their
    // platform label and a description if the winner lacked one.
    let mut result: Vec<DiscoveredServer> = Vec::new();
    let mut idx_by_sig: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for server in all {
        if let Some(&i) = idx_by_sig.get(&server.signature) {
            if !result[i].clients.contains(&server.client) {
                result[i].clients.push(server.client.clone());
            }
            if result[i].description.is_none() && server.description.is_some() {
                result[i].description = server.description.clone();
            }
        } else {
            idx_by_sig.insert(server.signature.clone(), result.len());
            result.push(server);
        }
    }
    result
}

/// Opens a file picker and parses the chosen config file. Returns None when
/// the user cancels. Picks JSON vs TOML by extension, falling back to the
/// other parser if the first yields nothing.
#[tauri::command]
async fn mcp_pick_config_file(
    app: tauri::AppHandle,
) -> Result<Option<Vec<DiscoveredServer>>, String> {
    use tauri_plugin_dialog::DialogExt;

    let picked = app
        .dialog()
        .file()
        .add_filter("MCP config", &["json", "toml"])
        .blocking_pick_file();

    let Some(file_path) = picked else {
        return Ok(None);
    };

    let path = PathBuf::from(file_path.to_string());
    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let client = "导入的文件";

    let is_toml = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("toml"))
        .unwrap_or(false);

    let servers = if is_toml {
        parse_toml_mcp(client, &content)
    } else {
        let mut parsed = parse_json_mcp(client, &content);
        if parsed.is_empty() {
            parsed = parse_toml_mcp(client, &content);
        }
        parsed
    };

    Ok(Some(servers))
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

            let url = WebviewUrl::default();
            WebviewWindowBuilder::new(app, "main", url)
                .title("OpenHorn")
                .inner_size(1200.0, 800.0)
                .resizable(true)
                .on_navigation(|url| {
                    let s = url.as_str();
                    if s.starts_with("http://localhost") || s.starts_with("https://localhost") || s.starts_with("tauri://") {
                        return true;
                    }
                    #[cfg(target_os = "macos")]
                    {
                        let _ = std::process::Command::new("open").arg(s).spawn();
                    }
                    #[cfg(target_os = "linux")]
                    {
                        let _ = std::process::Command::new("xdg-open").arg(s).spawn();
                    }
                    #[cfg(target_os = "windows")]
                    {
                        let _ = std::process::Command::new("cmd").args(["/c", "start", s]).spawn();
                    }
                    false
                })
                .build()?;

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
            pick_workspace_dir,
            mcp_discover_configs,
            mcp_pick_config_file
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

