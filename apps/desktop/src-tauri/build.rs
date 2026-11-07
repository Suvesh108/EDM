fn main() {
    let nmh_path = std::path::Path::new("../../../target/release/edm-nmh.exe");
    if !nmh_path.exists() {
        if let Some(parent) = nmh_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(nmh_path, b"");
    }

    let webview2_path = std::path::Path::new("../../../target/release/WebView2Loader.dll");
    if !webview2_path.exists() {
        if let Some(parent) = webview2_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(webview2_path, b"");
    }

    tauri_build::build()
}
