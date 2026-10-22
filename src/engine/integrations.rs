use std::path::Path;
use tracing::info;

pub fn register_windows_integrations(exe_path: &Path) {
    #[cfg(target_os = "windows")]
    {
        use std::process::Command;
        let exe_str = exe_path.to_string_lossy();
        let cmd = format!("\"{}\" \"%1\"", exe_str);

        // Register vortex:// protocol scheme
        let reg_commands = [
            format!("reg add \"HKCU\\Software\\Classes\\vortex\" /ve /d \"URL:Vortex Downloader Protocol\" /f"),
            format!("reg add \"HKCU\\Software\\Classes\\vortex\" /v \"URL Protocol\" /d \"\" /f"),
            format!("reg add \"HKCU\\Software\\Classes\\vortex\\shell\\open\\command\" /ve /d \"{}\" /f", cmd),
        ];

        for c in reg_commands {
            let _ = Command::new("cmd").args(["/C", &c]).output();
        }
        info!("Windows URL protocol registered: vortex://");
    }
}
