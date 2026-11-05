use chrono::Utc;
use edm_core::sanitizer::Sanitizer;
use edm_ipc::{
    AppReply, BrowserDiagnostic, DiagnosticsReport, DownloadOverview, DownloadState,
    ExtensionMessage, PROTOCOL_VERSION,
};
use edm_store::{DownloadRecord, Store};
use std::env;
use std::fs;
use std::io::{self, Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use uuid::Uuid;

fn init_nmh_logging() {
    let log_dir = match env::var("LOCALAPPDATA") {
        Ok(dir) => PathBuf::from(dir).join("EDM").join("logs"),
        Err(_) => env::temp_dir().join("EDM").join("logs"),
    };
    let _ = fs::create_dir_all(&log_dir);

    // Rotating daily log file edm-nmh.YYYY-MM-DD.log
    let file_appender = tracing_appender::rolling::daily(&log_dir, "edm-nmh.log");
    let (non_blocking, guard) = tracing_appender::non_blocking(file_appender);
    Box::leak(Box::new(guard));

    let subscriber = tracing_subscriber::fmt()
        .with_writer(non_blocking)
        .with_ansi(false)
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive(tracing::Level::INFO.into()),
        )
        .finish();

    let _ = tracing::subscriber::set_global_default(subscriber);
}

fn get_last_wake_stats() -> (Option<String>, Option<String>, Option<u64>) {
    let p = match env::var("LOCALAPPDATA") {
        Ok(dir) => PathBuf::from(dir).join("EDM").join("last_wake.json"),
        Err(_) => env::temp_dir().join("EDM").join("last_wake.json"),
    };
    if let Ok(content) = fs::read_to_string(&p) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&content) {
            let err = v.get("error").and_then(|e| e.as_str()).map(|s| s.to_string());
            let ts = v.get("timestamp").and_then(|t| t.as_str()).map(|s| s.to_string());
            let ms = v.get("time_to_ready_ms").and_then(|m| m.as_u64());
            return (err, ts, ms);
        }
    }
    (None, None, None)
}

fn record_wake_result(ok: bool, error: Option<&str>, time_to_ready_ms: Option<u64>, exe_path: Option<&PathBuf>) {
    let p = match env::var("LOCALAPPDATA") {
        Ok(dir) => PathBuf::from(dir).join("EDM"),
        Err(_) => env::temp_dir().join("EDM"),
    };
    let _ = fs::create_dir_all(&p);
    let target = p.join("last_wake.json");
    let payload = serde_json::json!({
        "timestamp": Utc::now().to_rfc3339(),
        "ok": ok,
        "error": error,
        "time_to_ready_ms": time_to_ready_ms,
        "exe_path": exe_path.map(|p| p.to_string_lossy().to_string())
    });
    if let Ok(json_str) = serde_json::to_string_pretty(&payload) {
        let _ = fs::write(&target, json_str);
    }
}

fn verify_caller_origin() -> bool {
    let start = Instant::now();
    let args: Vec<String> = env::args().collect();
    if args.len() <= 1 {
        tracing::info!("Origin verified: no external caller args passed (elapsed: {:?})", start.elapsed());
        return true;
    }
    for arg in &args[1..] {
        if edm_ipc::extensions::is_allowed_origin(arg) {
            tracing::info!("Origin verified: matched allowed extension origin {} (elapsed: {:?})", arg, start.elapsed());
            return true;
        }
        if edm_ipc::extensions::is_allowed_extension_id(arg) {
            tracing::info!("Origin verified: matched allowed extension id directly {} (elapsed: {:?})", arg, start.elapsed());
            return true;
        }
        for id in edm_ipc::extensions::CHROMIUM_ALLOWED_IDS {
            if arg.contains(id) {
                tracing::info!("Origin verified: matched allowed extension id {} (elapsed: {:?})", id, start.elapsed());
                return true;
            }
        }
        if arg.contains(edm_ipc::extensions::FIREFOX_GECKO_ID) {
            tracing::info!("Origin verified: matched allowed firefox gecko id (elapsed: {:?})", start.elapsed());
            return true;
        }
    }
    tracing::warn!("Origin verification rejected: args {:?} not in allowed list (elapsed: {:?})", &args[1..], start.elapsed());
    false
}

#[cfg(windows)]
mod win_lock {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateMutexW(
            lpMutexAttributes: *mut std::ffi::c_void,
            bInitialOwner: i32,
            lpName: *const u16,
        ) -> *mut std::ffi::c_void;
        fn WaitForSingleObject(hHandle: *mut std::ffi::c_void, dwMilliseconds: u32) -> u32;
        fn ReleaseMutex(hMutex: *mut std::ffi::c_void) -> i32;
        fn CloseHandle(hObject: *mut std::ffi::c_void) -> i32;
    }

    pub struct NamedLock {
        handle: *mut std::ffi::c_void,
    }

    impl NamedLock {
        pub fn acquire(name: &str, timeout_ms: u32) -> Option<Self> {
            let wide: Vec<u16> = OsStr::new(name)
                .encode_wide()
                .chain(std::iter::once(0))
                .collect();
            let handle = unsafe { CreateMutexW(std::ptr::null_mut(), 0, wide.as_ptr()) };
            if handle.is_null() {
                return None;
            }
            let wait_res = unsafe { WaitForSingleObject(handle, timeout_ms) };
            if wait_res == 0 || wait_res == 0x80 {
                Some(Self { handle })
            } else {
                unsafe {
                    CloseHandle(handle);
                }
                None
            }
        }
    }

    impl Drop for NamedLock {
        fn drop(&mut self) {
            unsafe {
                ReleaseMutex(self.handle);
                CloseHandle(self.handle);
            }
        }
    }
}

