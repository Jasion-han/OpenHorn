//! Opens a workspace file in the user's editor of choice (or the OS default
//! application), reveals it in the file manager, and detects installed
//! editors so the frontend can offer a real list instead of guessing.
//!
//! The shell plugin's default `open` scope only allows http(s)/mailto/tel, so
//! `file://` URLs from the webview are rejected there. Rather than widening
//! that scope (which would let the webview open any local file or app), these
//! commands accept a workspace root plus a path and only touch regular files
//! that resolve to somewhere under that root after canonicalisation.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

/// Resolves `path` (relative to `workspace_root` unless absolute) and returns
/// the canonical file path if it is a regular file inside the canonical root.
fn resolve_workspace_file(workspace_root: &str, path: &str) -> Result<PathBuf, String> {
    let root = Path::new(workspace_root);
    if workspace_root.is_empty() || !root.is_absolute() {
        return Err(format!("工作区根目录必须是绝对路径：{workspace_root}"));
    }
    if path.is_empty() {
        return Err("文件路径为空".to_string());
    }
    let canonical_root = fs::canonicalize(root)
        .map_err(|e| format!("工作区根目录不可用：{workspace_root}（{e}）"))?;
    let candidate = root.join(path);
    let canonical_file =
        fs::canonicalize(&candidate).map_err(|e| format!("文件不存在或无法访问：{path}（{e}）"))?;
    if !canonical_file.starts_with(&canonical_root) {
        return Err(format!("文件不在当前工作区内，已拒绝打开：{path}"));
    }
    if !canonical_file.is_file() {
        return Err(format!("目标不是普通文件，已拒绝打开：{path}"));
    }
    Ok(canonical_file)
}

/// Spawns a fire-and-forget launcher process with no inherited stdio and a
/// background thread that reaps it, so each click does not leave a zombie
/// `open` / `code` behind for the lifetime of the app.
fn spawn_detached(mut command: std::process::Command) -> std::io::Result<()> {
    let mut child = command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

fn open_with_default_app(file: &Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let mut command = std::process::Command::new("open");
    #[cfg(target_os = "linux")]
    let mut command = std::process::Command::new("xdg-open");
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut c = std::process::Command::new("cmd");
        c.args(["/c", "start", ""]);
        c
    };
    command.arg(file);
    spawn_detached(command).map_err(|e| format!("无法启动系统默认应用：{e}"))
}

/// The editor the frontend wants a file opened with. `id` is one of the
/// detected-editor ids below (drives the line-number argv shape); a custom
/// `.app` picked by the user has no id and is launched with just the file.
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct EditorChoice {
    pub id: Option<String>,
    pub app_path: String,
}

/// Builds the argv for an editor's command-line entry point, encoding the
/// per-editor way of jumping to a line. Kept pure so it can be unit-tested
/// without launching anything.
pub fn editor_argv(id: Option<&str>, file: &Path, line: Option<u32>) -> Vec<String> {
    let file_str = file.to_string_lossy().into_owned();
    let Some(line) = line else {
        return vec![file_str];
    };
    match id {
        Some("vscode") | Some("cursor") | Some("windsurf") => {
            vec!["-g".to_string(), format!("{file_str}:{line}")]
        }
        Some("zed") | Some("sublime") => vec![format!("{file_str}:{line}")],
        Some(id) if id.starts_with("jetbrains-") => {
            vec!["--line".to_string(), line.to_string(), file_str]
        }
        _ => vec![file_str],
    }
}

/// Candidate command-line entry points inside an editor's `.app` bundle,
/// relative to the bundle root, in preference order. These are what the
/// editors' own `code` / `subl` / `zed` / `idea` shell commands symlink to,
/// and unlike `open -a <app> --args …` they reach an already-running
/// instance (`open --args` only applies when the app is launched fresh, so
/// line numbers would silently be dropped in the common case).
pub fn bundled_cli_candidates(id: &str) -> Vec<&'static str> {
    match id {
        "vscode" => vec!["Contents/Resources/app/bin/code"],
        "cursor" => vec![
            "Contents/Resources/app/bin/cursor",
            "Contents/Resources/app/bin/code",
        ],
        "windsurf" => vec![
            "Contents/Resources/app/bin/windsurf",
            "Contents/Resources/app/bin/code",
        ],
        "zed" => vec!["Contents/MacOS/cli"],
        "sublime" => vec!["Contents/SharedSupport/bin/subl"],
        "jetbrains-idea" => vec!["Contents/MacOS/idea"],
        "jetbrains-webstorm" => vec!["Contents/MacOS/webstorm"],
        "jetbrains-pycharm" => vec!["Contents/MacOS/pycharm"],
        _ => vec![],
    }
}

