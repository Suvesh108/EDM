use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum Category {
    Video,
    Audio,
    Images,
    Subtitles,
    Documents,
    Archives,
    Programs,
    Other,
}

impl Category {
    pub fn as_str(&self) -> &'static str {
        match self {
            Category::Video => "Video",
            Category::Audio => "Audio",
            Category::Images => "Images",
            Category::Subtitles => "Subtitles",
            Category::Documents => "Documents",
            Category::Archives => "Archives",
            Category::Programs => "Programs",
            Category::Other => "Other",
        }
    }

    pub fn from_str(s: &str) -> Self {
        match s.to_lowercase().as_str() {
            "video" => Category::Video,
            "audio" => Category::Audio,
            "images" | "image" => Category::Images,
            "subtitles" | "subtitle" => Category::Subtitles,
            "documents" | "document" => Category::Documents,
            "archives" | "archive" => Category::Archives,
            "programs" | "program" => Category::Programs,
            _ => Category::Other,
        }
    }
}

pub fn classify_extension(ext: &str) -> Category {
    let clean_ext = if let Some(stripped) = ext.strip_prefix('.') {
        stripped.to_lowercase()
    } else {
        ext.to_lowercase()
    };

    match clean_ext.as_str() {
        // Video — 20 extensions
        "mp4" | "mkv" | "avi" | "mov" | "wmv" | "flv" | "webm" | "m4v" | "mpg" | "mpeg"
        | "3gp" | "ts" | "m2ts" | "mts" | "vob" | "ogv" | "divx" | "asf" | "rmvb" | "f4v" => {
            Category::Video
        }

        // Audio — 12 extensions
        "mp3" | "flac" | "wav" | "aac" | "ogg" | "wma" | "m4a" | "opus" | "aiff" | "alac"
        | "mid" | "midi" => Category::Audio,

        // Images — 13 extensions
        "jpg" | "jpeg" | "png" | "gif" | "bmp" | "webp" | "svg" | "tiff" | "tif" | "ico"
        | "heic" | "heif" | "avif" => Category::Images,

        // Subtitles — 10 extensions
        "srt" | "ass" | "ssa" | "sub" | "vtt" | "sbv" | "idx" | "sup" | "smi" | "lrc" => {
            Category::Subtitles
        }

        // Documents — 19 extensions
        "pdf" | "doc" | "docx" | "xls" | "xlsx" | "ppt" | "pptx" | "txt" | "rtf" | "odt"
        | "ods" | "odp" | "csv" | "md" | "tex" | "epub" | "mobi" | "pages" | "wps" => {
            Category::Documents
        }

        // Archives — 24 extensions
        "zip" | "rar" | "7z" | "tar" | "gz" | "bz2" | "xz" | "zst" | "lz" | "lzma" | "cab"
        | "iso" | "img" | "dmg" | "tgz" | "tbz2" | "txz" | "br" | "arj" | "ace" | "lzh"
        | "cpio" | "deb" | "rpm" => Category::Archives,

        // Programs — 21 extensions
        "exe" | "msi" | "msu" | "msp" | "appx" | "msix" | "appxbundle" | "msixbundle" | "bat"
        | "cmd" | "com" | "scr" | "sys" | "dll" | "ocx" | "jar" | "apk" | "app" | "pkg" => {
            Category::Programs
        }

        _ => Category::Other,
    }
}

pub fn get_category_for_filename(filename: &str) -> Category {
    if let Some(pos) = filename.rfind('.') {
        classify_extension(&filename[pos + 1..])
    } else {
        Category::Other
    }
}

pub fn resolve_destination_path(
    filename: &str,
    base_dir: &Path,
    auto_categorize: bool,
) -> (Category, PathBuf) {
    let cat = get_category_for_filename(filename);
    let target_dir = if auto_categorize {
        base_dir.join(cat.as_str())
    } else {
        base_dir.to_path_buf()
    };
    let _ = std::fs::create_dir_all(&target_dir);
    (cat, target_dir.join(filename))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_categorization() {
        assert_eq!(classify_extension("mp4"), Category::Video);
        assert_eq!(classify_extension("flac"), Category::Audio);
        assert_eq!(classify_extension("webp"), Category::Images);
        assert_eq!(classify_extension("srt"), Category::Subtitles);
        assert_eq!(classify_extension("pdf"), Category::Documents);
        assert_eq!(classify_extension("7z"), Category::Archives);
        assert_eq!(classify_extension("exe"), Category::Programs);
        assert_eq!(classify_extension("xyz123"), Category::Other);
    }
}