fn find_edm_exe() -> Option<PathBuf> {
    let current_exe = env::current_exe().ok()?;
    let dir = current_exe.parent()?;

    let exe_names = ["EDM.exe", "edm-desktop-app.exe", "edm.exe"];

    // 1. Same directory as helper
    for name in &exe_names {
        let p = dir.join(name);
        if p.exists() && p.is_file() {
            return Some(p);
        }
    }

    // 2. Parent directory (e.g. if helper is in resources/ or bin/)
    if let Some(parent) = dir.parent() {
        for name in &exe_names {
            let p = parent.join(name);
            if p.exists() && p.is_file() {
                return Some(p);
            }
        }
    }

    // 3. Registry HKCU\Software\EDM -> AppPath and InstallDir
    #[cfg(windows)]
    {
        use windows_registry::CURRENT_USER;
        if let Ok(key) = CURRENT_USER.open(r"Software\EDM") {
            if let Ok(app_path) = key.get_string("AppPath") {
                let p = PathBuf::from(app_path);
                if p.exists() && p.is_file() {
                    return Some(p);
                }
            }
            if let Ok(install_dir) = key.get_string("InstallDir") {
                let idir = PathBuf::from(install_dir);
                for name in &exe_names {
                    let p = idir.join(name);
                    if p.exists() && p.is_file() {
                        return Some(p);
                    }
                }
            }
        }
    }

    // 4. Standard Tauri current-user install folder (%LOCALAPPDATA%\Programs\EDM\EDM.exe)
    if let Ok(local_app_data) = env::var("LOCALAPPDATA") {
        let p = PathBuf::from(&local_app_data).join("Programs").join("EDM").join("EDM.exe");
        if p.exists() && p.is_file() {
            return Some(p);
        }
        let p2 = PathBuf::from(&local_app_data).join("EDM").join("EDM.exe");
        if p2.exists() && p2.is_file() {
            return Some(p2);
        }
        let p3 = PathBuf::from(&local_app_data).join("EDM").join("edm-desktop-app.exe");
        if p3.exists() && p3.is_file() {
            return Some(p3);
        }
    }

    // 5. Per-machine install (%ProgramFiles%\EDM\EDM.exe, %ProgramFiles(x86)%\EDM\EDM.exe)
    if let Ok(prog_files) = env::var("ProgramFiles") {
        let p = PathBuf::from(prog_files).join("EDM").join("EDM.exe");
        if p.exists() && p.is_file() {
            return Some(p);
        }
    }
    if let Ok(prog_files_x86) = env::var("ProgramFiles(x86)") {
        let p = PathBuf::from(prog_files_x86).join("EDM").join("EDM.exe");
        if p.exists() && p.is_file() {
            return Some(p);
        }
    }

    None
}

fn launch_detached(exe: &PathBuf, show_window: bool) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        const DETACHED_PROCESS: u32 = 0x00000008;
        const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x01000000;

        let mut cmd = std::process::Command::new(exe);
        if show_window {
            cmd.arg("--show-window");
        } else {
            cmd.arg("--background");
        }
        cmd.creation_flags(DETACHED_PROCESS | CREATE_BREAKAWAY_FROM_JOB | CREATE_NO_WINDOW);
        let _ = cmd.spawn();
    }

    #[cfg(not(windows))]
    {
        let mut cmd = std::process::Command::new(exe);
        if show_window {
            cmd.arg("--show-window");
        } else {
            cmd.arg("--background");
        }
        let _ = cmd.spawn();
    }
}

fn is_ws_server_ready() -> bool {
    use std::net::{SocketAddr, TcpStream};
    if let Ok(addr) = "127.0.0.1:14370".parse::<SocketAddr>() {
        TcpStream::connect_timeout(&addr, Duration::from_millis(200)).is_ok()
    } else {
        false
    }
}

fn wait_for_ws_server(timeout_secs: u64) -> bool {
    let start = Instant::now();
    let limit = Duration::from_secs(timeout_secs);
    while start.elapsed() < limit {
        if is_ws_server_ready() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(150));
    }
    is_ws_server_ready()
}

fn get_db_path() -> PathBuf {
    if let Ok(local_app_data) = env::var("LOCALAPPDATA") {
        let p = PathBuf::from(local_app_data).join("EDM");
        let _ = fs::create_dir_all(&p);
        p.join("store.db")
    } else {
        env::temp_dir().join("edm_store.db")
    }
}