/// A resolved way to launch the editor: `program` plus its `args`.
#[derive(Debug, PartialEq, Eq)]
pub struct LaunchPlan {
    pub program: String,
    pub args: Vec<String>,
}

/// Decides how to open `file` in the editor at `app_path`. With a line and a
/// known editor whose bundled CLI exists (per `exists`), the CLI is run with
/// `editor_argv`; otherwise the file is handed to the app through
/// `open -a <app> <file>`, which works for running apps but cannot carry a
/// line. Pure: the filesystem probe is injected so tests do not need bundles.
pub fn editor_launch_plan(
    id: Option<&str>,
    app_path: &Path,
    file: &Path,
    line: Option<u32>,
    exists: &dyn Fn(&Path) -> bool,
) -> LaunchPlan {
    if let (Some(id), Some(_)) = (id, line) {
        let cli = bundled_cli_candidates(id)
            .into_iter()
            .map(|rel| app_path.join(rel))
            .find(|p| exists(p));
        if let Some(cli) = cli {
            return LaunchPlan {
                program: cli.to_string_lossy().into_owned(),
                args: editor_argv(Some(id), file, line),
            };
        }
    }
    LaunchPlan {
        program: "open".to_string(),
        args: vec![
            "-a".to_string(),
            app_path.to_string_lossy().into_owned(),
            file.to_string_lossy().into_owned(),
        ],
    }
}

