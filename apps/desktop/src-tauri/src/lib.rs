#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  use tauri::Manager;
  use std::io::{BufRead, BufReader};
  use std::process::{Child, Command, Stdio};
  use std::sync::Mutex;

  #[derive(Clone, serde::Serialize)]
  struct SidecarInfoDto {
    ws_url: String,
    token: String,
  }

  struct SidecarState {
    info: Mutex<Option<SidecarInfoDto>>,
    child: Mutex<Option<Child>>,
  }

  impl SidecarState {
    fn new() -> Self {
      Self {
        info: Mutex::new(None),
        child: Mutex::new(None),
      }
    }
  }

  impl Drop for SidecarState {
    fn drop(&mut self) {
      if let Ok(mut child) = self.child.lock() {
        if let Some(mut c) = child.take() {
          let _ = c.kill();
        }
      }
    }
  }

  #[tauri::command]
  fn get_sidecar_info(state: tauri::State<'_, SidecarState>) -> Option<SidecarInfoDto> {
    state.info.lock().ok().and_then(|g| g.clone())
  }

  fn try_spawn_sidecar(state: &SidecarState) -> Result<(), String> {
    let token = uuid::Uuid::new_v4().to_string();

    let manifest_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let repo_root = manifest_dir
      .parent().and_then(|p| p.parent()).and_then(|p| p.parent())
      .ok_or_else(|| "Unable to resolve repo root".to_string())?
      .to_path_buf();
    let entry = repo_root.join("apps/sidecar/src/index.ts");

    let mut child = Command::new("bun")
      .arg("run")
      .arg(entry)
      .env("OPENHORN_HANDSHAKE_TOKEN", &token)
      .env("OPENHORN_HOST", "127.0.0.1")
      .env("OPENHORN_PORT", "0")
      .stdout(Stdio::piped())
      .stderr(Stdio::piped())
      .spawn()
      .map_err(|e| format!("Failed to spawn sidecar: {e}"))?;

    let stdout = child.stdout.take().ok_or_else(|| "Sidecar stdout missing".to_string())?;
    let reader = BufReader::new(stdout);

    for line in reader.lines().take(50) {
      let line = line.map_err(|e| format!("Read sidecar stdout: {e}"))?;
      let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
        continue;
      };
      if value.get("type").and_then(|v| v.as_str()) != Some("ready") {
        continue;
      }
      let port = value.get("port").and_then(|v| v.as_u64())
        .ok_or_else(|| "Sidecar ready payload missing port".to_string())?;
      let ws_url = format!("ws://127.0.0.1:{port}");

      {
        let mut info = state.info.lock().map_err(|_| "Sidecar state lock poisoned".to_string())?;
        *info = Some(SidecarInfoDto { ws_url, token });
      }
      {
        let mut c = state.child.lock().map_err(|_| "Sidecar state lock poisoned".to_string())?;
        *c = Some(child);
      }
      return Ok(());
    }

    let _ = child.kill();
    Err("Sidecar did not report ready state".to_string())
  }

  tauri::Builder::default()
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }

      let state = SidecarState::new();
      if let Err(err) = try_spawn_sidecar(&state) {
        log::error!("Sidecar spawn failed: {}", err);
      }
      app.manage(state);

      Ok(())
    })
    .invoke_handler(tauri::generate_handler![get_sidecar_info])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