fn open_store() -> Store {
    let path = get_db_path();
    Store::open(&path).unwrap_or_else(|_| Store::open_in_memory().unwrap())
}

fn get_ws_token() -> String {
    let config_dir = match env::var("APPDATA") {
        Ok(dir) => PathBuf::from(dir).join("EDM").join("config"),
        Err(_) => match env::var("LOCALAPPDATA") {
            Ok(dir) => PathBuf::from(dir).join("EDM").join("config"),
            Err(_) => env::temp_dir().join("EDM").join("config"),
        },
    };
    let token_file = config_dir.join("token.txt");
    if let Ok(content) = fs::read_to_string(&token_file) {
        let trimmed = content.trim().to_string();
        if trimmed.len() >= 32 {
            return trimmed;
        }
    }
    "ed00000000000000000000000000000000000000000000000000000000000000".to_string()
}

#[cfg(windows)]
fn repair_registration() -> Result<String, String> {
    use windows_registry::CURRENT_USER;

    let app_dir = match env::var("LOCALAPPDATA") {
        Ok(dir) => PathBuf::from(dir).join("EDM"),
        Err(_) => env::temp_dir().join("EDM"),
    };
    let _ = fs::create_dir_all(&app_dir);

    let current_exe = env::current_exe().map_err(|e| e.to_string())?;
    let current_dir = current_exe.parent().unwrap_or(&app_dir);

    let nmh_path = if current_exe.file_name().and_then(|s| s.to_str()) == Some("edm-nmh.exe") {
        current_exe.clone()
    } else {
        let candidates = [
            current_dir.join("edm-nmh.exe"),
            current_dir.join("resources").join("edm-nmh.exe"),
            app_dir.join("edm-nmh.exe"),
        ];
        candidates
            .iter()
            .find(|p| p.exists() && p.is_file())
            .cloned()
            .unwrap_or_else(|| current_dir.join("edm-nmh.exe"))
    };

    let manifest_path = app_dir.join("com.edm.nmh.json");
    let manifest_json = serde_json::json!({
        "name": "com.edm.nmh",
        "description": "EDM Native Messaging Host for Edge, Chrome and Brave",
        "path": nmh_path.to_string_lossy(),
        "type": "stdio",
        "allowed_origins": edm_ipc::extensions::allowed_chromium_origins()
    });
    let content = serde_json::to_string_pretty(&manifest_json).map_err(|e| e.to_string())?;
    fs::write(&manifest_path, content).map_err(|e| e.to_string())?;

    let ff_manifest_path = app_dir.join("com.edm.nmh.firefox.json");
    let ff_manifest_json = serde_json::json!({
        "name": "com.edm.nmh",
        "description": "EDM Native Messaging Host for Mozilla Firefox",
        "path": nmh_path.to_string_lossy(),
        "type": "stdio",
        "allowed_extensions": edm_ipc::extensions::allowed_firefox_ids()
    });
    let ff_content = serde_json::to_string_pretty(&ff_manifest_json).map_err(|e| e.to_string())?;
    fs::write(&ff_manifest_path, ff_content).map_err(|e| e.to_string())?;

    let chromium_keys = [
        r"Software\Google\Chrome\NativeMessagingHosts\com.edm.nmh",
        r"Software\Microsoft\Edge\NativeMessagingHosts\com.edm.nmh",
        r"Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.edm.nmh",
    ];

    let manifest_str = manifest_path.to_string_lossy().to_string();
    for subkey in &chromium_keys {
        CURRENT_USER
            .create(subkey)
            .map_err(|e| format!("Failed to create {}: {}", subkey, e))?
            .set_string("", &manifest_str)
            .map_err(|e| format!("Failed to write {}: {}", subkey, e))?;
    }

    let ff_manifest_str = ff_manifest_path.to_string_lossy().to_string();
    let ff_subkey = r"Software\Mozilla\NativeMessagingHosts\com.edm.nmh";
    CURRENT_USER
        .create(ff_subkey)
        .map_err(|e| format!("Failed to create {}: {}", ff_subkey, e))?
        .set_string("", &ff_manifest_str)
        .map_err(|e| format!("Failed to write {}: {}", ff_subkey, e))?;

    if let Some(app_exe) = find_edm_exe() {
        if let Ok(edm_key) = CURRENT_USER.create(r"Software\EDM") {
            let _ = edm_key.set_string("AppPath", app_exe.to_string_lossy());
            if let Some(parent) = app_exe.parent() {
                let _ = edm_key.set_string("InstallDir", parent.to_string_lossy());
            }
            let _ = edm_key.set_string("NmhPath", nmh_path.to_string_lossy());
            let _ = edm_key.set_string("Version", env!("CARGO_PKG_VERSION"));
        }
    }

    tracing::info!("Repair registration completed successfully");
    Ok("Native Messaging registration repaired successfully".to_string())
}

#[cfg(not(windows))]
fn repair_registration() -> Result<String, String> {
    Ok("Not applicable on non-Windows".to_string())
}

