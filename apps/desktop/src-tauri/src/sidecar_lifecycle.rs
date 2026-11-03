//! Process ownership and optional diagnostic publication for the native sidecar.
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
pub(crate) struct SidecarEndpoint {
    pub(crate) host: String,
    pub(crate) port: u16,
    pub(crate) token: String,
}

pub(crate) trait ChildControl: Send + 'static {
    fn terminate(self) -> Result<(), String>;
}

struct ChildOwner<C: ChildControl> {
    child: Mutex<Option<C>>,
    cancelled: AtomicBool,
}
impl<C: ChildControl> ChildOwner<C> {
    fn new() -> Self {
        Self {
            child: Mutex::new(None),
            cancelled: AtomicBool::new(false),
        }
    }
    fn install(&self, child: C) -> Result<(), String> {
        let mut slot = self.child.lock().unwrap_or_else(|e| e.into_inner());
        if self.cancelled.load(Ordering::Acquire) {
            drop(slot);
            return match child.terminate() {
                Ok(()) => Err("startup cancelled".into()),
                Err(cleanup) => Err(format!(
                    "startup cancelled; failed to terminate late startup child: {cleanup}"
                )),
            };
        }
        *slot = Some(child);
        Ok(())
    }
    fn stop(&self) -> Result<(), String> {
        self.cancelled.store(true, Ordering::Release);
        let child = self.child.lock().unwrap_or_else(|e| e.into_inner()).take();
        child.map_or(Ok(()), ChildControl::terminate)
    }
}
impl<C: ChildControl> Drop for ChildOwner<C> {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}
struct ProcessSlot<C: ChildControl> {
    token: String,
    child: Arc<ChildOwner<C>>,
    endpoint: Option<SidecarEndpoint>,
}

/// Startup calls serialize, but Stop never waits for the startup/wait lock.
/// A starting slot exists before spawn, so Stop also owns delayed spawns.
pub(crate) struct SidecarLifecycle<C: ChildControl> {
    startup: Mutex<()>,
    inner: Mutex<Option<ProcessSlot<C>>>,
    epoch: AtomicU64,
}
impl<C: ChildControl> Default for SidecarLifecycle<C> {
    fn default() -> Self {
        Self {
            startup: Mutex::new(()),
            inner: Mutex::new(None),
            epoch: AtomicU64::new(0),
        }
    }
}
impl<C: ChildControl> SidecarLifecycle<C> {
    /// Capture at IPC entry, before enqueueing blocking startup work.
    pub(crate) fn permit(&self) -> u64 {
        self.epoch.load(Ordering::Acquire)
    }

