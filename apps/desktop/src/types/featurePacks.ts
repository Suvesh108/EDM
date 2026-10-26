export type FeaturePackId =
  | "http_pack"
  | "bittorrent_pack"
  | "ftp_pack"
  | "ed2k_pack"
  | "m3u8_pack"
  | "ffmpeg_pack"
  | "yt_dlp_pack"
  | "github_pack"
  | "huggingface_pack";

export interface FeaturePackMeta {
  id: FeaturePackId;
  name: string;
  category: "core" | "p2p" | "media" | "mirrors" | "network";
  version: string;
  description: string;
  details: string;
  status: "core" | "ready" | "installed" | "available";
  protocols: string[];
  capabilities: string[];
  isCore: boolean;
  author: string;
  badge: string;
  color: string;
  requiresPack?: FeaturePackId;
}

export const FEATURE_PACKS: FeaturePackMeta[] = [
  {
    id: "http_pack",
    name: "HTTP / HTTPS Protocol Pack",
    category: "core",
    version: "1.0.0 (Core)",
    description: "HTTP downloads, smart chunking, resumable transfers",
    details: "High-performance byte-range multi-stream engine with dynamic chunk balancing, adaptive speed scheduler, and transient network error recovery.",
    protocols: ["http://", "https://"],
    capabilities: ["Dynamic Chunking", "Byte-Range Resumption", "TLS 1.3 / ALPN", "Adaptive Throttling"],
    isCore: true,
    author: "EDM Core Team",
    badge: "CORE ENGINE",
    color: "#3B82F6",
    status: "core",
  },
  {
    id: "bittorrent_pack",
    name: "BitTorrent & Magnet Pack",
    category: "p2p",
    version: "0.9.4",
    description: "Magnet links, torrents, peers, trackers and seeding",
    details: "Distributed P2P torrent client powered by libtorrent/librqbit bindings with DHT trackerless discovery, uTP, peer exchange (PEX), piece verification, and configurable seeding ratios.",
    protocols: ["magnet:?xt=", ".torrent", "urn:btih:"],
    capabilities: ["Magnet Link Resolver", "DHT Kademlia", "PEX (Peer Exchange)", "Seed Queue Control", "Multi-file Priority"],
    isCore: false,
    author: "EDM P2P Protocol Group",
    badge: "P2P TORRENT",
    color: "#10B981",
    status: "ready",
  },
  {
    id: "ftp_pack",
    name: "FTP / FTPS Protocol Pack",
    category: "network",
    version: "1.0.0",
    description: "FTP file downloads",
    details: "Standard and secure File Transfer Protocol client supporting active/passive modes, TLS encryption, segmented multi-connection transfers, and remote directory navigation.",
    protocols: ["ftp://", "ftps://"],
    capabilities: ["PASV & Active Modes", "Implicit/Explicit FTPS", "REST Resumption", "Chunked File Retrieval"],
    isCore: false,
    author: "EDM Network Protocol Group",
    badge: "FTP / FTPS",
    color: "#F59E0B",
    status: "ready",
  },
  {
    id: "ed2k_pack",
    name: "eDonkey2000 (eD2k) Pack",
    category: "p2p",
    version: "0.5.2",
    description: "eD2k/P2P downloads and peer discovery",
    details: "Peer-to-peer eD2k network client supporting hashset verification, Kad (Kademlia) decentralized routing, peer sources discovery, and anti-corruption part hashing.",
    protocols: ["ed2k://"],
    capabilities: ["Kad DHT Search", "ICH Corruption Handling", "AICH Part Hashing", "Peer Queue System"],
    isCore: false,
    author: "EDM P2P Protocol Group",
    badge: "eD2k P2P",
    color: "#8B5CF6",
    status: "ready",
  },
  {
    id: "m3u8_pack",
    name: "M3U8 / HLS Stream Pack",
    category: "media",
    version: "1.2.0",
    description: "HLS playlist and video-stream downloads",
    details: "HTTP Live Streaming playlist parser and segment grabber. Concurrently downloads video/audio .ts chunk bursts with AES-128 key decryption and playlist auto-refresh.",
    protocols: [".m3u8", "application/x-mpegurl", "application/vnd.apple.mpegurl"],
    capabilities: ["Concurrent TS Segment Fetcher", "AES-128 Decryption", "Master Multi-Bitrate Selector", "Live Window Recording"],
    isCore: false,
    author: "EDM Media Stream Group",
    badge: "HLS / M3U8",
    color: "#06B6D4",
    status: "ready",
    requiresPack: "ffmpeg_pack",
  },
  {
    id: "ffmpeg_pack",
    name: "FFmpeg Media Toolchain Pack",
    category: "media",
    version: "7.1.0",
    description: "Media processing support for compatible workflows",
    details: "Native media processor engine. Transmuxes raw HLS transport streams into MP4/MKV without re-encoding, stitches separate video/audio tracks, extracts audio, and embeds subtitles.",
    protocols: ["internal:media_mux", "internal:transcode"],
    capabilities: ["Fast Stream Copy Muxing", "Audio Track Demuxing", "Hardware Acceleration (NVENC/QSV)", "Container Repackaging"],
    isCore: false,
    author: "FFmpeg Project Integration",
    badge: "MEDIA PIPELINE",
    color: "#EC4899",
    status: "ready",
  },
  {
    id: "yt_dlp_pack",
    name: "yt-dlp Video & Audio Extractor Pack",
    category: "media",
    version: "2026.02.01",
    description: "YouTube and supported-site video/audio extraction",
    details: "Universal online video engine supporting 1,000+ streaming sites (YouTube, Bilibili, Twitter/X, TikTok, Instagram, Twitch, Vimeo). Extracts best quality video/audio streams, subtitles, and metadata.",
    protocols: ["youtube.com", "youtu.be", "twitter.com", "x.com", "instagram.com", "tiktok.com", "twitch.tv", "bilibili.com", "vimeo.com"],
    capabilities: ["1,000+ Site Extractors", "4K/8K HDR Stream Resolution", "Subtitles & Thumbnails", "Audio Only MP3/FLAC Extraction"],
    isCore: false,
    author: "yt-dlp Community Integration",
    badge: "STREAM EXTRACTOR",
    color: "#EF4444",
    status: "ready",
    requiresPack: "ffmpeg_pack",
  },
  {
    id: "github_pack",
    name: "GitHub Releases & Accelerators Pack",
    category: "mirrors",
    version: "1.1.0",
    description: "GitHub releases and accelerated mirror downloads",
    details: "Specialized accelerator for GitHub repository releases, source code tarballs, and raw assets. Automatically resolves global CDN mirrors and proxy nodes for maximum throughput in throttled regions.",
    protocols: ["github.com", "raw.githubusercontent.com"],
    capabilities: ["Release Tag Resolution", "Fast CDN Mirror Routing", "Asset Checksum Auto-Verify", "Token Rate-Limit Bypass"],
    isCore: false,
    author: "EDM Mirror Acceleration Team",
    badge: "GITHUB ACCELERATOR",
    color: "#64748B",
    status: "ready",
  },
  {
    id: "huggingface_pack",
    name: "Hugging Face Models & Dataset Pack",
    category: "mirrors",
    version: "1.0.1",
    description: "Hugging Face model and file downloads",
    details: "Optimized loader for AI weights, Safetensors, GGUF models, and Hugging Face repositories. Multi-stream chunking for gigabyte LFS pointers with authenticated token support.",
    protocols: ["huggingface.co", "hf.co"],
    capabilities: ["Git-LFS Pointer Resolution", "Safetensors & GGUF Shard Downloader", "HF Auth Token Support", "Repo Revision Branching"],
    isCore: false,
    author: "EDM AI Infrastructure Group",
    badge: "AI MODEL LOADER",
    color: "#EAB308",
    status: "ready",
  },
];

