import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

async function getGitToken() {
  try {
    const creds = execSync('git credential fill', { 
      input: 'protocol=https\nhost=github.com\n\n',
      encoding: 'utf-8' 
    });
    const match = creds.match(/password=(.*)/);
    if (match) return match[1].trim();
  } catch (e) {
    console.error('Error fetching git credential:', e.message);
  }
  return process.env.GITHUB_TOKEN || '';
}

async function run() {
  const token = await getGitToken();
  if (!token) {
    console.error('No GitHub token found!');
    process.exit(1);
  }

  const owner = 'Suvesh108';
  const repo = 'vortex';
  const tag = process.argv[2] || 'v0.6.9';

  console.log(`Checking existing release for tag ${tag}...`);
  const headers = {
    'Accept': 'application/vnd.github+json',
    'Authorization': `Bearer ${token}`,
    'User-Agent': 'VortexDownloader-Release-Bot',
    'X-GitHub-Api-Version': '2022-11-28'
  };

  let release;
  const getRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases/tags/${tag}`, {
    headers
  });

  const releaseBody = `## 💻 VortexDownloader ${tag} - 100% Rust Engine & Monochrome UI Release

- 🖥️ **Windows Installer**: \`VortexDownloader-Setup-${tag}.exe\` (5.6 MB - Official Windows Setup wizard with Start Menu shortcut, Desktop icon, uninstaller, and URL protocol handler)
- 📱 **Android APK (Direct Install)**: \`VortexDownloader-${tag}.apk\`

✨ **What's New in ${tag}**:
- 🦀 **100% Pure Rust Native Engine**: Rebuilt from scratch in high-concurrency Rust with Tokio, Axum, Reqwest, and SQLite WAL persistence. Dropped binary installer size from 46MB to 5.6MB!
- 🎨 **Brand-New Monochrome UI/UX Design System**: Complete visual redesign adopting an obsidian dark palette (\`#09090b\` / \`#121214\`) with intentional semantic component colors (cyber cyan active downloads, emerald completion, amber pause states, and vibrant category tags).
- ⚡ **IDM-Grade Dynamic Half-Split Chunk Engine**: True dynamic work-stealing that cuts the largest remaining chunk in half at the midpoint when workers idle, eliminating connection tail latency.
- 🎯 **100% Mathematically Accurate Progress Telemetry**: Automated byte-range probing (\`Range: bytes=0-1\`), real payload accounting, and live Server-Sent Events (SSE) telemetry.
- ⚙️ **Comprehensive Settings & Automation Suite**:
  - Pre-allocated parallel threads (1–64) and dynamic Auto Speed Boost thread monitor.
  - 8 Automatic Category Sorting Rules (Video, Audio, Images, Subtitles, Documents, Archives, Programs, Other).
  - Windows Registry protocol & extension integration (\`vortex://\`, \`.torrent\`, \`.magnet\`, \`.ed2k\`, \`ftp://\`, \`.m3u8\`, \`.mpd\`).
  - Aria2 JSON-RPC 2.0 browser extension pairing with custom token support.
- 🧲 **Multi-Protocol & Host Extraction**: Native support for YouTube, TikTok, Vimeo, HLS/M3U8 streams, BitTorrent, and 16 direct host decoders.
`;

  if (getRes.status === 200) {
    release = await getRes.json();
    console.log(`Found existing release: ${release.name} (id: ${release.id})`);
    
    // Update release description
    console.log(`Updating release body for ${tag}...`);
    const updateRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases/${release.id}`, {
      method: 'PATCH',
      headers: {
        ...headers,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: `VortexDownloader ${tag}`,
        body: releaseBody
      })
    });
    if (updateRes.ok) {
      release = await updateRes.json();
      console.log(`Updated release body successfully.`);
    }
  } else {
    console.log(`Creating new release for ${tag}...`);
    const createRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases`, {
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        tag_name: tag,
        target_commitish: 'main',
        name: `VortexDownloader ${tag}`,
        body: releaseBody,
        draft: false,
        prerelease: false
      })
    });

    if (!createRes.ok) {
      const err = await createRes.text();
      throw new Error(`Failed to create release: ${createRes.status} ${err}`);
    }
    release = await createRes.json();
    console.log(`Created release id: ${release.id}`);
  }

  // Remove obsolete portable exe asset if present on the release
  const obsoleteAssets = ['VortexDownloader.exe'];
  for (const obsoleteName of obsoleteAssets) {
    const found = release.assets?.find(a => a.name === obsoleteName);
    if (found) {
      console.log(`Purging obsolete portable asset: ${obsoleteName} (${found.id})...`);
      const delRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases/assets/${found.id}`, {
        method: 'DELETE',
        headers
      });
      if (delRes.ok) {
        console.log(`Deleted obsolete asset: ${obsoleteName}`);
      } else {
        console.warn(`Failed to delete obsolete asset ${obsoleteName}: ${delRes.status}`);
      }
    }
  }

  // Release Assets to Upload
  const filesToUpload = [
    { 
      name: `VortexDownloader-Setup-${tag}.exe`, 
      path: `release/VortexDownloader-Setup-${tag}.exe`,
      contentType: 'application/octet-stream'
    },
    { 
      name: `VortexDownloader-${tag}.apk`, 
      path: `release/VortexDownloader-${tag}.apk`,
      contentType: 'application/vnd.android.package-archive'
    }
  ];

  for (const item of filesToUpload) {
    const filePath = path.resolve(item.path);
    if (!fs.existsSync(filePath)) {
      console.warn(`File not found: ${filePath}`);
      continue;
    }

    const fileBuffer = fs.readFileSync(filePath);
    const fileName = item.name;

    // Check if asset already exists on release
    const existingAsset = release.assets?.find(a => a.name === fileName);
    if (existingAsset) {
      console.log(`Deleting existing asset ${fileName} (${existingAsset.id})...`);
      const delRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases/assets/${existingAsset.id}`, {
        method: 'DELETE',
        headers
      });
      if (!delRes.ok) {
        console.warn(`Could not delete asset ${existingAsset.id}: ${delRes.status}`);
      }
    }

    console.log(`Uploading ${fileName} (${(fileBuffer.length / (1024 * 1024)).toFixed(2)} MB)...`);
    const uploadUrl = `https://uploads.github.com/repos/${owner}/${repo}/releases/${release.id}/assets?name=${encodeURIComponent(fileName)}`;

    const uploadRes = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': item.contentType,
        'Content-Length': fileBuffer.length.toString()
      },
      body: fileBuffer
    });

    if (!uploadRes.ok) {
      const err = await uploadRes.text();
      console.error(`Failed to upload ${fileName}:`, err);
    } else {
      const asset = await uploadRes.json();
      console.log(`Successfully uploaded ${fileName} -> ${asset.browser_download_url}`);
    }
  }

  console.log(`\n🎉 Release published and assets updated at: ${release.html_url}`);
}

run().catch(err => {
  console.error('Release failed:', err);
  process.exit(1);
});