    pub(crate) fn endpoint(&self) -> Option<SidecarEndpoint> {
        self.inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .and_then(|s| s.endpoint.clone())
    }
    pub(crate) fn start<E>(
        &self,
        permit: u64,
        token: String,
        spawn: impl FnOnce() -> Result<(C, E), String>,
        wait: impl FnOnce(&mut E, &AtomicBool) -> Result<u16, String>,
        publish: impl FnOnce(&SidecarEndpoint),
    ) -> Result<(SidecarEndpoint, Option<E>), String> {
        let _startup = self.startup.lock().unwrap_or_else(|e| e.into_inner());
        if self.permit() != permit {
            return Err("startup cancelled".into());
        }
        let child = Arc::new(ChildOwner::new());
        {
            let mut slot = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            if self.permit() != permit {
                return Err("startup cancelled".into());
            }
            if let Some(endpoint) = slot.as_ref().and_then(|s| s.endpoint.clone()) {
                return Ok((endpoint, None));
            }
            *slot = Some(ProcessSlot {
                token: token.clone(),
                child: child.clone(),
                endpoint: None,
            });
        }
        let result = (|| {
            let (spawned, mut events) = spawn()?;
            child.install(spawned)?;
            let port = wait(&mut events, &child.cancelled)?;
            let mut slot = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            let current = slot.as_mut().filter(|s| s.token == token);
            if child.cancelled.load(Ordering::Acquire)
                || current.is_none()
                || self.permit() != permit
            {
                return Err("startup cancelled".into());
            }
            let endpoint = SidecarEndpoint {
                host: "127.0.0.1".into(),
                port,
                token: token.clone(),
            };
            // Publication is bounded optional file IO. It cannot race Stop's cleanup.
            publish(&endpoint);
            current.unwrap().endpoint = Some(endpoint.clone());
            Ok((endpoint, Some(events)))
        })();
        if result.is_err() {
            let mut slot = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            if slot.as_ref().map(|s| s.token.as_str()) == Some(token.as_str()) {
                slot.take();
            }
            drop(slot);
            if let Err(cleanup) = child.stop() {
                return Err(format!(
                    "{}; failed to terminate startup child: {cleanup}",
                    result.err().unwrap()
                ));
            }
        }
        result
    }
    /// Only an exit from this exact spawn may clear its slot/diagnostic.
    pub(crate) fn exited(&self, token: &str, cleanup: impl FnOnce(&str)) -> bool {
        let mut slot = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if slot.as_ref().map(|s| s.token.as_str()) != Some(token) {
            return false;
        }
        let current = slot.take().unwrap();
        let _ = current.child.stop();
        cleanup(&current.token);
        true
    }
    pub(crate) fn stop(&self, cleanup: impl FnOnce(Option<&str>)) -> Result<(), String> {
        self.epoch.fetch_add(1, Ordering::AcqRel);
        let mut slot = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(current) = slot.take() {
            let result = current.child.stop();
            cleanup(Some(&current.token));
            result
        } else {
            cleanup(None);
            Ok(())
        }
    }
}

pub(crate) enum ReadyPoll {
    Pending,
    Output(String),
    Failed(String),
    Closed,
}
pub(crate) fn wait_for_ready(
    timeout: Duration,
    cancelled: &AtomicBool,
    mut poll: impl FnMut() -> ReadyPoll,
    parse: impl Fn(&str) -> Option<u16>,
) -> Result<u16, String> {
    let deadline = Instant::now() + timeout;
    loop {
        if cancelled.load(Ordering::Acquire) {
            return Err("startup cancelled".into());
        }
        if Instant::now() >= deadline {
            return Err("sidecar did not announce its port before the startup deadline".into());
        }
        match poll() {
            ReadyPoll::Output(line) => {
                if let Some(port) = parse(&line) {
                    if cancelled.load(Ordering::Acquire) {
                        return Err("startup cancelled".into());
                    }
                    if Instant::now() >= deadline {
                        return Err(
                            "sidecar did not announce its port before the startup deadline".into(),
                        );
                    }
                    return Ok(port);
                }
            }
            ReadyPoll::Failed(error) => return Err(error),
            ReadyPoll::Closed => return Err("sidecar closed stdout before announcing port".into()),
            ReadyPoll::Pending => thread::sleep(
                Duration::from_millis(2).min(deadline.saturating_duration_since(Instant::now())),
            ),
        }
    }
}

/// Cooperative publishers/cleaners use the same short OS lock. The empty lock
/// file can survive a crash: the OS releases its lock without stale lease logic.
struct EndpointLock(File);
impl EndpointLock {
    fn acquire(path: &Path) -> io::Result<Self> {
        let lock_path = path.with_extension("json.lock");
        let deadline = Instant::now() + Duration::from_millis(80);
        loop {
            let mut options = OpenOptions::new();
            options.read(true).write(true).create(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
            }
            #[cfg(windows)]
            {
                use std::os::windows::fs::OpenOptionsExt;
                // Exclusive sharing is released by the OS even on process exit.
                options.share_mode(0).custom_flags(0x0020_0000);
            }
            let opened = options.open(&lock_path);
            match opened {
                Ok(file) => {
                    if !file.metadata()?.is_file() {
                        return Err(io::Error::new(
                            io::ErrorKind::InvalidInput,
                            "endpoint lock is not a regular file",
                        ));
                    }
                    #[cfg(unix)]
                    {
                        // SAFETY: flock only borrows this owned, valid descriptor.
                        use std::os::fd::AsRawFd;
                        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) }
                            != 0
                        {
                            let error = io::Error::last_os_error();
                            if error.kind() != io::ErrorKind::WouldBlock
                                || Instant::now() >= deadline
                            {
                                return Err(error);
                            }
                            thread::sleep(Duration::from_millis(2));
                            continue;
                        }
                    }
                    return Ok(Self(file));
                }
                Err(error) => {
                    #[cfg(windows)]
                    if error.raw_os_error() == Some(32) && Instant::now() < deadline {
                        thread::sleep(Duration::from_millis(2));
                        continue;
                    }
                    return Err(error);
                }
            }
        }
    }
}
impl Drop for EndpointLock {
    fn drop(&mut self) {
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            // SAFETY: this descriptor remains owned until after Drop returns.
            let _ = unsafe { libc::flock(self.0.as_raw_fd(), libc::LOCK_UN) };
        }
    }
}
struct TemporaryFile(PathBuf);
impl Drop for TemporaryFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

