import { Filesystem, Directory } from '@capacitor/filesystem';
import { registerPlugin, Capacitor } from '@capacitor/core';

export const APP_VERSION = 'v0.6.9';

export interface UpdateProgressData {
  percent: number;
  downloadedMB: string;
  totalMB?: string;
  speed?: string;
  statusText: string;
}

interface AppUpdaterPlugin {
  downloadAndInstall(options: { url: string }): Promise<{ success: boolean; filePath?: string }>;
  installApk(options: { filePath: string }): Promise<{ success: boolean; message?: string }>;
  addListener(
    eventName: 'updateProgress',
    listenerFunc: (data: { percent: number; downloadedBytes: number; totalBytes: number }) => void
  ): Promise<{ remove: () => void }>;
}

export const AppUpdater = registerPlugin<AppUpdaterPlugin>('AppUpdater');

export interface ReleaseAsset {
  name: string;
  size: number;
  downloadUrl: string;
  type: 'exe' | 'apk' | 'zip' | 'other';
}

export interface UpdateInfo {
  hasUpdate: boolean;
  currentVersion: string;
  latestVersion: string;
  releaseName: string;
  releaseNotes: string;
  apkDownloadUrl?: string;
  exeDownloadUrl?: string;
  zipDownloadUrl?: string;
  releaseUrl: string;
  publishedAt: string;
  assets: ReleaseAsset[];
}

function parseSemver(v: string): number[] {
  const clean = v.replace(/^v/i, '').split('-')[0].trim();
  return clean.split('.').map(p => parseInt(p, 10) || 0);
}

function isNewerVersion(latest: string, current: string): boolean {
  const l = parseSemver(latest);
  const c = parseSemver(current);
  const maxLen = Math.max(l.length, c.length);
  for (let i = 0; i < maxLen; i++) {
    const lPart = l[i] !== undefined ? l[i] : 0;
    const cPart = c[i] !== undefined ? c[i] : 0;
    if (lPart > cPart) return true;
    if (lPart < cPart) return false;
  }
  return false;
}

/**
 * Check GitHub repository releases for available updates (EXE, APK, ZIP)
 */
export async function checkForAppUpdates(): Promise<UpdateInfo> {
  const repoOwner = 'Suvesh108';
  const repoName = 'vortex';

  const res = await fetch(`https://api.github.com/repos/${repoOwner}/${repoName}/releases/latest`, {
    headers: {
      'Accept': 'application/vnd.github+json'
    }
  });

  if (!res.ok) {
    throw new Error(`Could not fetch release information (HTTP ${res.status})`);
  }

  const data = await res.json();
  const latestTag = data.tag_name || data.name || 'v0.5.4';
  const hasUpdate = isNewerVersion(latestTag, APP_VERSION);

  // Extract all assets
  const rawAssets = Array.isArray(data.assets) ? data.assets : [];
  const assets: ReleaseAsset[] = rawAssets.map((a: any) => {
    const nameLower = (a.name || '').toLowerCase();
    let type: ReleaseAsset['type'] = 'other';
    if (nameLower.endsWith('.exe') || nameLower.endsWith('.msi')) type = 'exe';
    else if (nameLower.endsWith('.apk') || a.content_type === 'application/vnd.android.package-archive') type = 'apk';
    else if (nameLower.endsWith('.zip')) type = 'zip';

    return {
      name: a.name || 'Release Asset',
      size: a.size || 0,
      downloadUrl: a.browser_download_url,
      type
    };
  });

  // Find specific platform assets
  const apkAsset = assets.find(a => a.type === 'apk');
  const exeAsset = assets.find(a => a.type === 'exe');
  const zipAsset = assets.find(a => a.type === 'zip');

  return {
    hasUpdate,
    currentVersion: APP_VERSION,
    latestVersion: latestTag,
    releaseName: data.name || latestTag,
    releaseNotes: data.body || 'Performance improvements, IDM multi-segmented chunker, and bug fixes.',
    apkDownloadUrl: apkAsset?.downloadUrl,
    exeDownloadUrl: exeAsset?.downloadUrl,
    zipDownloadUrl: zipAsset?.downloadUrl,
    releaseUrl: data.html_url || `https://github.com/${repoOwner}/${repoName}/releases/latest`,
    publishedAt: data.published_at ? new Date(data.published_at).toLocaleDateString() : 'Recent',
    assets
  };
}

/**
 * Universal downloader for Windows EXE, Web Archives, and Android APK with live progress reporting
 */
