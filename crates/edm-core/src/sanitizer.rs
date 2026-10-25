use std::path::{Path, PathBuf};

pub struct Sanitizer;

impl Sanitizer {
    const RESERVED_NAMES: &'static [&'static str] = &[
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
        "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];

    /// Cleans and sanitizes a filename for Windows file systems:
    /// - Strips path separators (`/`, `\`) and `..`
    /// - Replaces invalid characters (`<`, `>`, `:`, `"`, `/`, `\`, `|`, `?`, `*`)
    /// - Handles reserved Windows device names (CON, PRN, AUX, NUL, COM1-9, LPT1-9)
    /// - Strips trailing spaces and periods
    /// - Enforces maximum filename length (255 bytes)
    pub fn sanitize_filename(raw_name: &str) -> String {
        let trimmed = raw_name.trim();
        if trimmed.is_empty() {
            return "download".to_string();
        }

        // 1. Remove path components (take last segment)
        let normalized = trimmed.replace('\\', "/");
        let last_segment = normalized
            .split('/')
            .rfind(|s| !s.is_empty() && *s != "..")
            .unwrap_or("download");

        // 2. Filter out control characters and illegal characters
        let mut cleaned: String = last_segment
            .chars()
            .map(|c| match c {
                '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
                c if (c as u32) < 32 => '_',
                c => c,
            })
            .collect();

        // 3. Strip trailing dots and spaces
        while cleaned.ends_with('.') || cleaned.ends_with(' ') {
            cleaned.pop();
        }

        if cleaned.is_empty() {
            cleaned = "download".to_string();
        }

        // 4. Check for Windows reserved names (ignoring extension)
        let stem = match cleaned.find('.') {
            Some(idx) => &cleaned[..idx],
            None => &cleaned,
        };

        if Self::RESERVED_NAMES
            .iter()
            .any(|&res| stem.eq_ignore_ascii_case(res))
        {
            cleaned = format!("_{}", cleaned);
        }

        // 5. Truncate to 255 bytes if needed while keeping UTF-8 validity
        if cleaned.len() > 255 {
            let mut end_idx = 255;
            while !cleaned.is_char_boundary(end_idx) && end_idx > 0 {
                end_idx -= 1;
            }
            cleaned.truncate(end_idx);
        }

        cleaned
    }

    /// Resolves duplicate filename policy (auto-rename with increment: `foo (1).zip`)
    pub fn resolve_duplicate<P: AsRef<Path>>(target_dir: P, filename: &str) -> PathBuf {
        let dir = target_dir.as_ref();
        let target = dir.join(filename);
        if !target.exists() {
            return target;
        }

        let stem = match filename.rfind('.') {
            Some(idx) => &filename[..idx],
            None => filename,
        };
        let ext = match filename.rfind('.') {
            Some(idx) => &filename[idx..],
            None => "",
        };

        let mut counter = 1;
        loop {
            let candidate_name = format!("{} ({}){}", stem, counter, ext);
            let candidate_path = dir.join(&candidate_name);
            if !candidate_path.exists() {
                return candidate_path;
            }
            counter += 1;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sanitizer_edge_cases() {
        assert_eq!(Sanitizer::sanitize_filename("CON.txt"), "_CON.txt");
        assert_eq!(Sanitizer::sanitize_filename("prn"), "_prn");
        assert_eq!(Sanitizer::sanitize_filename("aux.zip"), "_aux.zip");
        assert_eq!(Sanitizer::sanitize_filename("nul"), "_nul");
        assert_eq!(Sanitizer::sanitize_filename("com1.tar.gz"), "_com1.tar.gz");
        assert_eq!(Sanitizer::sanitize_filename("../../evil.exe"), "evil.exe");
        assert_eq!(Sanitizer::sanitize_filename("foo/bar/baz.iso"), "baz.iso");
        assert_eq!(
            Sanitizer::sanitize_filename("file:name?.mp4"),
            "file_name_.mp4"
        );
        assert_eq!(
            Sanitizer::sanitize_filename("trailing-dots..."),
            "trailing-dots"
        );
        assert_eq!(
            Sanitizer::sanitize_filename("trailing-spaces   "),
            "trailing-spaces"
        );
        assert_eq!(Sanitizer::sanitize_filename(""), "download");
        assert_eq!(Sanitizer::sanitize_filename("   "), "download");
        assert_eq!(
            Sanitizer::sanitize_filename("日本語のファイル.pdf"),
            "日本語のファイル.pdf"
        );
        assert_eq!(
            Sanitizer::sanitize_filename("Spaces In Name.7z"),
            "Spaces In Name.7z"
        );
    }
}