// Path parameters keep tests/fixtures entirely separate from the normal endpoint.
pub(crate) fn write_endpoint(path: &Path, endpoint: &SidecarEndpoint, pid: u32) -> io::Result<()> {
    let _lock = EndpointLock::acquire(path)?;
    let temporary = TemporaryFile(path.with_file_name(format!(
        ".openhorn-endpoint-{}.tmp",
        crate::generate_handshake_token()
    )));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temporary.0)?;
    let body = serde_json::to_vec(
        &serde_json::json!({"host":endpoint.host,"port":endpoint.port,"token":endpoint.token,"pid":pid}),
    )?;
    file.write_all(&body)?;
    file.sync_all()?;
    drop(file);
    // Replaces a leaf symlink itself, never the file it points to. On platforms
    // refusing replacement, this optional diagnostic fails without deleting it.
    fs::rename(&temporary.0, path)
}
pub(crate) fn remove_endpoint(path: &Path, pid: u32, token: Option<&str>) -> io::Result<bool> {
    let _lock = EndpointLock::acquire(path)?;
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x0020_0000);
    }
    let file = match options.open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error),
    };
    if !file.metadata()?.is_file() {
        return Ok(false);
    }
    let mut body = Vec::new();
    file.take(4097).read_to_end(&mut body)?;
    if body.len() > 4096 {
        return Ok(false);
    }
    let value: serde_json::Value = match serde_json::from_slice(&body) {
        Ok(value) => value,
        Err(_) => return Ok(false),
    };
    if value.get("pid").and_then(|v| v.as_u64()) != Some(u64::from(pid))
        || token
            .is_some_and(|expected| value.get("token").and_then(|v| v.as_str()) != Some(expected))
    {
        return Ok(false);
    }
    fs::remove_file(path)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    use std::sync::{mpsc, Barrier};
    struct Temp(PathBuf);
    impl Temp {
        fn new() -> Self {
            let p = std::env::temp_dir().join(format!(
                "openhorn-native-life-{}-{}",
                std::process::id(),
                crate::generate_handshake_token()
            ));
            fs::create_dir(&p).unwrap();
            Self(p)
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn endpoint(token: &str) -> SidecarEndpoint {
        SidecarEndpoint {
            host: "127.0.0.1".into(),
            port: 12345,
            token: token.into(),
        }
    }
    struct FakeChild(Arc<AtomicUsize>);
    impl ChildControl for FakeChild {
        fn terminate(self) -> Result<(), String> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
    }
    fn healthy(
        life: &SidecarLifecycle<FakeChild>,
        token: &str,
        killed: Arc<AtomicUsize>,
    ) -> (SidecarEndpoint, Option<()>) {
        life.start(
            life.permit(),
            token.into(),
            || Ok((FakeChild(killed), ())),
            |_, _| Ok(12345),
            |_| {},
        )
        .unwrap()
    }

    #[test]
    fn ready_silent_start_has_a_shared_deadline() {
        let started = Instant::now();
        let result = wait_for_ready(
            Duration::from_millis(30),
            &AtomicBool::new(false),
            || {
                if started.elapsed() > Duration::from_millis(500) {
                    ReadyPoll::Closed
                } else {
                    ReadyPoll::Pending
                }
            },
            |_| None,
        );
        assert!(result.is_err());
        assert!(
            started.elapsed() < Duration::from_millis(300),
            "silent startup ignored deadline"
        );
    }
    #[test]
    fn ready_chatter_does_not_extend_the_deadline() {
        let started = Instant::now();
        let result = wait_for_ready(
            Duration::from_millis(30),
            &AtomicBool::new(false),
            || {
                if started.elapsed() > Duration::from_millis(500) {
                    ReadyPoll::Closed
                } else {
                    ReadyPoll::Output("junk".into())
                }
            },
            |_| None,
        );
        assert!(result.is_err());
        assert!(
            started.elapsed() < Duration::from_millis(300),
            "chatter extended deadline"
        );
    }
    #[test]
    fn ready_cancel_prevents_accepting_a_late_port() {
        let result = wait_for_ready(
            Duration::from_secs(1),
            &AtomicBool::new(true),
            || ReadyPoll::Output("ready".into()),
            |_| Some(12345),
        );
        assert!(result.is_err());
    }
    #[test]
    fn ready_success_and_failures_remain_distinct() {
        assert_eq!(
            wait_for_ready(
                Duration::from_secs(1),
                &AtomicBool::new(false),
                || ReadyPoll::Output("ready".into()),
                |_| Some(12345)
            )
            .unwrap(),
            12345
        );
        assert!(wait_for_ready(
            Duration::from_secs(1),
            &AtomicBool::new(false),
            || ReadyPoll::Failed("fixture".into()),
            |_| None
        )
        .unwrap_err()
        .contains("fixture"));
    }
    #[test]
    fn failed_start_kills_its_child_and_allows_retry() {
        let life = SidecarLifecycle::default();
        let killed = Arc::new(AtomicUsize::new(0));
        let result = life.start(
            life.permit(),
            "a".into(),
            || Ok((FakeChild(killed.clone()), ())),
            |_, _| Err("fixture".into()),
            |_| panic!("published failure"),
        );
        assert!(result.is_err());
        assert!(life.endpoint().is_none());
        assert_eq!(killed.load(Ordering::SeqCst), 1);
        let (ready, events) = healthy(&life, "b", killed.clone());
        assert_eq!(ready.token, "b");
        assert!(events.is_some());
        life.stop(|_| {}).unwrap();
        assert_eq!(killed.load(Ordering::SeqCst), 2);
    }
    #[test]
    fn overlapping_starts_share_the_child_and_event_receiver() {
        let life = Arc::new(SidecarLifecycle::default());
        let starts = Arc::new(AtomicUsize::new(0));
        let killed = Arc::new(AtomicUsize::new(0));
        let barrier = Arc::new(Barrier::new(2));
        let (release, held) = mpsc::channel();
        let l = life.clone();
        let s = starts.clone();
        let k = killed.clone();
        let b = barrier.clone();
        let first = thread::spawn(move || {
            l.start(
                l.permit(),
                "a".into(),
                || {
                    s.fetch_add(1, Ordering::SeqCst);
                    Ok((FakeChild(k), ()))
                },
                |_, _| {
                    b.wait();
                    held.recv().unwrap();
                    Ok(12345)
                },
                |_| {},
            )
            .unwrap()
        });
        barrier.wait();
        let l = life.clone();
        let s = starts.clone();
        let k = killed.clone();
        let second = thread::spawn(move || {
            l.start(
                l.permit(),
                "b".into(),
                || {
                    s.fetch_add(1, Ordering::SeqCst);
                    Ok((FakeChild(k), ()))
                },
                |_, _| Ok(12345),
                |_| {},
            )
            .unwrap()
        });
        release.send(()).unwrap();
        let a = first.join().unwrap();
        let b = second.join().unwrap();
        assert_eq!(a.0.token, b.0.token);
        assert!(a.1.is_some());
        assert!(b.1.is_none());
        assert_eq!(starts.load(Ordering::SeqCst), 1);
        life.stop(|_| {}).unwrap();
    }
    #[test]
    fn stop_during_spawn_kills_the_late_child_without_publication() {
        let life = Arc::new(SidecarLifecycle::default());
        let killed = Arc::new(AtomicUsize::new(0));
        let (started, wait_started) = mpsc::channel();
        let (release, held) = mpsc::channel();
        let l = life.clone();
        let k = killed.clone();
        let child = thread::spawn(move || {
            l.start(
                l.permit(),
                "a".into(),
                || {
                    started.send(()).unwrap();
                    held.recv().unwrap();
                    Ok((FakeChild(k), ()))
                },
                |_, _| Ok(12345),
                |_| panic!("published stopped spawn"),
            )
        });
        wait_started.recv().unwrap();
        life.stop(|_| {}).unwrap();
        release.send(()).unwrap();
        assert!(child.join().unwrap().is_err());
        assert_eq!(killed.load(Ordering::SeqCst), 1);
        assert!(life.endpoint().is_none());
    }
    #[test]
    fn stop_during_readiness_does_not_wait_for_startup_lock() {
        let life = Arc::new(SidecarLifecycle::default());
        let killed = Arc::new(AtomicUsize::new(0));
        let (started, wait_started) = mpsc::channel();
        let l = life.clone();
        let k = killed.clone();
        let child = thread::spawn(move || {
            l.start(
                l.permit(),
                "a".into(),
                || Ok((FakeChild(k), ())),
                |_, cancel| {
                    started.send(()).unwrap();
                    wait_for_ready(
                        Duration::from_secs(1),
                        cancel,
                        || ReadyPoll::Pending,
                        |_| None,
                    )
                },
                |_| panic!("published stopped startup"),
            )
        });
        wait_started.recv().unwrap();
        let now = Instant::now();
        life.stop(|_| {}).unwrap();
        assert!(child.join().unwrap().is_err());
        assert!(now.elapsed() < Duration::from_millis(200));
        assert_eq!(killed.load(Ordering::SeqCst), 1);
        assert!(life.endpoint().is_none());
        healthy(&life, "b", killed);
        life.stop(|_| {}).unwrap();
    }
    #[test]
    fn a_late_exit_with_reused_port_cannot_clear_a_new_spawn() {
        let life = SidecarLifecycle::default();
        let killed = Arc::new(AtomicUsize::new(0));
        let a = healthy(&life, "a", killed.clone()).0;
        life.stop(|_| {}).unwrap();
        let b = healthy(&life, "b", killed.clone()).0;
        assert_eq!(a.port, b.port);
        assert!(!life.exited(&a.token, |_| panic!("cleaned replacement")));
        assert_eq!(life.endpoint().unwrap().token, "b");
        assert!(life.exited(&b.token, |_| {}));
        assert!(life.endpoint().is_none());
        assert_eq!(killed.load(Ordering::SeqCst), 2);
    }
    #[cfg(unix)]
    #[test]
    fn endpoint_publication_does_not_follow_a_planted_symlink() {
        let tmp = Temp::new();
        let target = tmp.0.join("sentinel");
        let path = tmp.0.join("endpoint.json");
        fs::write(&target, "keep me").unwrap();
        std::os::unix::fs::symlink(&target, &path).unwrap();
        write_endpoint(&path, &endpoint("a"), 7).unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), "keep me");
        assert!(!fs::symlink_metadata(path).unwrap().file_type().is_symlink());
    }
    #[test]
    fn endpoint_cleanup_checks_pid_and_spawn_identity() {
        let tmp = Temp::new();
        let path = tmp.0.join("endpoint.json");
        write_endpoint(&path, &endpoint("a"), 7).unwrap();
        write_endpoint(&path, &endpoint("b"), 7).unwrap();
        assert!(!remove_endpoint(&path, 7, Some("a")).unwrap());
        assert!(path.exists());
        assert!(!remove_endpoint(&path, 8, Some("b")).unwrap());
        assert!(remove_endpoint(&path, 7, Some("b")).unwrap());
        assert!(!path.exists());
    }
    #[cfg(unix)]
    #[test]
    fn endpoint_is_private_at_publication() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = Temp::new();
        let path = tmp.0.join("endpoint.json");
        write_endpoint(&path, &endpoint("a"), 7).unwrap();
        assert_eq!(
            fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    #[test]
    fn ready_after_the_deadline_is_not_accepted() {
        let result = wait_for_ready(
            Duration::from_millis(5),
            &AtomicBool::new(false),
            || {
                thread::sleep(Duration::from_millis(12));
                ReadyPoll::Output("ready".into())
            },
            |_| Some(12345),
        );
        assert!(result.is_err());
    }
    #[test]
    fn timeout_closed_and_failed_readiness_all_kill_the_child() {
        for scenario in 0..3 {
            let life = SidecarLifecycle::default();
            let killed = Arc::new(AtomicUsize::new(0));
            let result = life.start(
                life.permit(),
                "a".into(),
                || Ok((FakeChild(killed.clone()), ())),
                |_, cancel| {
                    wait_for_ready(
                        Duration::from_millis(5),
                        cancel,
                        || match scenario {
                            0 => ReadyPoll::Pending,
                            1 => ReadyPoll::Closed,
                            _ => ReadyPoll::Failed("fixture error".into()),
                        },
                        |_| None,
                    )
                },
                |_| panic!("published failed readiness"),
            );
            assert!(result.is_err());
            assert!(life.endpoint().is_none());
            assert_eq!(killed.load(Ordering::SeqCst), 1);
        }
    }
    #[cfg(unix)]
    #[test]
    fn endpoint_lock_symlink_cannot_touch_its_target() {
        let tmp = Temp::new();
        let path = tmp.0.join("endpoint.json");
        let target = tmp.0.join("sentinel");
        fs::write(&target, "unchanged").unwrap();
        std::os::unix::fs::symlink(&target, path.with_extension("json.lock")).unwrap();
        assert!(write_endpoint(&path, &endpoint("a"), 7).is_err());
        assert_eq!(fs::read_to_string(target).unwrap(), "unchanged");
        assert!(!path.exists());
    }
    #[cfg(unix)]
    #[test]
    fn endpoint_lock_contention_is_bounded_and_does_not_block_ipc_ownership() {
        let tmp = Temp::new();
        let path = tmp.0.join("endpoint.json");
        let lock = EndpointLock::acquire(&path).unwrap();
        let cloned = path.clone();
        let started = Instant::now();
        let contender = thread::spawn(move || write_endpoint(&cloned, &endpoint("a"), 7));
        assert!(contender.join().unwrap().is_err());
        assert!(started.elapsed() < Duration::from_millis(500));
        assert!(!path.exists());
        drop(lock);
        write_endpoint(&path, &endpoint("a"), 7).unwrap();
        assert!(remove_endpoint(&path, 7, Some("a")).unwrap());
    }
    #[test]
    fn stop_invalidates_a_queued_start_permit_but_allows_a_new_call() {
        let life = Arc::new(SidecarLifecycle::default());
        let killed = Arc::new(AtomicUsize::new(0));
        let starts = Arc::new(AtomicUsize::new(0));
        let (started, wait_started) = mpsc::channel();
        let (release, held) = mpsc::channel();
        let l = life.clone();
        let k = killed.clone();
        let st = starts.clone();
        let first = thread::spawn(move || {
            l.start(
                l.permit(),
                "a".into(),
                || {
                    st.fetch_add(1, Ordering::SeqCst);
                    Ok((FakeChild(k), ()))
                },
                |_, _| {
                    started.send(()).unwrap();
                    held.recv().unwrap();
                    Ok(12345)
                },
                |_| panic!("published after Stop"),
            )
        });
        wait_started.recv().unwrap();
        let old_permit = life.permit();
        let l = life.clone();
        let k = killed.clone();
        let st = starts.clone();
        let queued = thread::spawn(move || {
            l.start(
                old_permit,
                "b".into(),
                || {
                    st.fetch_add(1, Ordering::SeqCst);
                    Ok((FakeChild(k), ()))
                },
                |_, _| Ok(12345),
                |_| panic!("published queued start"),
            )
        });
        life.stop(|_| {}).unwrap();
        release.send(()).unwrap();
        assert!(first.join().unwrap().is_err());
        assert!(queued.join().unwrap().is_err());
        assert_eq!(starts.load(Ordering::SeqCst), 1);
        assert_eq!(killed.load(Ordering::SeqCst), 1);
        assert!(life.endpoint().is_none());
        healthy(&life, "fresh", killed.clone());
        assert_eq!(life.endpoint().unwrap().token, "fresh");
        life.stop(|_| {}).unwrap();
        assert_eq!(killed.load(Ordering::SeqCst), 2);
    }
    #[test]
    fn successful_readiness_transfers_the_remaining_receiver_to_monitoring() {
        let life = SidecarLifecycle::default();
        let killed = Arc::new(AtomicUsize::new(0));
        let (sender, receiver) = mpsc::channel();
        sender.send(ReadyPoll::Output("ready".into())).unwrap();
        sender.send(ReadyPoll::Failed("terminated".into())).unwrap();
        let (endpoint, remaining) = life
            .start(
                life.permit(),
                "a".into(),
                || Ok((FakeChild(killed.clone()), receiver)),
                |events, cancel| {
                    wait_for_ready(
                        Duration::from_secs(1),
                        cancel,
                        || events.try_recv().unwrap_or(ReadyPoll::Closed),
                        |text| if text == "ready" { Some(12345) } else { None },
                    )
                },
                |_| {},
            )
            .unwrap();
        assert!(matches!(
            remaining.unwrap().recv().unwrap(),
            ReadyPoll::Failed(_)
        ));
        assert!(life.exited(&endpoint.token, |_| {}));
        assert!(life.endpoint().is_none());
        assert_eq!(killed.load(Ordering::SeqCst), 1);
    }
    #[cfg(unix)]
    #[test]
    fn endpoint_cleanup_does_not_block_on_a_planted_fifo() {
        use std::os::unix::ffi::OsStrExt;
        let tmp = Temp::new();
        let path = tmp.0.join("endpoint.json");
        let name = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
        // SAFETY: name is an owned valid C path into this test's temporary dir.
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        let cloned = path.clone();
        let (sent, received) = mpsc::channel();
        let worker = thread::spawn(move || {
            let result = remove_endpoint(&cloned, 7, Some("a"));
            sent.send(result).unwrap();
        });
        let result = received.recv_timeout(Duration::from_millis(300));
        // Even a regression cannot hang the test process: a read/write FIFO
        // handle releases an old blocking read, without touching a normal path.
        let rescue = if result.is_err() {
            Some(
                OpenOptions::new()
                    .read(true)
                    .write(true)
                    .open(&path)
                    .unwrap(),
            )
        } else {
            None
        };
        worker.join().unwrap();
        drop(rescue);
        assert!(
            matches!(result, Ok(Ok(false))),
            "diagnostic cleanup waited for FIFO writer"
        );
        assert!(path.exists());
    }
    #[test]
    fn cancelled_late_spawn_reports_a_failed_termination() {
        struct RefusesKill(Arc<AtomicUsize>);
        impl ChildControl for RefusesKill {
            fn terminate(self) -> Result<(), String> {
                self.0.fetch_add(1, Ordering::SeqCst);
                Err("fixture kill refused".into())
            }
        }
        let life = Arc::new(SidecarLifecycle::default());
        let attempts = Arc::new(AtomicUsize::new(0));
        let (started, wait_started) = mpsc::channel();
        let (release, held) = mpsc::channel();
        let l = life.clone();
        let a = attempts.clone();
        let pending = thread::spawn(move || {
            l.start(
                l.permit(),
                "a".into(),
                || {
                    started.send(()).unwrap();
                    held.recv().unwrap();
                    Ok((RefusesKill(a), ()))
                },
                |_, _| Ok(12345),
                |_| panic!("published cancelled startup"),
            )
        });
        wait_started.recv().unwrap();
        life.stop(|_| {}).unwrap();
        release.send(()).unwrap();
        let error = pending.join().unwrap().unwrap_err();
        assert!(error.contains("startup cancelled"));
        assert!(error.contains("fixture kill refused"));
        assert_eq!(attempts.load(Ordering::SeqCst), 1);
        assert!(life.endpoint().is_none());
    }
}