export async function downloadUpdateFile(
  url: string,
  filename?: string,
  onProgress?: (data: UpdateProgressData) => void
): Promise<{ success: boolean; path?: string }> {
  if (Capacitor.isNativePlatform() && (url.endsWith('.apk') || filename?.endsWith('.apk'))) {
    return downloadAndInstallUpdate(url, onProgress);
  }

  // Web / Desktop download with live streaming progress
  onProgress?.({
    percent: 5,
    downloadedMB: '0.0',
    statusText: 'Connecting to release asset...'
  });

  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP error ${response.status}`);
    const total = Number(response.headers.get('Content-Length')) || 0;
    const totalMB = total > 0 ? (total / (1024 * 1024)).toFixed(1) : undefined;
    const reader = response.body?.getReader();

    if (!reader) {
      const blob = await response.blob();
      const blobUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = blobUrl;
      if (filename) link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(blobUrl);
      onProgress?.({ percent: 100, downloadedMB: 'Done', totalMB, statusText: 'Download Complete' });
      return { success: true };
    }

    let loaded = 0;
    const chunks: Uint8Array[] = [];
    let lastBytes = 0;
    let lastTime = Date.now();
    let speedStr = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        loaded += value.length;
        const now = Date.now();
        const dt = (now - lastTime) / 1000;
        if (dt >= 0.3) {
          const dBytes = loaded - lastBytes;
          speedStr = `${(dBytes / dt / (1024 * 1024)).toFixed(1)} MB/s`;
          lastBytes = loaded;
          lastTime = now;
        }
        const percent = total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 50;
        onProgress?.({
          percent,
          downloadedMB: (loaded / (1024 * 1024)).toFixed(1),
          totalMB,
          speed: speedStr,
          statusText: `Downloading: ${percent}%`
        });
      }
    }

    const blob = new Blob(chunks as BlobPart[]);
    const blobUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = blobUrl;
    if (filename) link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);
    onProgress?.({ percent: 100, downloadedMB: (loaded / (1024 * 1024)).toFixed(1), totalMB, statusText: 'Download Complete' });
    return { success: true };
  } catch (err: any) {
    // Fallback: direct window link
    const link = document.createElement('a');
    link.href = url;
    if (filename) link.download = filename;
    link.target = '_blank';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    onProgress?.({ percent: 100, downloadedMB: 'Done', statusText: 'Initiated download' });
    return { success: true };
  }
}

/**
 * Internal Android APK download and native PackageInstaller prompt
 */
export async function downloadAndInstallUpdate(
  apkUrl: string,
  onProgress?: (data: UpdateProgressData) => void
): Promise<{ success: boolean; path?: string }> {
  if (Capacitor.isNativePlatform()) {
    onProgress?.({
      percent: 0,
      downloadedMB: '0.0',
      statusText: 'Connecting to update server...'
    });

    let lastBytes = 0;
    let lastTime = Date.now();
    let speedStr = '';

    const handle = await AppUpdater.addListener('updateProgress', (data) => {
      const now = Date.now();
      const dt = (now - lastTime) / 1000;
      if (dt >= 0.3) {
        const dBytes = data.downloadedBytes - lastBytes;
        speedStr = `${(dBytes / dt / (1024 * 1024)).toFixed(1)} MB/s`;
        lastBytes = data.downloadedBytes;
        lastTime = now;
      }
      onProgress?.({
        percent: data.percent,
        downloadedMB: (data.downloadedBytes / (1024 * 1024)).toFixed(1),
        totalMB: data.totalBytes > 0 ? (data.totalBytes / (1024 * 1024)).toFixed(1) : undefined,
        speed: speedStr,
        statusText: data.percent >= 100 ? 'Launching Package Installer...' : `Downloading update (${data.percent}%)...`
      });
    });

    try {
      const res = await AppUpdater.downloadAndInstall({ url: apkUrl });
      onProgress?.({
        percent: 100,
        downloadedMB: 'Done',
        statusText: 'Package installer launched'
      });
      return res;
    } catch (nativeErr: any) {
      console.warn('Native update error:', nativeErr);
      window.open(apkUrl, '_system');
      onProgress?.({
        percent: 100,
        downloadedMB: 'Done',
        statusText: 'Opened in browser'
      });
      return { success: true };
    } finally {
      try {
        handle.remove();
      } catch (_) {}
    }
  } else {
    // Browser fallback
    return downloadUpdateFile(apkUrl, 'VortexDownloader-latest.apk', onProgress);
  }
}
