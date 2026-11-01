const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const root = __dirname;
const distChromium = path.join(root, 'dist', 'chromium');
const distFirefox = path.join(root, 'dist', 'firefox');
const tempDir = path.join(root, 'dist', 'temp');

// Ensure clean dist folders
fs.rmSync(path.join(root, 'dist'), { recursive: true, force: true });
fs.mkdirSync(distChromium, { recursive: true });
fs.mkdirSync(distFirefox, { recursive: true });
fs.mkdirSync(tempDir, { recursive: true });

console.log('[EDM] Transpiling extension scripts with esbuild...');
try {
  let esbuild;
  try {
    esbuild = require('esbuild');
  } catch (_e) {
    esbuild = require('../apps/desktop/node_modules/esbuild');
  }
  esbuild.buildSync({
    entryPoints: [
      path.join(root, 'src', 'background.ts'),
      path.join(root, 'src', 'content.ts'),
      path.join(root, 'src', 'popup.ts'),
      path.join(root, 'src', 'options.ts')
    ],
    outdir: tempDir,
    target: 'es2020',
    bundle: false
  });
  console.log('[EDM] esbuild transpile successful.');
} catch (e) {
  console.error('[EDM] esbuild failed:', e);
  process.exit(1);
}

// 1. Copy assets to Chromium (dist/chromium)
fs.copyFileSync(path.join(root, 'manifest.chromium.json'), path.join(distChromium, 'manifest.json'));
fs.copyFileSync(path.join(root, 'src', 'popup.html'), path.join(distChromium, 'popup.html'));
fs.copyFileSync(path.join(root, 'src', 'popup.css'), path.join(distChromium, 'popup.css'));
if (fs.existsSync(path.join(root, 'src', 'options.html'))) {
  fs.copyFileSync(path.join(root, 'src', 'options.html'), path.join(distChromium, 'options.html'));
}
if (fs.existsSync(path.join(root, 'src', 'logo.png'))) {
  fs.copyFileSync(path.join(root, 'src', 'logo.png'), path.join(distChromium, 'logo.png'));
}

if (fs.existsSync(path.join(tempDir, 'background.js'))) {
  fs.copyFileSync(path.join(tempDir, 'background.js'), path.join(distChromium, 'background.js'));
}
if (fs.existsSync(path.join(tempDir, 'content.js'))) {
  fs.copyFileSync(path.join(tempDir, 'content.js'), path.join(distChromium, 'content.js'));
}
if (fs.existsSync(path.join(tempDir, 'popup.js'))) {
  fs.copyFileSync(path.join(tempDir, 'popup.js'), path.join(distChromium, 'popup.js'));
}
if (fs.existsSync(path.join(tempDir, 'options.js'))) {
  fs.copyFileSync(path.join(tempDir, 'options.js'), path.join(distChromium, 'options.js'));
}

// 2. Also copy assets directly to root extension/ folder so loading `extension` directly works out-of-the-box
fs.copyFileSync(path.join(root, 'manifest.chromium.json'), path.join(root, 'manifest.json'));
fs.copyFileSync(path.join(root, 'src', 'popup.html'), path.join(root, 'popup.html'));
fs.copyFileSync(path.join(root, 'src', 'popup.css'), path.join(root, 'popup.css'));
if (fs.existsSync(path.join(root, 'src', 'options.html'))) {
  fs.copyFileSync(path.join(root, 'src', 'options.html'), path.join(root, 'options.html'));
}
if (fs.existsSync(path.join(root, 'src', 'logo.png'))) {
  fs.copyFileSync(path.join(root, 'src', 'logo.png'), path.join(root, 'logo.png'));
}
if (fs.existsSync(path.join(tempDir, 'background.js'))) {
  fs.copyFileSync(path.join(tempDir, 'background.js'), path.join(root, 'background.js'));
}
if (fs.existsSync(path.join(tempDir, 'content.js'))) {
  fs.copyFileSync(path.join(tempDir, 'content.js'), path.join(root, 'content.js'));
}
if (fs.existsSync(path.join(tempDir, 'popup.js'))) {
  fs.copyFileSync(path.join(tempDir, 'popup.js'), path.join(root, 'popup.js'));
}
if (fs.existsSync(path.join(tempDir, 'options.js'))) {
  fs.copyFileSync(path.join(tempDir, 'options.js'), path.join(root, 'options.js'));
}

// 3. Copy assets to Firefox (dist/firefox)
fs.copyFileSync(path.join(root, 'manifest.firefox.json'), path.join(distFirefox, 'manifest.json'));
fs.copyFileSync(path.join(root, 'src', 'popup.html'), path.join(distFirefox, 'popup.html'));
fs.copyFileSync(path.join(root, 'src', 'popup.css'), path.join(distFirefox, 'popup.css'));
if (fs.existsSync(path.join(root, 'src', 'options.html'))) {
  fs.copyFileSync(path.join(root, 'src', 'options.html'), path.join(distFirefox, 'options.html'));
}
if (fs.existsSync(path.join(root, 'src', 'logo.png'))) {
  fs.copyFileSync(path.join(root, 'src', 'logo.png'), path.join(distFirefox, 'logo.png'));
}

if (fs.existsSync(path.join(tempDir, 'background.js'))) {
  fs.copyFileSync(path.join(tempDir, 'background.js'), path.join(distFirefox, 'background.js'));
}
if (fs.existsSync(path.join(tempDir, 'content.js'))) {
  fs.copyFileSync(path.join(tempDir, 'content.js'), path.join(distFirefox, 'content.js'));
}
if (fs.existsSync(path.join(tempDir, 'popup.js'))) {
  fs.copyFileSync(path.join(tempDir, 'popup.js'), path.join(distFirefox, 'popup.js'));
}
if (fs.existsSync(path.join(tempDir, 'options.js'))) {
  fs.copyFileSync(path.join(tempDir, 'options.js'), path.join(distFirefox, 'options.js'));
}
if (fs.existsSync(path.join(root, 'updates.json'))) {
  fs.copyFileSync(path.join(root, 'updates.json'), path.join(distFirefox, 'updates.json'));
}

// 4. Generate SHA-256 integrity hash list (shipped in installer for verification)
const manifestData = JSON.parse(fs.readFileSync(path.join(distChromium, 'manifest.json'), 'utf8'));
const filesToHash = [
  'manifest.json',
  'background.js',
  'content.js',
  'popup.html',
  'popup.css',
  'popup.js',
  'options.html',
  'options.js',
  'logo.png'
];

const hashes = {
  version: manifestData.version || '0.0.6',
  generated_at: new Date().toISOString(),
  files: {}
};

for (const file of filesToHash) {
  const filePath = path.join(distChromium, file);
  if (fs.existsSync(filePath)) {
    const fileBuf = fs.readFileSync(filePath);
    const hashHex = crypto.createHash('sha256').update(fileBuf).digest('hex');
    hashes.files[file] = `sha256:${hashHex}`;
  }
}

const hashesJson = JSON.stringify(hashes, null, 2);
fs.writeFileSync(path.join(distChromium, 'hashes.json'), hashesJson);
fs.writeFileSync(path.join(root, 'hashes.json'), hashesJson);

// Clean up temp
fs.rmSync(tempDir, { recursive: true, force: true });
console.log(`[EDM] Extension built successfully! Computed hashes for ${Object.keys(hashes.files).length} files.`);
