//! EDM Modular Feature Packs - Native Rust Implementation
//! Unifying all 9 protocol packs: HTTP, BitTorrent, FTP, eD2k, M3U8, FFmpeg, yt-dlp, GitHub, Hugging Face

pub mod bittorrent;
pub mod ed2k;
pub mod executor;
pub mod extractors;
pub mod ffmpeg;
pub mod ftp;
pub mod github;
pub mod http;
pub mod huggingface;
pub mod m3u8;
pub mod process;
pub mod remux;
pub mod traits;
pub mod ytdlp;

pub use bittorrent::{BencodeValue, BitTorrentPack, MagnetInfo};
pub use ed2k::{Ed2kFileInfo, Ed2kPack, ED2K_CHUNK_SIZE};
pub use executor::PackExecutor;
pub use ffmpeg::{FfmpegCapability, FfmpegPack};
pub use ftp::{FtpPack, FtpTarget};
pub use github::{GithubAsset, GithubPack, GithubRelease};
pub use http::{HttpPack, HttpProbeInfo};
pub use huggingface::{GitLfsPointer, HfModelTarget, HuggingFacePack};
pub use m3u8::{HlsMediaPlaylist, HlsSegment, HlsVariantStream, M3u8Pack};
pub use process::{configure_hidden_command, spawn_hidden};
pub use traits::{FeaturePack, PackProbeResult, PackTask};
pub use ytdlp::{MediaFormat, MediaMetadata, YtDlpPack};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum FeaturePackId {
    HttpPack,
    BitTorrentPack,
    FtpPack,
    Ed2kPack,
    M3u8Pack,
    FfmpegPack,
    YtDlpPack,
    GithubPack,
    HuggingFacePack,
}

