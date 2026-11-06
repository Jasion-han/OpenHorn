//! Explicit, read-only local UI references. Sidecar workspace access is unchanged.
use serde::Serialize;
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};

const MAX_PREVIEW_BYTES: u64 = 20 * 1024 * 1024;

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum PathError {
    NotFound,
    PermissionDenied,
    NotAbsolute,
    NotFile,
    TooLarge,
    UnsupportedOpen,
    Unavailable,
    MainViewOnly,
}
fn io_error(error: std::io::Error) -> PathError {
    match error.kind() {
        std::io::ErrorKind::NotFound => PathError::NotFound,
        std::io::ErrorKind::PermissionDenied => PathError::PermissionDenied,
        _ => PathError::Unavailable,
    }
}
fn main_only(label: &str) -> Result<(), PathError> {
    if label == "main" {
        Ok(())
    } else {
        Err(PathError::MainViewOnly)
    }
}
fn resolve(path: &str) -> Result<PathBuf, PathError> {
    let expanded = if let Some(tail) = path.strip_prefix("~/") {
        let home = std::env::var_os("HOME")
            .or_else(|| std::env::var_os("USERPROFILE"))
            .ok_or(PathError::NotAbsolute)?;
        PathBuf::from(home).join(tail)
    } else {
        PathBuf::from(path)
    };
    if !expanded.is_absolute() {
        return Err(PathError::NotAbsolute);
    }
    fs::canonicalize(expanded).map_err(io_error)
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalPathInfo {
    path: String,
    file_name: String,
    kind: &'static str,
    size: u64,
}
fn inspect(path: &str) -> Result<LocalPathInfo, PathError> {
    let resolved = resolve(path)?;
    let metadata = fs::metadata(&resolved).map_err(io_error)?;
    let kind = if metadata.is_dir() {
        "directory"
    } else if metadata.is_file() {
        "file"
    } else {
        return Err(PathError::NotFile);
    };
    Ok(LocalPathInfo {
        path: resolved.to_string_lossy().into_owned(),
        file_name: resolved
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.to_string()),
        kind,
        size: metadata.len(),
    })
}
fn read(path: &str) -> Result<Vec<u8>, PathError> {
    let resolved = resolve(path)?;
    let metadata = fs::metadata(&resolved).map_err(io_error)?;
    if !metadata.is_file() {
        return Err(PathError::NotFile);
    }
    if metadata.len() > MAX_PREVIEW_BYTES {
        return Err(PathError::TooLarge);
    }
    let mut bytes = Vec::new();
    File::open(resolved)
        .map_err(io_error)?
        .take(MAX_PREVIEW_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(io_error)?;
    if bytes.len() as u64 > MAX_PREVIEW_BYTES {
        return Err(PathError::TooLarge);
    }
    Ok(bytes)
}
fn open_directory(path: &Path) -> Result<(), PathError> {
    // Application bundles are shown in Finder, never launched as directories.
    #[cfg(target_os = "macos")]
    if path
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("app"))
    {
        return crate::workspace_open::reveal_in_file_manager(path)
            .map_err(|_| PathError::Unavailable);
    }
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = std::process::Command::new("open");
        command.args(["-a", "Finder"]);
        command
    };
    #[cfg(target_os = "linux")]
    let mut command = std::process::Command::new("xdg-open");
    #[cfg(target_os = "windows")]
    let mut command = std::process::Command::new("explorer.exe");
    command.arg(path);
    crate::workspace_open::spawn_detached(command).map_err(|_| PathError::Unavailable)
}