export interface DetectedPackResult {
  packId: FeaturePackId;
  meta: FeaturePackMeta;
  suggestedName?: string;
  isMirrorEligible?: boolean;
  mirrorProviders?: { id: string; name: string; urlTemplate: string }[];
}

export function detectProtocolPack(url: string): DetectedPackResult {
  const cleanUrl = url.trim().toLowerCase();

  // 1. BitTorrent Magnet or Torrent
  if (cleanUrl.startsWith("magnet:") || cleanUrl.includes(".torrent")) {
    return {
      packId: "bittorrent_pack",
      meta: FEATURE_PACKS.find((p) => p.id === "bittorrent_pack")!,
      suggestedName: cleanUrl.startsWith("magnet:")
        ? decodeURIComponent(cleanUrl.split("dn=")[1]?.split("&")[0] || "Torrent Task")
        : undefined,
    };
  }

  // 2. eDonkey2000
  if (cleanUrl.startsWith("ed2k://")) {
    const parts = url.trim().split("|");
    const ed2kName = parts.length > 2 ? decodeURIComponent(parts[2]) : "eD2k File";
    return {
      packId: "ed2k_pack",
      meta: FEATURE_PACKS.find((p) => p.id === "ed2k_pack")!,
      suggestedName: ed2kName,
    };
  }

  // 3. FTP / FTPS
  if (cleanUrl.startsWith("ftp://") || cleanUrl.startsWith("ftps://")) {
    return {
      packId: "ftp_pack",
      meta: FEATURE_PACKS.find((p) => p.id === "ftp_pack")!,
    };
  }

  // 4. M3U8 / HLS Stream
  if (cleanUrl.includes(".m3u8") || cleanUrl.includes("/hls/")) {
    return {
      packId: "m3u8_pack",
      meta: FEATURE_PACKS.find((p) => p.id === "m3u8_pack")!,
    };
  }

  // 5. Hugging Face
  if (cleanUrl.includes("huggingface.co/") || cleanUrl.includes("hf.co/")) {
    return {
      packId: "huggingface_pack",
      meta: FEATURE_PACKS.find((p) => p.id === "huggingface_pack")!,
      isMirrorEligible: true,
      mirrorProviders: [
        { id: "direct", name: "Hugging Face Direct (Global CDN)", urlTemplate: url },
        { id: "hf_mirror", name: "HF-Mirror Cloudflare Accelerated", urlTemplate: url.replace("huggingface.co", "hf-mirror.com") },
      ],
    };
  }

  // 6. GitHub Releases & Raw
  if (cleanUrl.includes("github.com/") && (cleanUrl.includes("/releases/") || cleanUrl.includes("/archive/") || cleanUrl.includes("/raw/"))) {
    return {
      packId: "github_pack",
      meta: FEATURE_PACKS.find((p) => p.id === "github_pack")!,
      isMirrorEligible: true,
      mirrorProviders: [
        { id: "direct", name: "GitHub Direct Official", urlTemplate: url },
        { id: "ghproxy", name: "GhProxy CDN Accelerator", urlTemplate: `https://ghproxy.net/${url}` },
        { id: "kgithub", name: "kGitHub Edge Mirror", urlTemplate: url.replace("github.com", "kgithub.com") },
      ],
    };
  }

  // 7. Video Extraction (yt-dlp)
  const videoHosts = ["youtube.com", "youtu.be", "twitter.com", "x.com", "instagram.com", "tiktok.com", "twitch.tv", "bilibili.com", "vimeo.com"];
  if (videoHosts.some((vh) => cleanUrl.includes(vh))) {
    return {
      packId: "yt_dlp_pack",
      meta: FEATURE_PACKS.find((p) => p.id === "yt_dlp_pack")!,
    };
  }

  // 8. Default to HTTP Pack (Core Engine)
  return {
    packId: "http_pack",
    meta: FEATURE_PACKS.find((p) => p.id === "http_pack")!,
  };
}