/// Validates the editor path the frontend sent before anything is launched
/// with it. On macOS it must canonicalise to a real `.app` bundle (directory
/// named `*.app` containing `Contents/Info.plist`); elsewhere it must be an
/// existing regular file (the editor executable). Anything else — a bare
/// script, a folder merely named `x.app`, a dangling symlink — is refused so
/// the webview cannot turn `open -a <path>` / `<path>/Contents/...` into
/// "run this arbitrary program".
fn resolve_editor_app(app_path: &str) -> Result<PathBuf, String> {
    let raw = Path::new(app_path);
    if app_path.is_empty() || !raw.is_absolute() {
        return Err(format!("编辑器路径必须是绝对路径：{app_path}"));
    }
    let canonical =
        fs::canonicalize(raw).map_err(|e| format!("编辑器不存在：{app_path}（{e}）"))?;
    #[cfg(target_os = "macos")]
    {
        let is_bundle = canonical.is_dir()
            && canonical
                .extension()
                .and_then(|ext| ext.to_str())
                .is_some_and(|ext| ext.eq_ignore_ascii_case("app"))
            && canonical.join("Contents/Info.plist").is_file();
        if !is_bundle {
            return Err(format!("不是有效的应用程序包（.app）：{app_path}"));
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        if !canonical.is_file() {
            return Err(format!("编辑器不是可执行文件：{app_path}"));
        }
    }
    Ok(canonical)
}

fn open_with_editor(file: &Path, line: Option<u32>, editor: &EditorChoice) -> Result<(), String> {
    let app_path = resolve_editor_app(&editor.app_path)?;
    // Line 0 is not a real line (references are 1-based); treat it as "no line".
    let line = line.filter(|n| *n > 0);
    #[cfg(target_os = "macos")]
    let plan = editor_launch_plan(editor.id.as_deref(), &app_path, file, line, &|p| {
        p.is_file()
    });
    // Non-macOS: `app_path` is the editor executable itself; run it with the argv.
    #[cfg(not(target_os = "macos"))]
    let plan = LaunchPlan {
        program: app_path.to_string_lossy().into_owned(),
        args: editor_argv(editor.id.as_deref(), file, line),
    };
    let mut command = std::process::Command::new(&plan.program);
    command.args(&plan.args);
    spawn_detached(command).map_err(|e| format!("无法启动编辑器 {}：{e}", editor.app_path))
}

/// Opens a file inside `workspace_root` with the chosen editor (jumping to
/// `line` when the editor supports it) or, without a choice, the system
/// default application. `path` may be relative to the root or absolute;
/// either way it must resolve to a regular file under the root.
#[tauri::command]
pub fn open_workspace_file(
    workspace_root: String,
    path: String,
    line: Option<u32>,
    editor: Option<EditorChoice>,
) -> Result<(), String> {
    let file = resolve_workspace_file(&workspace_root, &path)?;
    match editor {
        Some(editor) => open_with_editor(&file, line, &editor),
        None => open_with_default_app(&file),
    }
}

/// Reveals a workspace file in Finder (macOS) / the file manager.
#[tauri::command]
pub fn reveal_workspace_file(workspace_root: String, path: String) -> Result<(), String> {
    let file = resolve_workspace_file(&workspace_root, &path)?;
    #[cfg(target_os = "macos")]
    let command = {
        let mut c = std::process::Command::new("open");
        c.arg("-R").arg(&file);
        c
    };
    // No portable "reveal" on Linux/Windows; opening the parent folder is the
    // closest equivalent.
    #[cfg(target_os = "linux")]
    let command = {
        let mut c = std::process::Command::new("xdg-open");
        c.arg(file.parent().unwrap_or(&file));
        c
    };
    #[cfg(target_os = "windows")]
    let command = {
        let mut c = std::process::Command::new("explorer");
        c.arg(format!("/select,{}", file.display()));
        c
    };
    spawn_detached(command).map_err(|e| format!("无法在文件管理器中显示：{e}"))
}

/// One editor found on this machine.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DetectedEditor {
    pub id: String,
    pub name: String,
    pub app_path: String,
    /// Whether `editor_argv` knows how to jump to a line for this editor.
    pub supports_line: bool,
}

/// (id, display name, bundle file name). Order is the order shown to the user.
const KNOWN_EDITORS: &[(&str, &str, &str)] = &[
    ("cursor", "Cursor", "Cursor.app"),
    ("vscode", "Visual Studio Code", "Visual Studio Code.app"),
    ("windsurf", "Windsurf", "Windsurf.app"),
    ("zed", "Zed", "Zed.app"),
    ("sublime", "Sublime Text", "Sublime Text.app"),
    ("jetbrains-idea", "IntelliJ IDEA", "IntelliJ IDEA.app"),
    ("jetbrains-webstorm", "WebStorm", "WebStorm.app"),
    ("jetbrains-pycharm", "PyCharm", "PyCharm.app"),
    ("nova", "Nova", "Nova.app"),
    ("xcode", "Xcode", "Xcode.app"),
];

/// An editor "supports line" when we know its line syntax *and* the bundled
/// CLI that accepts it is actually present in this install.
fn editor_supports_line(id: &str, app_path: &Path) -> bool {
    bundled_cli_candidates(id)
        .into_iter()
        .any(|rel| app_path.join(rel).is_file())
}

/// Scans the given application folders for the known editor bundles and
/// returns those that actually exist, in `KNOWN_EDITORS` order. The first
/// folder containing a bundle wins.
pub fn detect_editors_in(app_dirs: &[PathBuf]) -> Vec<DetectedEditor> {
    KNOWN_EDITORS
        .iter()
        .filter_map(|(id, name, bundle)| {
            let found = app_dirs
                .iter()
                .map(|dir| dir.join(bundle))
                .find(|p| p.exists())?;
            Some(DetectedEditor {
                id: (*id).to_string(),
                name: (*name).to_string(),
                supports_line: editor_supports_line(id, &found),
                app_path: found.to_string_lossy().into_owned(),
            })
        })
        .collect()
}

