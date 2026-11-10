//! Open managed attachment copies directly; export only on an explicit Save As action.
use std::hash::{Hash, Hasher};
use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

fn safe_name(name: &str) -> String {
    name.chars()
        .map(|c| {
            if c.is_control() || "/\\:*?\"<>|".contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect::<String>()
        .trim_matches('.')
        .to_string()
}

pub(crate) fn can_open(name: &str) -> bool {
    let ext = name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    matches!(
        ext.as_str(),
        "txt"
            | "log"
            | "md"
            | "markdown"
            | "json"
            | "csv"
            | "tsv"
            | "pdf"
            | "png"
            | "jpg"
            | "jpeg"
            | "gif"
            | "webp"
            | "bmp"
            | "heic"
            | "heif"
            | "tif"
            | "tiff"
            | "mp3"
            | "wav"
            | "ogg"
            | "m4a"
            | "flac"
            | "mp4"
            | "webm"
            | "mov"
            | "doc"
            | "docx"
            | "xls"
            | "xlsx"
            | "ppt"
            | "pptx"
            | "odt"
            | "ods"
            | "odp"
    )
}

#[tauri::command]
pub async fn save_attachment(
    app: tauri::AppHandle,
    bytes: Vec<u8>,
    file_name: String,
) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let name = safe_name(&file_name);
        if name.is_empty() {
            return Err("Invalid filename".to_string());
        }
        let Some(destination) = app
            .dialog()
            .file()
            .set_file_name(&name)
            .blocking_save_file()
        else {
            return Ok(None);
        };
        let path = destination.into_path().map_err(|e| e.to_string())?;
        std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
        Ok(Some(path.to_string_lossy().into_owned()))
    })
    .await
    .map_err(|e| e.to_string())?
}

fn private_directory(path: &Path) -> Result<(), String> {
    let mut builder = std::fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    match builder.create(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            let metadata = std::fs::symlink_metadata(path).map_err(|e| e.to_string())?;
            if metadata.is_dir() && !metadata.file_type().is_symlink() {
                Ok(())
            } else {
                Err("Invalid attachment cache directory".to_string())
            }
        }
        Err(error) => Err(error.to_string()),
    }
}

fn cached_attachment(root: &Path, bytes: &[u8], file_name: &str) -> Result<PathBuf, String> {
    let name = safe_name(file_name);
    if name.is_empty() || !can_open(&name) {
        return Err("Unsupported external file type".to_string());
    }
    private_directory(root)?;
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    name.hash(&mut hasher);
    bytes.hash(&mut hasher);
    let directory = root.join(format!("{:016x}", hasher.finish()));
    private_directory(&directory)?;
    let mut path = directory.join(&name);
    match std::fs::symlink_metadata(&path) {
        Ok(metadata) => {
            if !metadata.is_file() || metadata.file_type().is_symlink() {
                return Err("Invalid attachment cache file".to_string());
            }
            if std::fs::read(&path).map_err(|e| e.to_string())? == bytes {
                return Ok(path);
            }
            // External edits are never overwritten; open a fresh original copy.
            let fresh = root.join(crate::generate_handshake_token());
            private_directory(&fresh)?;
            path = fresh.join(&name);
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.to_string()),
    }
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&path).map_err(|e| e.to_string())?;
    file.write_all(bytes).map_err(|e| e.to_string())?;
    Ok(path)
}

#[tauri::command]
pub async fn open_attachment(
    app: tauri::AppHandle,
    bytes: Vec<u8>,
    file_name: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let cache = app.path().app_cache_dir().map_err(|e| e.to_string())?;
        std::fs::create_dir_all(&cache).map_err(|e| e.to_string())?;
        let path = cached_attachment(&cache.join("attachment-preview"), &bytes, &file_name)?;
        crate::workspace_open::open_with_default_app(&path)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn filenames_stay_plain_and_code_does_not_launch() {
        assert_eq!(safe_name("../../a\\b\n.txt"), "_.._a_b_.txt");
        assert!(can_open("report.DOCX"));
        for name in ["photo.HEIC", "photo.heif", "scan.tiff", "scan.tif"] {
            assert!(can_open(name));
        }
        for name in [
            "run.exe",
            "run.sh",
            "page.html",
            "app.desktop",
            "script.bat",
            "link.url",
            "report.pdf.exe",
        ] {
            assert!(!can_open(name));
        }
    }
    #[test]
    fn direct_open_reuses_original_cache_and_preserves_external_edits() {
        let root = std::env::temp_dir().join(format!(
            "openhorn-attachment-test-{}",
            crate::generate_handshake_token()
        ));
        let bytes = b"first\noriginal\nlast\n";
        let first = cached_attachment(&root, bytes, "notes.txt").unwrap();
        assert_eq!(std::fs::read(&first).unwrap(), bytes);
        assert_eq!(cached_attachment(&root, bytes, "notes.txt").unwrap(), first);
        std::fs::write(&first, b"external edit").unwrap();
        let fresh = cached_attachment(&root, bytes, "notes.txt").unwrap();
        assert_ne!(first, fresh);
        assert_eq!(std::fs::read(&first).unwrap(), b"external edit");
        assert_eq!(std::fs::read(&fresh).unwrap(), bytes);
        assert!(cached_attachment(&root, bytes, "run.sh").is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn direct_open_rejects_symlink_cache_roots_and_keeps_bytes_private() {
        use std::os::unix::{fs::symlink, fs::PermissionsExt};
        let base = std::env::temp_dir().join(format!(
            "openhorn-attachment-test-{}",
            crate::generate_handshake_token()
        ));
        std::fs::create_dir(&base).unwrap();
        let root = base.join("cache");
        let file = cached_attachment(&root, b"private", "notes.txt").unwrap();
        assert_eq!(
            std::fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            std::fs::metadata(&root).unwrap().permissions().mode() & 0o777,
            0o700
        );
        let alias = base.join("alias");
        symlink(&root, &alias).unwrap();
        assert!(cached_attachment(&alias, b"other", "notes.txt").is_err());
        std::fs::remove_dir_all(base).unwrap();
    }
}
