//! Embedded browser for the reply-reference preview panel.
//!
//! Each web preview tab is backed by a native child webview (Tauri multiwebview,
//! `unstable` feature) stacked on top of the main webview. The frontend owns
//! layout: it reports the CSS-pixel rect of a placeholder element and we mirror
//! it 1:1 with `LogicalPosition` / `LogicalSize` (the main window uses a
//! full-size content view, so main-webview CSS px == window logical px).
//!
//! Child webviews load untrusted remote pages and therefore get no IPC
//! capabilities (see `capabilities/default.json`, scoped to `webviews: ["main"]`).

use serde::Serialize;
use tauri::webview::{NewWindowResponse, PageLoadEvent, WebviewBuilder};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Url, Webview, WebviewUrl};

#[cfg(target_os = "macos")]
use std::sync::mpsc;
#[cfg(target_os = "macos")]
use std::time::Duration;

const PAGE_LOAD_EVENT: &str = "preview-webview:page-load";
const TITLE_EVENT: &str = "preview-webview:title";
const MAIN_LABEL: &str = "main";
const LABEL_PREFIX: &str = "preview-";
const LABEL_ID_MAX_LEN: usize = 64;

#[derive(Serialize, Clone)]
struct PageLoadPayload {
    label: String,
    url: String,
    phase: &'static str,
}

#[derive(Serialize, Clone)]
struct TitlePayload {
    label: String,
    title: String,
}

/// Back/forward availability of a preview webview, mirrored into the toolbar's
/// disabled state.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HistoryState {
    pub can_go_back: bool,
    pub can_go_forward: bool,
}

// ---------------------------------------------------------------------------
// Native WKWebView access (macOS)
//
// `Webview::with_webview` hands the closure to the runtime as a user message.
// tauri-runtime-wry's `send_user_message` runs it inline when the caller is
// already on the main thread and otherwise posts it to the event loop, so it
// never returns a value; results come back over an mpsc channel. Callers that
// need the value are `async` commands (thread pool), which keeps the main
// thread free to service the posted message.
// ---------------------------------------------------------------------------

#[cfg(target_os = "macos")]
const WITH_WEBVIEW_TIMEOUT: Duration = Duration::from_secs(1);

#[cfg(target_os = "macos")]
fn with_wk_webview<T, F>(webview: &Webview, f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&objc2_web_kit::WKWebView) -> T + Send + 'static,
{
    let (tx, rx) = mpsc::channel();
    webview
        .with_webview(move |platform| {
            // SAFETY: `inner()` is the retained WKWebView (wry's `WryWebView`
            // subclass) that wry keeps alive for the webview's lifetime, and this
            // closure runs on the main thread where WebKit expects to be called.
            let wk = unsafe { &*(platform.inner() as *mut objc2_web_kit::WKWebView) };
            let _ = tx.send(f(wk));
        })
        .map_err(|e| e.to_string())?;
    rx.recv_timeout(WITH_WEBVIEW_TIMEOUT)
        .map_err(|_| "timed out waiting for the preview webview".to_string())
}

#[cfg(target_os = "macos")]
fn history_state(webview: &Webview) -> Result<HistoryState, String> {
    with_wk_webview(webview, |wk| {
        // SAFETY: plain property reads on a live WKWebView (see `with_wk_webview`).
        unsafe {
            HistoryState {
                can_go_back: wk.canGoBack(),
                can_go_forward: wk.canGoForward(),
            }
        }
    })
}

/// Other platforms have no native query wired up yet: keep the buttons enabled.
#[cfg(not(target_os = "macos"))]
fn history_state(_webview: &Webview) -> Result<HistoryState, String> {
    Ok(HistoryState {
        can_go_back: true,
        can_go_forward: true,
    })
}

#[cfg(target_os = "macos")]
fn go_history(webview: &Webview, delta: i32) -> Result<(), String> {
    if delta == 0 {
        return Ok(());
    }
    webview
        .with_webview(move |platform| {
            // SAFETY: see `with_wk_webview`.
            let wk = unsafe { &*(platform.inner() as *mut objc2_web_kit::WKWebView) };
            // The returned WKNavigation handle is not needed.
            let _ = unsafe {
                if delta < 0 {
                    wk.goBack()
                } else {
                    wk.goForward()
                }
            };
        })
        .map_err(|e| e.to_string())
}

#[cfg(not(target_os = "macos"))]
fn go_history(webview: &Webview, delta: i32) -> Result<(), String> {
    webview
        .eval(format!("history.go({delta})"))
        .map_err(|e| e.to_string())
}

#[cfg(target_os = "macos")]
const SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(2);