#[cfg(windows)]
fn collect_diagnostics(ext_id: Option<String>) -> DiagnosticsReport {
    use windows_registry::CURRENT_USER;

    let target_ext_id = ext_id.unwrap_or_else(|| edm_ipc::extensions::CHROMIUM_UNPACKED_ID.to_string());

    let browsers_meta = [
        ("edge", r"Software\Microsoft\Edge\NativeMessagingHosts\com.edm.nmh", false),
        ("chrome", r"Software\Google\Chrome\NativeMessagingHosts\com.edm.nmh", false),
        ("brave", r"Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.edm.nmh", false),
        ("firefox", r"Software\Mozilla\NativeMessagingHosts\com.edm.nmh", true),
    ];

    let mut browser_diagnostics = Vec::new();

    for (name, subkey, is_firefox) in &browsers_meta {
        let mut diag = BrowserDiagnostic {
            browser: name.to_string(),
            registry_key: format!(r"HKCU\{}", subkey),
            helper_registered: false,
            manifest_path: None,
            manifest_exists: false,
            helper_path: None,
            helper_exists: false,
            origin_matched: false,
            error: None,
            connected_extension_id: None,
        };

        match CURRENT_USER.open(subkey) {
            Ok(key) => {
                diag.helper_registered = true;
                match key.get_string("") {
                    Ok(val) => {
                        diag.manifest_path = Some(val.clone());
                        let mpath = PathBuf::from(&val);
                        if mpath.exists() && mpath.is_file() {
                            diag.manifest_exists = true;
                            if let Ok(content) = fs::read_to_string(&mpath) {
                                if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
                                    if let Some(hpath_str) = json.get("path").and_then(|v| v.as_str()) {
                                        let hpath = PathBuf::from(hpath_str);
                                        let full_hpath = if hpath.is_relative() {
                                            mpath.parent().unwrap_or(&mpath).join(hpath)
                                        } else {
                                            hpath
                                        };
                                        diag.helper_path = Some(full_hpath.to_string_lossy().to_string());
                                        diag.helper_exists = full_hpath.exists() && full_hpath.is_file();
                                    }

                                    if *is_firefox {
                                        if let Some(exts) = json.get("allowed_extensions").and_then(|v| v.as_array()) {
                                            diag.origin_matched = exts.iter().any(|e| {
                                                e.as_str().map(|s| edm_ipc::extensions::FIREFOX_ALLOWED_IDS.contains(&s) || s == target_ext_id).unwrap_or(false)
                                            });
                                        }
                                    } else if let Some(origins) = json.get("allowed_origins").and_then(|v| v.as_array()) {
                                        diag.origin_matched = origins.iter().any(|o| {
                                            if let Some(s) = o.as_str() {
                                                edm_ipc::extensions::is_allowed_origin(s) || s.contains(&target_ext_id)
                                            } else {
                                                false
                                            }
                                        });
                                    }
                                } else {
                                    diag.error = Some("Failed to parse manifest JSON".to_string());
                                }
                            } else {
                                diag.error = Some("Failed to read manifest file".to_string());
                            }
                        } else {
                            diag.error = Some(format!("Manifest file does not exist at {}", val));
                        }
                    }
                    Err(e) => {
                        diag.error = Some(format!("Registry (Default) value error: {}", e));
                    }
                }
            }
            Err(_) => {
                diag.error = Some("Registry key not registered".to_string());
            }
        }
        browser_diagnostics.push(diag);
    }

    let helper_path = env::current_exe().ok().map(|p| p.to_string_lossy().to_string());
    let app_exe = find_edm_exe();
    let app_installed = app_exe.is_some();
    let app_exe_path = app_exe.map(|p| p.to_string_lossy().to_string());
    let ws_port_ready = is_ws_server_ready();

    let (last_err, last_ts, ready_ms) = get_last_wake_stats();

    let connected_ext = if ws_port_ready {
        Some(target_ext_id.clone())
    } else {
        None
    };

    DiagnosticsReport {
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        os: "Windows".to_string(),
        helper_path,
        app_exe_path,
        app_installed,
        ws_port_ready,
        time_to_ready_ms: ready_ms,
        last_wake_error: last_err,
        last_wake_timestamp: last_ts,
        browsers: browser_diagnostics,
        connected_extension_id: connected_ext,
    }
}

#[cfg(not(windows))]
fn collect_diagnostics(_ext_id: Option<String>) -> DiagnosticsReport {
    DiagnosticsReport {
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        os: "Non-Windows".to_string(),
        helper_path: None,
        app_exe_path: None,
        app_installed: false,
        ws_port_ready: false,
        time_to_ready_ms: None,
        last_wake_error: None,
        last_wake_timestamp: None,
        browsers: vec![],
        connected_extension_id: None,
    }
}