impl FeaturePackId {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::HttpPack => "http_pack",
            Self::BitTorrentPack => "bittorrent_pack",
            Self::FtpPack => "ftp_pack",
            Self::Ed2kPack => "ed2k_pack",
            Self::M3u8Pack => "m3u8_pack",
            Self::FfmpegPack => "ffmpeg_pack",
            Self::YtDlpPack => "yt_dlp_pack",
            Self::GithubPack => "github_pack",
            Self::HuggingFacePack => "huggingface_pack",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FeaturePackStatus {
    pub id: String,
    pub name: String,
    pub version: String,
    pub active: bool,
    pub installed: bool,
    pub description: String,
    pub capabilities: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParsedPackTarget {
    pub pack_id: FeaturePackId,
    pub clean_url: String,
    pub suggested_filename: Option<String>,
    pub estimated_size: Option<u64>,
    pub is_stream: bool,
    pub is_p2p: bool,
}

pub struct FeaturePackManager;

impl FeaturePackManager {
    /// Return all 9 feature packs status and capability descriptors
    pub fn list_all_packs() -> Vec<FeaturePackStatus> {
        vec![
            FeaturePackStatus {
                id: "http_pack".to_string(),
                name: "HTTP / HTTPS Protocol Pack".to_string(),
                version: "1.0.0 (Native Rust Core)".to_string(),
                active: true,
                installed: true,
                description: "HTTP downloads, smart chunking, resumable transfers".to_string(),
                capabilities: vec![
                    "Dynamic Chunking".into(),
                    "Byte-Range Resumption".into(),
                    "TLS 1.3 / ALPN".into(),
                    "Adaptive Throttling".into(),
                ],
            },
            FeaturePackStatus {
                id: "bittorrent_pack".to_string(),
                name: "BitTorrent Swarm Pack".to_string(),
                version: "9.0.1 (Built-in librqbit)".to_string(),
                active: true,
                installed: true,
                description: "Native peer wire, DHT, and magnet swarm engine".to_string(),
                capabilities: vec![
                    "Magnet Link & .torrent Resolver".into(),
                    "DHT (Kademlia) & PEX Swarm".into(),
                    "uTP & TCP Peer Wire".into(),
                    "Sequential & Selective Fetch".into(),
                ],
            },
            FeaturePackStatus {
                id: "ftp_pack".to_string(),
                name: "FTP / FTPS Protocol Pack".to_string(),
                version: "1.0.0 (Built-in Rust)".to_string(),
                active: true,
                installed: true,
                description: "FTP file downloads".to_string(),
                capabilities: vec![
                    "PASV Mode Socket Transfer".into(),
                    "Anonymous & Authenticated".into(),
                    "Stream Resumption".into(),
                ],
            },
            FeaturePackStatus {
                id: "ed2k_pack".to_string(),
                name: "eDonkey2000 (eD2k) Pack (Experimental)".to_string(),
                version: "0.1.0 (Experimental)".to_string(),
                active: true,
                installed: true,
                description: "eD2k link parsing and chunk hash verification (Experimental)"
                    .to_string(),
                capabilities: vec![
                    "eD2k Link Parsing".into(),
                    "RFC 1320 MD4 Chunk Verification".into(),
                ],
            },
            FeaturePackStatus {
                id: "m3u8_pack".to_string(),
                name: "M3U8 / HLS Stream Pack".to_string(),
                version: "2.0.0 (Built-in Rust)".to_string(),
                active: true,
                installed: true,
                description: "In-process HLS segment fetching and native MP4 remuxing".to_string(),
                capabilities: vec![
                    "Concurrent TS & fMP4 Fetcher".into(),
                    "In-Process AES-128 Decryption".into(),
                    "Zero-FFmpeg Native Remuxing".into(),
                ],
            },
            FeaturePackStatus {
                id: "ffmpeg_pack".to_string(),
                name: "Native Media Remux Pack".to_string(),
                version: "1.0.0 (Built-in Rust)".to_string(),
                active: true,
                installed: true,
                description: "In-process container synthesis and stream concatenation".to_string(),
                capabilities: vec![
                    "In-Process Stream Remuxing".into(),
                    "Container Stitching (MP4/MKV)".into(),
                ],
            },
            FeaturePackStatus {
                id: "yt_dlp_pack".to_string(),
                name: "Media Site Extractor Pack".to_string(),
                version: "1.0.0 (Built-in Rust)".to_string(),
                active: true,
                installed: true,
                description: "In-process video & audio extraction for YouTube and Vimeo"
                    .to_string(),
                capabilities: vec![
                    "YouTube InnerTube In-Process".into(),
                    "Vimeo Config In-Process".into(),
                    "Adaptive Multi-Stream Merge".into(),
                ],
            },
            FeaturePackStatus {
                id: "github_pack".to_string(),
                name: "GitHub Releases & Accelerators Pack".to_string(),
                version: "1.1.0 (Native Rust)".to_string(),
                active: true,
                installed: true,
                description: "GitHub releases and accelerated mirror downloads".to_string(),
                capabilities: vec![
                    "Release Tag Resolution".into(),
                    "Fast CDN Mirror Routing".into(),
                    "Asset Checksum Auto-Verify".into(),
                ],
            },
            FeaturePackStatus {
                id: "huggingface_pack".to_string(),
                name: "Hugging Face Models & Dataset Pack".to_string(),
                version: "1.0.1 (Native Rust)".to_string(),
                active: true,
                installed: true,
                description: "Hugging Face model and file downloads".to_string(),
                capabilities: vec![
                    "Git-LFS Pointer Resolution".into(),
                    "Safetensors & GGUF Shards".into(),
                    "HF Auth Token Support".into(),
                ],
            },
        ]
    }

    /// Automatically classify and route an incoming target URL
    pub fn classify_target(input: &str) -> ParsedPackTarget {
        let trimmed = input.trim();
        let lower = trimmed.to_ascii_lowercase();

        // 1. BitTorrent Magnet
        if lower.starts_with("magnet:") {
            let suggested_name = BitTorrentPack::parse_magnet(trimmed)
                .ok()
                .and_then(|m| m.display_name);
            return ParsedPackTarget {
                pack_id: FeaturePackId::BitTorrentPack,
                clean_url: trimmed.to_string(),
                suggested_filename: suggested_name,
                estimated_size: None,
                is_stream: false,
                is_p2p: true,
            };
        }

        // 2. eDonkey2000
        if lower.starts_with("ed2k://") {
            let info = Ed2kPack::parse_link(trimmed).ok();
            return ParsedPackTarget {
                pack_id: FeaturePackId::Ed2kPack,
                clean_url: trimmed.to_string(),
                suggested_filename: info.as_ref().map(|i| i.name.clone()),
                estimated_size: info.as_ref().map(|i| i.size),
                is_stream: false,
                is_p2p: true,
            };
        }

        // 3. FTP / FTPS
        if lower.starts_with("ftp://") || lower.starts_with("ftps://") {
            let filename = trimmed.split('/').next_back().map(|s| s.to_string());
            return ParsedPackTarget {
                pack_id: FeaturePackId::FtpPack,
                clean_url: trimmed.to_string(),
                suggested_filename: filename,
                estimated_size: None,
                is_stream: false,
                is_p2p: false,
            };
        }

        // 4. M3U8 / HLS Stream
        if lower.contains(".m3u8") || lower.contains("/hls/") {
            return ParsedPackTarget {
                pack_id: FeaturePackId::M3u8Pack,
                clean_url: trimmed.to_string(),
                suggested_filename: Some("stream_recording.mp4".to_string()),
                estimated_size: None,
                is_stream: true,
                is_p2p: false,
            };
        }

        // 5. Hugging Face Models
        if lower.contains("huggingface.co/") || lower.contains("hf.co/") {
            let target = HuggingFacePack::parse_target(trimmed);
            let fname = target
                .as_ref()
                .and_then(|t| t.file_path.split('/').next_back().map(|s| s.to_string()));
            return ParsedPackTarget {
                pack_id: FeaturePackId::HuggingFacePack,
                clean_url: trimmed.to_string(),
                suggested_filename: fname,
                estimated_size: None,
                is_stream: false,
                is_p2p: false,
            };
        }

        // 6. GitHub Releases
        if lower.contains("github.com/")
            && (lower.contains("/releases/")
                || lower.contains("/archive/")
                || lower.contains("/raw/"))
        {
            let fname = trimmed
                .split('/')
                .next_back()
                .map(|s| s.split('?').next().unwrap_or(s).to_string());
            return ParsedPackTarget {
                pack_id: FeaturePackId::GithubPack,
                clean_url: trimmed.to_string(),
                suggested_filename: fname,
                estimated_size: None,
                is_stream: false,
                is_p2p: false,
            };
        }

        // 7. Video Extraction (yt-dlp)
        let video_domains = [
            "youtube.com",
            "youtu.be",
            "twitter.com",
            "x.com",
            "instagram.com",
            "tiktok.com",
            "twitch.tv",
            "bilibili.com",
            "vimeo.com",
        ];
        if video_domains.iter().any(|d| lower.contains(d)) {
            return ParsedPackTarget {
                pack_id: FeaturePackId::YtDlpPack,
                clean_url: trimmed.to_string(),
                suggested_filename: Some("Media_Stream.mp4".to_string()),
                estimated_size: None,
                is_stream: true,
                is_p2p: false,
            };
        }

        // 8. Default: HTTP Core
        let fname = trimmed
            .split('/')
            .next_back()
            .map(|s| s.split('?').next().unwrap_or(s).to_string());
        ParsedPackTarget {
            pack_id: FeaturePackId::HttpPack,
            clean_url: trimmed.to_string(),
            suggested_filename: fname,
            estimated_size: None,
            is_stream: false,
            is_p2p: false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_http_chunk_ranges() {
        let ranges = HttpPack::calculate_chunk_ranges(1000, 4);
        assert_eq!(ranges.len(), 4);
        assert_eq!(ranges[0], (0, 249));
        assert_eq!(ranges[3], (750, 999));
    }

    #[test]
    fn test_bittorrent_magnet_and_bencode() {
        let uri = "magnet:?xt=urn:btih:d6b67bc5c378546114eb3b5d263b88b488667520&dn=Ubuntu.iso&tr=http%3A%2F%2Ftracker.example.com%2Fannounce";
        let info = BitTorrentPack::parse_magnet(uri).unwrap();
        assert_eq!(info.display_name.as_deref(), Some("Ubuntu.iso"));
        assert_eq!(
            info.info_hash_hex,
            "d6b67bc5c378546114eb3b5d263b88b488667520"
        );
        assert_eq!(info.trackers.len(), 1);

        // Test Bencode decoding
        let bencode_data = b"d4:spami42e3:egg5:worlde";
        let decoded = BitTorrentPack::decode_bencode(bencode_data).unwrap();
        match decoded {
            BencodeValue::Dict(d) => {
                assert_eq!(d.get(b"spam".as_ref()), Some(&BencodeValue::Integer(42)));
                assert_eq!(
                    d.get(b"egg".as_ref()),
                    Some(&BencodeValue::ByteString(b"world".to_vec()))
                );
            }
            _ => panic!("Expected dict"),
        }
    }

    #[test]
    fn test_ftp_url_and_pasv() {
        let target =
            FtpPack::parse_url("ftp://admin:secret@ftp.example.com:2121/pub/archive.tar.gz")
                .unwrap();
        assert_eq!(target.host, "ftp.example.com");
        assert_eq!(target.port, 2121);
        assert_eq!(target.user, "admin");
        assert_eq!(target.pass, "secret");

        let pasv = "227 Entering Passive Mode (192,168,1,50,195,80)";
        let (ip, port) = FtpPack::parse_pasv_response(pasv).unwrap();
        assert_eq!(ip, "192.168.1.50");
        assert_eq!(port, (195 << 8) | 80);
    }

    #[test]
    fn test_ed2k_link_and_md4() {
        let link = "ed2k://|file|sample_video.avi|12345678|a1b2c3d4e5f60718293a4b5c6d7e8f90|/";
        let info = Ed2kPack::parse_link(link).unwrap();
        assert_eq!(info.name, "sample_video.avi");
        assert_eq!(info.size, 12345678);
        assert_eq!(info.hash_hex, "a1b2c3d4e5f60718293a4b5c6d7e8f90");

        // Test pure Rust MD4 computation
        let hash = Ed2kPack::compute_ed2k_hash(b"The quick brown fox jumps over the lazy dog");
        assert_eq!(hash.len(), 32);
    }

    #[test]
    fn test_hls_m3u8_parser() {
        let manifest = "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n#EXTINF:9.009,\nsegment0.ts\n#EXTINF:9.009,\nsegment1.ts\n#EXT-X-ENDLIST\n";
        let playlist =
            M3u8Pack::parse_media_playlist(manifest, "https://example.com/hls/video.m3u8").unwrap();
        assert_eq!(playlist.segments.len(), 2);
        assert_eq!(
            playlist.segments[0].url,
            "https://example.com/hls/segment0.ts"
        );
        assert!(playlist.is_endlist);
    }

    #[test]
    fn test_native_hls_aes128_decryption() {
        use aes::cipher::{block_padding::Pkcs7, BlockModeEncrypt, KeyIvInit};
        type Aes128CbcEnc = cbc::Encryptor<aes::Aes128>;

        let key: [u8; 16] = [0x11; 16];
        let iv: [u8; 16] = [0x22; 16];
        let plaintext = b"EDM Native AES-128 Decrypted Video Transport Stream Segment Chunk Data!";

        let mut buf = [0u8; 96];
        buf[..plaintext.len()].copy_from_slice(plaintext);
        let encryptor = Aes128CbcEnc::new(&key.into(), &iv.into());
        let ciphertext = encryptor
            .encrypt_padded::<Pkcs7>(&mut buf, plaintext.len())
            .unwrap();

        let decrypted = remux::decrypt_aes128_segment(ciphertext, &key, &iv).unwrap();
        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn test_github_pack_routing() {
        let (owner, repo) =
            GithubPack::parse_repo("https://github.com/rust-lang/cargo/releases/tag/0.80.0")
                .unwrap();
        assert_eq!(owner, "rust-lang");
        assert_eq!(repo, "cargo");

        let accelerated = GithubPack::accelerate_url(
            "https://github.com/rust-lang/cargo/releases/download/0.80.0/cargo.tar.gz",
            "ghproxy",
        );
        assert!(accelerated.starts_with("https://ghproxy.net/"));
    }

    #[test]
    fn test_huggingface_pack_routing() {
        let target = HuggingFacePack::parse_target(
            "https://huggingface.co/meta-llama/Llama-3-8B/resolve/main/model.safetensors",
        )
        .unwrap();
        assert_eq!(target.repo_id, "meta-llama/Llama-3-8B");
        assert_eq!(target.revision, "main");
        assert_eq!(target.file_path, "model.safetensors");
        assert_eq!(
            target.mirror_url,
            "https://hf-mirror.com/meta-llama/Llama-3-8B/resolve/main/model.safetensors"
        );
    }
}