/// Rasterises the current frame of a preview webview into a PNG data URL.
///
/// The frontend swaps this in as a static `<img>` under the spot the native
/// child webview occupies right before hiding it behind a dialog, so the
/// user sees the same pixels instead of a flash of empty panel.
#[cfg(target_os = "macos")]
fn snapshot_data_url(webview: &Webview) -> Result<String, String> {
    use block2::RcBlock;
    use objc2_app_kit::NSImage;
    use objc2_foundation::NSError;

    let (tx, rx) = mpsc::channel::<Result<String, String>>();
    webview
        .with_webview(move |platform| {
            // SAFETY: see `with_wk_webview`.
            let wk = unsafe { &*(platform.inner() as *mut objc2_web_kit::WKWebView) };
            // WebKit `Block_copy`s the handler, so it outlives this `RcBlock`
            // and the closure is invoked (once) on the main thread later.
            let handler = RcBlock::new(move |image: *mut NSImage, error: *mut NSError| {
                // SAFETY: WebKit hands us either a live image or a live error
                // (the other is null) for the duration of the callback.
                let _ = tx.send(unsafe { encode_snapshot_png(image, error) });
            });
            // SAFETY: plain method call on a live WKWebView; a `None`
            // configuration snapshots the whole visible viewport.
            unsafe { wk.takeSnapshotWithConfiguration_completionHandler(None, &handler) };
        })
        .map_err(|e| e.to_string())?;
    rx.recv_timeout(SNAPSHOT_TIMEOUT)
        .map_err(|_| "timed out waiting for the preview webview snapshot".to_string())?
}

/// NSImage → TIFF → NSBitmapImageRep → PNG → base64 data URL.
///
/// # Safety
/// `image` / `error` must be null or point to live objects (the contract of
/// WebKit's snapshot completion handler).
#[cfg(target_os = "macos")]
unsafe fn encode_snapshot_png(
    image: *mut objc2_app_kit::NSImage,
    error: *mut objc2_foundation::NSError,
) -> Result<String, String> {
    use base64::Engine;
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep};
    use objc2_foundation::NSDictionary;

    if let Some(error) = unsafe { error.as_ref() } {
        return Err(error.localizedDescription().to_string());
    }
    let image =
        unsafe { image.as_ref() }.ok_or_else(|| "snapshot produced no image".to_string())?;
    let tiff = image
        .TIFFRepresentation()
        .ok_or_else(|| "snapshot image has no TIFF representation".to_string())?;
    let rep = NSBitmapImageRep::imageRepWithData(&tiff)
        .ok_or_else(|| "snapshot image could not be decoded".to_string())?;
    let properties = NSDictionary::new();
    // SAFETY: an empty properties dictionary is valid for every file type.
    let png =
        unsafe { rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &properties) }
            .ok_or_else(|| "snapshot image could not be encoded as PNG".to_string())?;
    let encoded = base64::engine::general_purpose::STANDARD.encode(png.to_vec());
    Ok(format!("data:image/png;base64,{encoded}"))
}

#[cfg(not(target_os = "macos"))]
fn snapshot_data_url(_webview: &Webview) -> Result<String, String> {
    Err("preview webview snapshots are only supported on macOS".to_string())
}

/// Accepts `preview-<id>` where `<id>` is 1..=64 chars of `[A-Za-z0-9_-]`.
fn validate_label(label: &str) -> Result<(), String> {
    let id = label
        .strip_prefix(LABEL_PREFIX)
        .ok_or_else(|| format!("invalid preview webview label: {label}"))?;
    let valid_len = !id.is_empty() && id.len() <= LABEL_ID_MAX_LEN;
    let valid_chars = id
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    if valid_len && valid_chars {
        Ok(())
    } else {
        Err(format!("invalid preview webview label: {label}"))
    }
}

fn parse_http_url(raw: &str) -> Result<Url, String> {
    let url = Url::parse(raw).map_err(|e| format!("invalid url `{raw}`: {e}"))?;
    if is_http(&url) {
        Ok(url)
    } else {
        Err(format!(
            "preview webview only accepts http/https urls, got scheme `{}`",
            url.scheme()
        ))
    }
}

fn is_http(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https")
}

fn find_webview(app: &AppHandle, label: &str) -> Result<Webview, String> {
    validate_label(label)?;
    app.get_webview(label)
        .ok_or_else(|| format!("preview webview not found: {label}"))
}

fn apply_bounds(webview: &Webview, x: f64, y: f64, width: f64, height: f64) -> Result<(), String> {
    webview
        .set_position(LogicalPosition::new(x, y))
        .map_err(|e| e.to_string())?;
    webview
        .set_size(LogicalSize::new(width, height))
        .map_err(|e| e.to_string())
}