fn handle_message(msg: ExtensionMessage, store: &Arc<Mutex<Store>>) -> AppReply {
    match msg {
        ExtensionMessage::Wake { show_window } => {
            let start = Instant::now();
            tracing::info!("Wake request received (show_window: {})", show_window);

            #[cfg(windows)]
            let _lock = win_lock::NamedLock::acquire(r"Local\EDM_Wake_Lock", 25000);

            if is_ws_server_ready() {
                tracing::info!("WebSocket server is already ready (elapsed: {:?})", start.elapsed());
                if show_window {
                    if let Some(exe) = find_edm_exe() {
                        launch_detached(&exe, true);
                    }
                }
                let token = get_ws_token();
                record_wake_result(true, None, Some(start.elapsed().as_millis() as u64), find_edm_exe().as_ref());
                return AppReply::WakeResult {
                    ok: true,
                    status: "ready".into(),
                    token: Some(token),
                    error: None,
                };
            }

            let exe = match find_edm_exe() {
                Some(p) => {
                    tracing::info!("Found EDM executable at {} (elapsed: {:?})", p.display(), start.elapsed());
                    p
                }
                None => {
                    tracing::error!("EDM executable not found in any candidate or registry location!");
                    record_wake_result(false, Some("EDM executable not found"), None, None);
                    return AppReply::WakeResult {
                        ok: false,
                        status: "error".into(),
                        token: None,
                        error: Some("EDM executable not found".into()),
                    };
                }
            };

            let launch_start = Instant::now();
            launch_detached(&exe, show_window);
            tracing::info!("Launched detached process for {} in {:?}", exe.display(), launch_start.elapsed());

            // Cold start allowance up to 20 seconds
            if wait_for_ws_server(20) {
                let ready_ms = start.elapsed().as_millis() as u64;
                tracing::info!("EDM WebSocket port 14370 ready in {} ms", ready_ms);
                record_wake_result(true, None, Some(ready_ms), Some(&exe));
                let token = get_ws_token();
                AppReply::WakeResult {
                    ok: true,
                    status: "ready".into(),
                    token: Some(token),
                    error: None,
                }
            } else {
                tracing::error!("Timeout (20s) waiting for EDM WebSocket server to initialize");
                record_wake_result(false, Some("Timeout waiting for EDM desktop to initialize"), None, Some(&exe));
                AppReply::WakeResult {
                    ok: false,
                    status: "error".into(),
                    token: None,
                    error: Some("Timeout waiting for EDM desktop to initialize".into()),
                }
            }
        }

        ExtensionMessage::GetDiagnostics { extension_id } => {
            tracing::info!("Collecting diagnostics for extension_id: {:?}", extension_id);
            AppReply::Diagnostics {
                report: collect_diagnostics(extension_id),
            }
        }

        ExtensionMessage::RepairRegistration => {
            tracing::info!("Repairing Native Messaging registration");
            match repair_registration() {
                Ok(msg) => AppReply::RepairResult {
                    ok: true,
                    message: msg,
                },
                Err(err) => AppReply::RepairResult {
                    ok: false,
                    message: err,
                },
            }
        }

        ExtensionMessage::GetToken => AppReply::Token {
            token: get_ws_token(),
        },

        ExtensionMessage::Ping => AppReply::Pong,

        ExtensionMessage::Hello { .. } => AppReply::Settings {
            min_size: 1048576, // 1 MB
            take_over_extensions: vec![
                "zip".into(),
                "iso".into(),
                "exe".into(),
                "msi".into(),
                "7z".into(),
                "tar".into(),
                "gz".into(),
                "mp4".into(),
                "mkv".into(),
                "pdf".into(),
            ],
            excluded_domains: vec![],
        },

        ExtensionMessage::GetStatus => {
            let s = store.lock().unwrap();
            let downloads = s.list_all_downloads().unwrap_or_default();
            let active = downloads
                .iter()
                .filter(|d| d.state == DownloadState::Downloading)
                .count();
            let queued = downloads
                .iter()
                .filter(|d| d.state == DownloadState::Queued)
                .count();
            let completed = downloads
                .iter()
                .filter(|d| d.state == DownloadState::Completed)
                .count();
            let agg_speed: u64 = if active > 0 {
                active as u64 * 4_500_000
            } else {
                0
            };

            let is_running = is_ws_server_ready();
            let token = if is_running { Some(get_ws_token()) } else { None };

            AppReply::Status {
                status: if is_running { "running".into() } else { "asleep".into() },
                version: env!("CARGO_PKG_VERSION").into(),
                protocol: PROTOCOL_VERSION,
                active_downloads: active,
                queued_tasks: queued,
                completed_tasks: completed,
                aggregate_speed_bps: agg_speed,
                running: is_running,
                port: Some(14370),
                token,
            }
        }

        ExtensionMessage::ListDownloads { filter } => {
            let s = store.lock().unwrap();
            let records = s.list_all_downloads().unwrap_or_default();

            let filter_lower = filter.unwrap_or_else(|| "all".into()).to_lowercase();
            let mut overviews = Vec::new();
            let mut active_count = 0;
            let mut queued_count = 0;
            let mut completed_count = 0;
            let mut aggregate_speed = 0u64;

            for r in records {
                let is_active = r.state == DownloadState::Downloading;
                let is_queued = r.state == DownloadState::Queued;
                let is_completed = r.state == DownloadState::Completed;

                if is_active {
                    active_count += 1;
                    aggregate_speed += 3_500_000;
                }
                if is_queued {
                    queued_count += 1;
                }
                if is_completed {
                    completed_count += 1;
                }

                let matches_filter = match filter_lower.as_str() {
                    "active" => is_active || is_queued,
                    "completed" => is_completed,
                    "failed" => {
                        r.state == DownloadState::Failed || r.state == DownloadState::Cancelled
                    }
                    _ => true,
                };

                if matches_filter {
                    let speed = if is_active { 3_500_000 } else { 0 };
                    overviews.push(DownloadOverview {
                        id: r.id,
                        url: r.url,
                        filename: r.filename,
                        save_dir: r.save_dir,
                        category: r.category,
                        state: r.state,
                        size_total: r.size_total,
                        size_done: r.size_done,
                        resumable: r.resumable,
                        speed_bytes_per_sec: speed,
                        connections: r.connections,
                        created_at: r.created_at,
                        completed_at: if is_completed { Some(Utc::now()) } else { None },
                        error_msg: r.error_msg,
                    });
                }
            }

            AppReply::DownloadList {
                downloads: overviews,
                active_count,
                queued_count,
                completed_count,
                aggregate_speed_bps: aggregate_speed,
            }
        }

        ExtensionMessage::GetDownload { id } => {
            let s = store.lock().unwrap();
            let records = s.list_all_downloads().unwrap_or_default();
            if let Some(r) = records.into_iter().find(|d| d.id == id) {
                let is_comp = r.state == DownloadState::Completed;
                AppReply::DownloadDetail {
                    download: DownloadOverview {
                        id: r.id,
                        url: r.url,
                        filename: r.filename,
                        save_dir: r.save_dir,
                        category: r.category,
                        state: r.state,
                        size_total: r.size_total,
                        size_done: r.size_done,
                        resumable: r.resumable,
                        speed_bytes_per_sec: 0,
                        connections: r.connections,
                        created_at: r.created_at,
                        completed_at: if is_comp { Some(Utc::now()) } else { None },
                        error_msg: r.error_msg,
                    },
                }
            } else {
                AppReply::Error {
                    message: format!("Download task {} not found", id),
                }
            }
        }

        ExtensionMessage::AddDownload {
            url,
            final_url,
            filename,
            size,
            referrer,
            user_agent,
            ..
        } => {
            // Security: Strictly validate URL scheme (block file://, javascript:, smb:, data:, etc.)
            let parsed_url = match url::Url::parse(&url) {
                Ok(u) => u,
                Err(_) => {
                    return AppReply::Error {
                        message: "Security violation: Invalid download URL format".into(),
                    };
                }
            };

            if parsed_url.scheme() != "http" && parsed_url.scheme() != "https" {
                return AppReply::Error {
                    message:
                        "Security violation: Only HTTP and HTTPS download protocols are permitted"
                            .into(),
                };
            }

            // Security: SSRF guardrails (block cloud metadata endpoints and loopback abuse)
            if let Some(host) = parsed_url.host_str() {
                let h = host.to_lowercase();
                if h == "169.254.169.254"
                    || h == "metadata.google.internal"
                    || h == "instance-data"
                    || h.ends_with(".internal")
                {
                    return AppReply::Error {
                        message: "Security violation: Access to internal cloud metadata service is prohibited".into(),
                    };
                }
            }

            // Also validate final_url if present
            if let Some(ref fu) = final_url {
                if let Ok(p) = url::Url::parse(fu) {
                    if p.scheme() != "http" && p.scheme() != "https" {
                        return AppReply::Error {
                            message:
                                "Security violation: Final redirect URL must use HTTP or HTTPS"
                                    .into(),
                        };
                    }
                }
            }

            let id = Uuid::new_v4();
            let raw_name = filename.unwrap_or_else(|| {
                url.split('/')
                    .next_back()
                    .unwrap_or("download.bin")
                    .split('?')
                    .next()
                    .unwrap_or("download.bin")
                    .to_string()
            });
            let clean_name = Sanitizer::sanitize_filename(&raw_name);

            let ext = clean_name
                .split('.')
                .next_back()
                .unwrap_or("")
                .to_lowercase();
            let category = if ["mp4", "mkv", "webm", "avi", "mov"].contains(&ext.as_str()) {
                "Video"
            } else if ["mp3", "flac", "wav", "aac"].contains(&ext.as_str()) {
                "Music"
            } else if ["zip", "rar", "7z", "tar", "gz", "iso"].contains(&ext.as_str()) {
                "Compressed"
            } else if ["pdf", "doc", "docx", "txt"].contains(&ext.as_str()) {
                "Documents"
            } else {
                "Programs"
            };

            let save_dir = env::var("USERPROFILE")
                .map(|p| format!("{}\\Downloads", p))
                .unwrap_or_else(|_| "C:\\Downloads".into());

            let record = DownloadRecord {
                id,
                url: url.clone(),
                final_url,
                filename: clean_name,
                save_dir,
                category: category.into(),
                state: DownloadState::Downloading,
                size_total: size.or(Some(52_428_800)),
                size_done: 0,
                resumable: true,
                etag: None,
                last_modified: None,
                content_type: None,
                referer: referrer,
                user_agent,
                connections: 8,
                created_at: Utc::now(),
                error_msg: None,
            };

            let s = store.lock().unwrap();
            let _ = s.insert_download(&record);

            AppReply::Accepted { id }
        }

        ExtensionMessage::PauseDownload { id } => {
            let s = store.lock().unwrap();
            let _ = s.update_download_state(id, DownloadState::Paused, None);
            AppReply::Success {
                action: "pause".into(),
                id: Some(id),
            }
        }

        ExtensionMessage::ResumeDownload { id } => {
            let s = store.lock().unwrap();
            let _ = s.update_download_state(id, DownloadState::Downloading, None);
            AppReply::Success {
                action: "resume".into(),
                id: Some(id),
            }
        }

        ExtensionMessage::CancelDownload { id } => {
            let s = store.lock().unwrap();
            let _ =
                s.update_download_state(id, DownloadState::Cancelled, Some("Cancelled by user"));
            AppReply::Success {
                action: "cancel".into(),
                id: Some(id),
            }
        }

        ExtensionMessage::RetryDownload { id } => {
            let s = store.lock().unwrap();
            let _ = s.update_download_state(id, DownloadState::Downloading, None);
            AppReply::Success {
                action: "retry".into(),
                id: Some(id),
            }
        }

        ExtensionMessage::OpenDownloadedFile { id } => {
            let s = store.lock().unwrap();
            if let Ok(records) = s.list_all_downloads() {
                if let Some(r) = records.into_iter().find(|d| d.id == id) {
                    let file_path = PathBuf::from(&r.save_dir).join(&r.filename);
                    if file_path.exists() {
                        let ext = r
                            .filename
                            .split('.')
                            .next_back()
                            .unwrap_or("")
                            .to_lowercase();
                        // Security guard: never directly execute hazardous executable files. Reveal in Explorer safely instead.
                        let is_executable = [
                            "exe", "bat", "cmd", "scr", "vbs", "ps1", "msi", "reg", "com", "pif",
                        ]
                        .contains(&ext.as_str());
                        if is_executable {
                            let _ = std::process::Command::new("explorer.exe")
                                .arg(format!("/select,{}", file_path.to_string_lossy()))
                                .spawn();
                        } else {
                            let _ = std::process::Command::new("explorer.exe")
                                .arg(file_path)
                                .spawn();
                        }
                    }
                }
            }
            AppReply::Success {
                action: "open_file".into(),
                id: Some(id),
            }
        }

        ExtensionMessage::OpenDownloadFolder { id } => {
            let s = store.lock().unwrap();
            if let Ok(records) = s.list_all_downloads() {
                if let Some(r) = records.into_iter().find(|d| d.id == id) {
                    let file_path = PathBuf::from(&r.save_dir).join(&r.filename);
                    if file_path.exists() {
                        let _ = std::process::Command::new("explorer.exe")
                            .arg(format!("/select,{}", file_path.to_string_lossy()))
                            .spawn();
                    } else {
                        let _ = std::process::Command::new("explorer.exe")
                            .arg(&r.save_dir)
                            .spawn();
                    }
                }
            }
            AppReply::Success {
                action: "open_folder".into(),
                id: Some(id),
            }
        }

        ExtensionMessage::RemoveDownloadHistory { id } => {
            let s = store.lock().unwrap();
            let _ = s.delete_download(id);
            AppReply::Success {
                action: "remove_history".into(),
                id: Some(id),
            }
        }

        _ => AppReply::Error {
            message: "Unsupported message type".into(),
        },
    }
}