/// Lists the known editors installed in `/Applications` or `~/Applications`.
#[tauri::command]
pub fn external_editors_detect(app: tauri::AppHandle) -> Vec<DetectedEditor> {
    use tauri::Manager;
    let mut dirs = vec![PathBuf::from("/Applications")];
    if let Ok(home) = app.path().home_dir() {
        dirs.push(home.join("Applications"));
    }
    detect_editors_in(&dirs)
}

/// Lets the user pick an application bundle to use as the editor. Returns the
/// absolute `.app` path, or None when cancelled.
///
/// On macOS this goes through NSOpenPanel with `canChooseFiles = YES`,
/// `canChooseDirectories = NO` and `allowedFileTypes = ["app"]` (that is what
/// rfd's `pick_file` + filter builds). NSOpenPanel treats file packages as
/// files unless `treatsFilePackagesAsDirectories` is set, so `.app` bundles
/// are selectable as a single item here rather than browsed into.
#[tauri::command]
pub async fn pick_editor_app(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let picked = app
        .dialog()
        .file()
        .set_directory("/Applications")
        .add_filter("应用", &["app"])
        .blocking_pick_file()
        .map(|p| p.to_string());

    Ok(picked)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    /// Fresh directory under the OS temp dir; removed on drop.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let n = COUNTER.fetch_add(1, Ordering::SeqCst);
            let dir = std::env::temp_dir().join(format!(
                "openhorn-workspace-open-{}-{n}",
                std::process::id()
            ));
            fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn open_workspace_accepts_regular_file_inside_root() {
        let tmp = TempDir::new();
        let root = tmp.0.join("ws");
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src/a.ts"), "x").unwrap();

        let resolved = resolve_workspace_file(root.to_str().unwrap(), "src/a.ts").unwrap();
        assert_eq!(resolved, fs::canonicalize(root.join("src/a.ts")).unwrap());
    }

    #[test]
    fn open_workspace_rejects_paths_escaping_root() {
        let tmp = TempDir::new();
        let root = tmp.0.join("ws");
        fs::create_dir_all(&root).unwrap();
        let outside = tmp.0.join("secret.txt");
        fs::write(&outside, "x").unwrap();

        // `..` traversal out of the root.
        let err = resolve_workspace_file(root.to_str().unwrap(), "../secret.txt").unwrap_err();
        assert!(err.contains("不在当前工作区内"), "{err}");

        // Absolute path outside the root.
        let err =
            resolve_workspace_file(root.to_str().unwrap(), outside.to_str().unwrap()).unwrap_err();
        assert!(err.contains("不在当前工作区内"), "{err}");

        // Relative root is refused outright.
        assert!(resolve_workspace_file("relative/root", "a.txt").is_err());
    }

    #[test]
    fn open_workspace_rejects_non_files() {
        let tmp = TempDir::new();
        let root = tmp.0.join("ws");
        fs::create_dir_all(root.join("dir")).unwrap();

        let err = resolve_workspace_file(root.to_str().unwrap(), "dir").unwrap_err();
        assert!(err.contains("不是普通文件"), "{err}");

        let err = resolve_workspace_file(root.to_str().unwrap(), "missing.txt").unwrap_err();
        assert!(err.contains("文件不存在"), "{err}");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn resolve_editor_app_only_accepts_real_bundles() {
        let tmp = TempDir::new();
        // A proper bundle: `.app` directory with Contents/Info.plist.
        let good = tmp.0.join("Good.app");
        fs::create_dir_all(good.join("Contents")).unwrap();
        fs::write(good.join("Contents/Info.plist"), "<plist/>").unwrap();
        assert_eq!(
            resolve_editor_app(good.to_str().unwrap()).unwrap(),
            fs::canonicalize(&good).unwrap()
        );
        // Symlink to the bundle resolves to the bundle itself.
        let link = tmp.0.join("Link.app");
        std::os::unix::fs::symlink(&good, &link).unwrap();
        assert_eq!(
            resolve_editor_app(link.to_str().unwrap()).unwrap(),
            fs::canonicalize(&good).unwrap()
        );

        // A directory named .app without Info.plist is not a bundle.
        let hollow = tmp.0.join("Hollow.app");
        fs::create_dir_all(&hollow).unwrap();
        assert!(resolve_editor_app(hollow.to_str().unwrap())
            .unwrap_err()
            .contains("不是有效的应用程序包"));

        // A plain executable / script is refused even if it exists.
        let script = tmp.0.join("evil.sh");
        fs::write(&script, "#!/bin/sh\n").unwrap();
        assert!(resolve_editor_app(script.to_str().unwrap()).is_err());
        // ...and so is a regular file merely named `.app`.
        let fake = tmp.0.join("Fake.app");
        fs::write(&fake, "x").unwrap();
        assert!(resolve_editor_app(fake.to_str().unwrap()).is_err());

        // Missing, relative and empty paths are refused before any launch.
        assert!(resolve_editor_app(tmp.0.join("Missing.app").to_str().unwrap()).is_err());
        assert!(resolve_editor_app("Applications/Cursor.app").is_err());
        assert!(resolve_editor_app("").is_err());
    }

    #[test]
    fn open_with_editor_refuses_bad_app_before_launching() {
        let tmp = TempDir::new();
        let file = tmp.0.join("a.ts");
        fs::write(&file, "x").unwrap();
        let script = tmp.0.join("evil.sh");
        fs::write(&script, "#!/bin/sh\n").unwrap();
        let choice = EditorChoice {
            id: Some("vscode".to_string()),
            app_path: script.to_string_lossy().into_owned(),
        };
        assert!(open_with_editor(&file, Some(1), &choice).is_err());
        let missing = EditorChoice {
            id: None,
            app_path: tmp.0.join("nope.app").to_string_lossy().into_owned(),
        };
        assert!(open_with_editor(&file, None, &missing).is_err());
    }

    #[test]
    fn line_zero_is_treated_as_no_line() {
        // Mirrors the `line.filter(|n| *n > 0)` in open_with_editor: a 0 must
        // never reach the argv builder as a real line.
        let file = Path::new("/ws/src/a.ts");
        let line = Some(0u32).filter(|n| *n > 0);
        assert_eq!(line, None);
        assert_eq!(
            editor_argv(Some("vscode"), file, line),
            vec!["/ws/src/a.ts".to_string()]
        );
    }

    #[test]
    fn editor_argv_encodes_line_per_editor_family() {
        let file = Path::new("/ws/src/a.ts");
        let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();

        for id in ["vscode", "cursor", "windsurf"] {
            assert_eq!(
                editor_argv(Some(id), file, Some(42)),
                s(&["-g", "/ws/src/a.ts:42"]),
                "{id}"
            );
        }
        for id in ["zed", "sublime"] {
            assert_eq!(
                editor_argv(Some(id), file, Some(42)),
                s(&["/ws/src/a.ts:42"]),
                "{id}"
            );
        }
        for id in ["jetbrains-idea", "jetbrains-webstorm", "jetbrains-pycharm"] {
            assert_eq!(
                editor_argv(Some(id), file, Some(42)),
                s(&["--line", "42", "/ws/src/a.ts"]),
                "{id}"
            );
        }
        // Editors without a known line syntax, and custom apps (no id), get the bare file.
        assert_eq!(
            editor_argv(Some("nova"), file, Some(42)),
            s(&["/ws/src/a.ts"])
        );
        assert_eq!(
            editor_argv(Some("xcode"), file, Some(42)),
            s(&["/ws/src/a.ts"])
        );
        assert_eq!(editor_argv(None, file, Some(42)), s(&["/ws/src/a.ts"]));
    }

    #[test]
    fn editor_argv_without_line_is_always_bare_file() {
        let file = Path::new("/ws/src/a.ts");
        for id in [
            Some("vscode"),
            Some("cursor"),
            Some("zed"),
            Some("sublime"),
            Some("jetbrains-idea"),
            Some("nova"),
            None,
        ] {
            assert_eq!(
                editor_argv(id, file, None),
                vec!["/ws/src/a.ts".to_string()],
                "{id:?}"
            );
        }
    }

    #[test]
    fn launch_plan_uses_bundled_cli_when_present() {
        let app = Path::new("/Applications/Visual Studio Code.app");
        let file = Path::new("/ws/src/a.ts");
        let has_code = |p: &Path| p.ends_with("Contents/Resources/app/bin/code");
        assert_eq!(
            editor_launch_plan(Some("vscode"), app, file, Some(7), &has_code),
            LaunchPlan {
                program: "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
                    .to_string(),
                args: vec!["-g".to_string(), "/ws/src/a.ts:7".to_string()],
            }
        );
        // Cursor without its own `cursor` script falls through to `code`.
        let cursor = Path::new("/Applications/Cursor.app");
        assert_eq!(
            editor_launch_plan(Some("cursor"), cursor, file, Some(7), &has_code).program,
            "/Applications/Cursor.app/Contents/Resources/app/bin/code"
        );
        let idea = Path::new("/Users/me/Applications/IntelliJ IDEA.app");
        assert_eq!(
            editor_launch_plan(Some("jetbrains-idea"), idea, file, Some(7), &|_| true),
            LaunchPlan {
                program: "/Users/me/Applications/IntelliJ IDEA.app/Contents/MacOS/idea".to_string(),
                args: vec![
                    "--line".to_string(),
                    "7".to_string(),
                    "/ws/src/a.ts".to_string()
                ],
            }
        );
    }

    #[test]
    fn launch_plan_falls_back_to_open_without_line_or_cli() {
        let app = Path::new("/Applications/Visual Studio Code.app");
        let file = Path::new("/ws/src/a.ts");
        let open_plan = LaunchPlan {
            program: "open".to_string(),
            args: vec![
                "-a".to_string(),
                "/Applications/Visual Studio Code.app".to_string(),
                "/ws/src/a.ts".to_string(),
            ],
        };
        // No line: plain open, even if the CLI exists.
        assert_eq!(
            editor_launch_plan(Some("vscode"), app, file, None, &|_| true),
            open_plan
        );
        // Line but no bundled CLI on disk.
        assert_eq!(
            editor_launch_plan(Some("vscode"), app, file, Some(3), &|_| false),
            open_plan
        );
        // Unknown / custom editor: never a CLI.
        assert_eq!(
            editor_launch_plan(None, app, file, Some(3), &|_| true),
            open_plan
        );
        assert_eq!(
            editor_launch_plan(Some("xcode"), app, file, Some(3), &|_| true),
            open_plan
        );
    }

    #[test]
    fn detect_editors_returns_only_existing_bundles_in_order() {
        let tmp = TempDir::new();
        let sys = tmp.0.join("Applications");
        let user = tmp.0.join("home/Applications");
        // Bundles are directories on disk; the detector only checks existence.
        fs::create_dir_all(sys.join("Visual Studio Code.app")).unwrap();
        // Only Cursor gets its bundled CLI, so only it reports line support.
        let cursor_cli = user.join("Cursor.app/Contents/Resources/app/bin");
        fs::create_dir_all(&cursor_cli).unwrap();
        fs::write(cursor_cli.join("cursor"), "#!/bin/sh").unwrap();
        fs::create_dir_all(sys.join("Xcode.app")).unwrap();
        fs::create_dir_all(user.join("Cursor.app")).unwrap();
        // Same bundle in both folders: the first folder wins.
        fs::create_dir_all(sys.join("Zed.app")).unwrap();
        fs::create_dir_all(user.join("Zed.app")).unwrap();

        let found = detect_editors_in(&[sys.clone(), user.clone()]);
        let ids: Vec<&str> = found.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(ids, vec!["cursor", "vscode", "zed", "xcode"]);
        assert_eq!(found[0].app_path, user.join("Cursor.app").to_string_lossy());
        assert_eq!(found[0].name, "Cursor");
        assert!(found[0].supports_line);
        assert!(!found[1].supports_line, "vscode bundle without its cli");
        assert_eq!(found[2].app_path, sys.join("Zed.app").to_string_lossy());
        assert!(!found[3].supports_line, "xcode has no line syntax");

        assert!(detect_editors_in(&[tmp.0.join("empty")]).is_empty());
    }
}