// The 8-arg shape is the IPC contract with the frontend (label/url + rect).
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn preview_webview_open(
    window: tauri::Window,
    app: AppHandle,
    label: String,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    validate_label(&label)?;
    let target = parse_http_url(&url)?;

    if let Some(existing) = app.get_webview(&label) {
        existing.navigate(target).map_err(|e| e.to_string())?;
        apply_bounds(&existing, x, y, width, height)?;
        return existing.show().map_err(|e| e.to_string());
    }

    let new_window_app = app.clone();
    let new_window_label = label.clone();
    let page_load_label = label.clone();
    let title_label = label.clone();

    let builder = WebviewBuilder::new(&label, WebviewUrl::External(target))
        .on_navigation(is_http)
        // `window.open` / target=_blank: keep the user inside the preview tab
        // instead of spawning a new native window.
        .on_new_window(move |url, _features| {
            if is_http(&url) {
                if let Some(webview) = new_window_app.get_webview(&new_window_label) {
                    let _ = webview.navigate(url);
                }
            }
            NewWindowResponse::Deny
        })
        .on_page_load(move |webview, payload| {
            let phase = match payload.event() {
                PageLoadEvent::Started => "started",
                PageLoadEvent::Finished => "finished",
            };
            let _ = webview.app_handle().emit_to(
                MAIN_LABEL,
                PAGE_LOAD_EVENT,
                PageLoadPayload {
                    label: page_load_label.clone(),
                    url: payload.url().to_string(),
                    phase,
                },
            );
        })
        .on_document_title_changed(move |webview, title| {
            let _ = webview.app_handle().emit_to(
                MAIN_LABEL,
                TITLE_EVENT,
                TitlePayload {
                    label: title_label.clone(),
                    title,
                },
            );
        });

    window
        .add_child(
            builder,
            LogicalPosition::new(x, y),
            LogicalSize::new(width, height),
        )
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn preview_webview_set_bounds(
    app: AppHandle,
    label: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let webview = find_webview(&app, &label)?;
    apply_bounds(&webview, x, y, width, height)
}

#[tauri::command]
pub fn preview_webview_navigate(app: AppHandle, label: String, url: String) -> Result<(), String> {
    let target = parse_http_url(&url)?;
    let webview = find_webview(&app, &label)?;
    webview.navigate(target).map_err(|e| e.to_string())
}

/// `delta` follows `history.go`: negative goes back, positive goes forward
/// (one step either way on macOS, where the native back/forward list is used).
#[tauri::command]
pub fn preview_webview_history(app: AppHandle, label: String, delta: i32) -> Result<(), String> {
    let webview = find_webview(&app, &label)?;
    go_history(&webview, delta)
}

/// `async` on purpose: it blocks on the main-thread round trip (see
/// `with_wk_webview`), which must not happen on the main thread itself.
#[tauri::command]
pub async fn preview_webview_history_state(
    app: AppHandle,
    label: String,
) -> Result<HistoryState, String> {
    let webview = find_webview(&app, &label)?;
    history_state(&webview)
}

/// PNG data URL of the webview's current frame. `async` for the same reason as
/// `preview_webview_history_state`: it blocks on a main-thread round trip.
#[tauri::command]
pub async fn preview_webview_snapshot(app: AppHandle, label: String) -> Result<String, String> {
    let webview = find_webview(&app, &label)?;
    snapshot_data_url(&webview)
}

#[tauri::command]
pub fn preview_webview_reload(app: AppHandle, label: String) -> Result<(), String> {
    let webview = find_webview(&app, &label)?;
    webview.reload().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn preview_webview_set_visible(
    app: AppHandle,
    label: String,
    visible: bool,
) -> Result<(), String> {
    let webview = find_webview(&app, &label)?;
    let result = if visible {
        webview.show()
    } else {
        webview.hide()
    };
    result.map_err(|e| e.to_string())
}

/// Idempotent: closing a label that does not exist is Ok.
#[tauri::command]
pub fn preview_webview_close(app: AppHandle, label: String) -> Result<(), String> {
    validate_label(&label)?;
    match app.get_webview(&label) {
        Some(webview) => webview.close().map_err(|e| e.to_string()),
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn label_accepts_expected_shape() {
        assert!(validate_label("preview-abc").is_ok());
        assert!(validate_label("preview-a1_B-2").is_ok());
        assert!(validate_label(&format!("preview-{}", "x".repeat(64))).is_ok());
    }

    #[test]
    fn label_rejects_bad_shapes() {
        assert!(validate_label("preview-").is_err());
        assert!(validate_label("main").is_err());
        assert!(validate_label("preview-a.b").is_err());
        assert!(validate_label("preview-a b").is_err());
        assert!(validate_label("Preview-abc").is_err());
        assert!(validate_label(&format!("preview-{}", "x".repeat(65))).is_err());
    }

    #[test]
    fn history_state_serializes_camel_case() {
        let json = serde_json::to_string(&HistoryState {
            can_go_back: true,
            can_go_forward: false,
        })
        .unwrap();
        assert_eq!(json, r#"{"canGoBack":true,"canGoForward":false}"#);
    }

    #[test]
    fn url_only_accepts_http_schemes() {
        assert!(parse_http_url("https://example.com/a?b=1").is_ok());
        assert!(parse_http_url("http://localhost:1420").is_ok());
        assert!(parse_http_url("file:///etc/passwd").is_err());
        assert!(parse_http_url("javascript:alert(1)").is_err());
        assert!(parse_http_url("tauri://localhost").is_err());
        assert!(parse_http_url("not a url").is_err());
    }
}