#[tauri::command]
pub async fn inspect_local_path(
    webview: tauri::Webview,
    path: String,
) -> Result<LocalPathInfo, PathError> {
    main_only(webview.label())?;
    tauri::async_runtime::spawn_blocking(move || inspect(&path))
        .await
        .map_err(|_| PathError::Unavailable)?
}
#[tauri::command]
pub async fn read_local_path(webview: tauri::Webview, path: String) -> Result<Vec<u8>, PathError> {
    main_only(webview.label())?;
    tauri::async_runtime::spawn_blocking(move || read(&path))
        .await
        .map_err(|_| PathError::Unavailable)?
}
#[tauri::command]
pub async fn open_local_path(webview: tauri::Webview, path: String) -> Result<(), PathError> {
    main_only(webview.label())?;
    tauri::async_runtime::spawn_blocking(move || {
        let info = inspect(&path)?;
        let resolved = Path::new(&info.path);
        if info.kind == "directory" {
            return open_directory(resolved);
        }
        if !crate::attachment_preview::can_open(&info.file_name) {
            return Err(PathError::UnsupportedOpen);
        }
        crate::workspace_open::open_with_default_app(resolved).map_err(|_| PathError::Unavailable)
    })
    .await
    .map_err(|_| PathError::Unavailable)?
}
#[tauri::command]
pub async fn reveal_local_path(webview: tauri::Webview, path: String) -> Result<(), PathError> {
    main_only(webview.label())?;
    tauri::async_runtime::spawn_blocking(move || {
        let info = inspect(&path)?;
        crate::workspace_open::reveal_in_file_manager(Path::new(&info.path))
            .map_err(|_| PathError::Unavailable)
    })
    .await
    .map_err(|_| PathError::Unavailable)?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "openhorn-local-path-{}",
            crate::generate_handshake_token()
        ));
        fs::create_dir(&path).unwrap();
        path
    }
    #[test]
    fn actual_bytes_directories_missing_and_size_limit() {
        let root = fixture();
        let path = root.join("中文 notes.txt");
        fs::write(&path, "first\n原文\nlast").unwrap();
        let info = inspect(path.to_str().unwrap()).unwrap();
        assert_eq!(info.kind, "file");
        assert_eq!(info.file_name, "中文 notes.txt");
        assert_eq!(
            read(path.to_str().unwrap()).unwrap(),
            "first\n原文\nlast".as_bytes()
        );
        assert_eq!(inspect(root.to_str().unwrap()).unwrap().kind, "directory");
        assert_eq!(
            read(root.to_str().unwrap()).unwrap_err(),
            PathError::NotFile
        );
        fs::remove_file(&path).unwrap();
        assert_eq!(
            inspect(path.to_str().unwrap()).unwrap_err(),
            PathError::NotFound
        );
        assert_eq!(
            read(path.to_str().unwrap()).unwrap_err(),
            PathError::NotFound
        );
        File::create(&path)
            .unwrap()
            .set_len(MAX_PREVIEW_BYTES + 1)
            .unwrap();
        assert_eq!(
            read(path.to_str().unwrap()).unwrap_err(),
            PathError::TooLarge
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn remote_webviews_and_relative_paths_do_not_get_local_access() {
        assert_eq!(
            main_only("preview-remote").unwrap_err(),
            PathError::MainViewOnly
        );
        assert_eq!(main_only("main"), Ok(()));
        assert_eq!(read("relative.txt").unwrap_err(), PathError::NotAbsolute);
    }
    #[cfg(unix)]
    #[test]
    fn symlinks_are_resolved_and_special_files_are_not_read() {
        use std::os::unix::fs::symlink;
        let root = fixture();
        let path = root.join("original.txt");
        let alias = root.join("alias.txt");
        fs::write(&path, "actual").unwrap();
        symlink(&path, &alias).unwrap();
        assert_eq!(
            inspect(alias.to_str().unwrap()).unwrap().path,
            fs::canonicalize(&path).unwrap().to_string_lossy()
        );
        assert_eq!(read(alias.to_str().unwrap()).unwrap(), b"actual");
        assert_eq!(read("/dev/null").unwrap_err(), PathError::NotFile);
        fs::remove_dir_all(root).unwrap();
    }
}