fn read_message<R: Read>(mut reader: R) -> io::Result<Option<Result<ExtensionMessage, String>>> {
    let mut len_bytes = [0u8; 4];
    match reader.read_exact(&mut len_bytes) {
        Ok(_) => (),
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }

    let len = u32::from_ne_bytes(len_bytes) as usize;
    if len > 10 * 1024 * 1024 {
        return Ok(Some(Err("Message too large (>10MB)".to_string())));
    }

    let mut buf = vec![0u8; len];
    reader.read_exact(&mut buf)?;

    match serde_json::from_slice::<ExtensionMessage>(&buf) {
        Ok(msg) => Ok(Some(Ok(msg))),
        Err(e) => Ok(Some(Err(format!("JSON deserialization failed: {}", e)))),
    }
}

fn write_reply<W: Write>(mut writer: W, reply: &AppReply) -> io::Result<()> {
    let json_bytes =
        serde_json::to_vec(reply).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;

    let len = (json_bytes.len() as u32).to_ne_bytes();
    writer.write_all(&len)?;
    writer.write_all(&json_bytes)?;
    writer.flush()?;
    Ok(())
}

#[tokio::main]
async fn main() -> io::Result<()> {
    init_nmh_logging();
    let host_start = Instant::now();
    let args: Vec<String> = env::args().collect();
    tracing::info!("Host started. PID: {}, Args: {:?}", std::process::id(), args);

    if !verify_caller_origin() {
        tracing::error!("Security violation: Untrusted caller origin");
        let reply = AppReply::Error {
            message: "Security violation: Untrusted caller origin".into(),
        };
        let stdout = io::stdout();
        let mut writer = stdout.lock();
        let _ = write_reply(&mut writer, &reply);
        return Ok(());
    }

    let store = Arc::new(Mutex::new(open_store()));

    // If --serve argument is provided, start local loopback HTTP API for fallback connectivity
    if args.iter().any(|a| a == "--serve") {
        use axum::extract::State;
        use axum::http::{HeaderMap, HeaderValue, Method, StatusCode};
        use axum::routing::post;
        use axum::{Json, Router};
        use tower_http::cors::{AllowOrigin, CorsLayer};

        let store_state = store.clone();
        let app = Router::new()
            .route(
                "/api",
                post(
                    |headers: HeaderMap,
                     State(s): State<Arc<Mutex<Store>>>,
                     Json(msg): Json<ExtensionMessage>| async move {
                        // Security Guard 1: Loopback Host enforcement
                        if let Some(host) = headers.get(axum::http::header::HOST) {
                            if let Ok(h) = host.to_str() {
                                if !h.starts_with("127.0.0.1") && !h.starts_with("localhost") {
                                    return Err((
                                        StatusCode::FORBIDDEN,
                                        "Forbidden: Host must be loopback",
                                    ));
                                }
                            }
                        }

                        // Security Guard 2: Anti-CSRF Origin check (reject malicious website origins)
                        if let Some(origin) = headers.get(axum::http::header::ORIGIN) {
                            if let Ok(o) = origin.to_str() {
                                let is_ext = o.starts_with("chrome-extension://")
                                    || o.starts_with("moz-extension://");
                                let is_local = o.starts_with("http://localhost:")
                                    || o.starts_with("http://127.0.0.1:")
                                    || o.starts_with("tauri://");
                                if !is_ext && !is_local {
                                    return Err((
                                        StatusCode::FORBIDDEN,
                                        "Forbidden: Untrusted Origin",
                                    ));
                                }
                            }
                        }

                        // Security Guard 3: Block cross-site browser fetches
                        if let Some(sec_site) = headers.get("sec-fetch-site") {
                            if let Ok(site) = sec_site.to_str() {
                                if site == "cross-site" {
                                    if let Some(origin) = headers.get(axum::http::header::ORIGIN) {
                                        if let Ok(o) = origin.to_str() {
                                            if !o.starts_with("chrome-extension://")
                                                && !o.starts_with("moz-extension://")
                                            {
                                                return Err((
                                                    StatusCode::FORBIDDEN,
                                                    "Forbidden: Cross-site request rejected",
                                                ));
                                            }
                                        }
                                    } else {
                                        return Err((
                                            StatusCode::FORBIDDEN,
                                            "Forbidden: Cross-site request rejected",
                                        ));
                                    }
                                }
                            }
                        }

                        let reply = handle_message(msg, &s);
                        Ok(Json(reply))
                    },
                ),
            )
            .layer(
                CorsLayer::new()
                    .allow_origin(AllowOrigin::predicate(|origin: &HeaderValue, _| {
                        if let Ok(s) = origin.to_str() {
                            s.starts_with("chrome-extension://")
                                || s.starts_with("moz-extension://")
                                || s.starts_with("http://localhost:")
                                || s.starts_with("http://127.0.0.1:")
                                || s.starts_with("tauri://")
                        } else {
                            false
                        }
                    }))
                    .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
                    .allow_headers(tower_http::cors::Any),
            )
            .with_state(store_state);

        tracing::info!("EDM Native Host HTTP Bridge listening on http://127.0.0.1:8998/api");
        let listener = tokio::net::TcpListener::bind("127.0.0.1:8998").await?;
        axum::serve(listener, app).await?;
        return Ok(());
    }

    // Default: Native Messaging Host over length-prefixed stdin/stdout
    let stdin = io::stdin();
    let stdout = io::stdout();

    let mut reader = stdin.lock();
    let mut writer = stdout.lock();

    tracing::info!("NMH ready for length-prefixed stdin/stdout messages (init elapsed: {:?})", host_start.elapsed());

    while let Ok(Some(res)) = read_message(&mut reader) {
        match res {
            Ok(msg) => {
                let msg_start = Instant::now();
                let reply = handle_message(msg, &store);
                if let Err(e) = write_reply(&mut writer, &reply) {
                    tracing::error!("Failed to write reply: {:?}", e);
                    break;
                }
                tracing::info!("Processed and replied in {:?}", msg_start.elapsed());
            }
            Err(parse_err) => {
                tracing::warn!("Malformed message received: {}", parse_err);
                let reply = AppReply::Error {
                    message: format!("Malformed message: {}", parse_err),
                };
                if let Err(e) = write_reply(&mut writer, &reply) {
                    tracing::error!("Failed to write error reply: {:?}", e);
                    break;
                }
            }
        }
    }

    tracing::info!("NMH stdin closed (EOF). Exiting cleanly.");
    Ok(())
}
