import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const require = createRequire(path.join(rootDir, "apps/desktop/package.json"));
const { chromium } = require("playwright");

function createStaticServer(baseDir) {
  return http.createServer((req, res) => {
    let safeUrl = req.url.split("?")[0];
    if (safeUrl === "/") safeUrl = "/index.html";
    const filePath = path.join(baseDir, safeUrl);

    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      res.writeHead(404);
      res.end("Not Found");
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes = {
      ".html": "text/html",
      ".js": "application/javascript",
      ".css": "text/css",
      ".png": "image/png",
      ".svg": "image/svg+xml",
      ".json": "application/json",
      ".woff2": "font/woff2",
      ".ico": "image/x-icon",
    };

    res.writeHead(200, {
      "Content-Type": mimeTypes[ext] || "application/octet-stream",
      "Access-Control-Allow-Origin": "*",
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

async function main() {
  console.log("[Playwright] Starting screenshot capture pipeline...");

  const desktopDist = path.join(rootDir, "apps/desktop/dist");
  const extensionDist = path.join(rootDir, "extension/dist/chromium");
  const assetsDir = path.join(rootDir, "assets");
  const screenshotsDir = path.join(assetsDir, "screenshots");

  if (!fs.existsSync(assetsDir)) {
    fs.mkdirSync(assetsDir, { recursive: true });
  }
  if (!fs.existsSync(screenshotsDir)) {
    fs.mkdirSync(screenshotsDir, { recursive: true });
  }

  const desktopServer = createStaticServer(desktopDist);
  const extServer = createStaticServer(extensionDist);

  await new Promise((resolve) => desktopServer.listen(15234, resolve));
  await new Promise((resolve) => extServer.listen(15235, resolve));
  console.log("[Playwright] Static servers listening on 15234 & 15235.");

  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
  });

  try {
    // -------------------------------------------------------------
    // 1. Desktop Application Main Dashboard
    // -------------------------------------------------------------
    console.log("[Playwright] Capturing desktop-main.png...");
    const desktopContext = await browser.newContext({
      viewport: { width: 1100, height: 720 },
      deviceScaleFactor: 2,
    });

    const desktopPage = await desktopContext.newPage();

    // Mock realistic downloads in localStorage
    const mockSpeedHistory = [];
    for (let i = 0; i < 60; i++) {
      const base = 22000000;
      const variation = Math.sin(i / 3.5) * 3500000 + (Math.sin(i / 1.5) * 800000);
      mockSpeedHistory.push(Math.round(base + variation));
    }

    const mockDownloads = [
      {
        id: "dl-1",
        name: "Ubuntu-24.04-desktop-amd64.iso",
        category: "Programs",
        sizeTotal: 4831838208,
        sizeDone: 2995739688,
        speed: "24.8 MB/s",
        eta: "1m 14s",
        connections: 8,
        state: "downloading",
        progress: 62,
        url: "https://releases.ubuntu.com/24.04/ubuntu-24.04-desktop-amd64.iso",
        domain: "releases.ubuntu.com",
        dateAdded: new Date(Date.now() - 360000).toISOString(),
        speedHistory: mockSpeedHistory,
        peakSpeedBps: 28400000,
        workers: [
          { idx: 1, start: 0, end: 603979776, pos: 603979776, speed: "3.1 MB/s", status: "Chunk verified • Complete" },
          { idx: 2, start: 603979776, end: 1207959552, pos: 1207959552, speed: "3.2 MB/s", status: "Chunk verified • Complete" },
          { idx: 3, start: 1207959552, end: 1811939328, pos: 1811939328, speed: "2.9 MB/s", status: "Chunk verified • Complete" },
          { idx: 4, start: 1811939328, end: 2415919104, pos: 2415919104, speed: "3.4 MB/s", status: "Chunk verified • Complete" },
          { idx: 5, start: 2415919104, end: 3019898880, pos: 2780000000, speed: "3.0 MB/s", status: "Receiving chunk (HTTP 206)..." },
          { idx: 6, start: 3019898880, end: 3623878656, pos: 3250000000, speed: "3.1 MB/s", status: "Receiving chunk (HTTP 206)..." },
          { idx: 7, start: 3623878656, end: 4227858432, pos: 3820000000, speed: "3.3 MB/s", status: "Receiving chunk (HTTP 206)..." },
          { idx: 8, start: 4227858432, end: 4831838208, pos: 4400000000, speed: "2.8 MB/s", status: "Receiving chunk (HTTP 206)..." },
        ],
      },
      {
        id: "dl-2",
        name: "Cyberpunk_Edgerunners_Trailer_4K.mp4",
        category: "Video",
        sizeTotal: 432013312,
        sizeDone: 432013312,
        speed: "0 B/s",
        eta: "Finished",
        connections: 8,
        state: "completed",
        progress: 100,
        url: "https://media.example.org/videos/cyberpunk_trailer_4k.mp4",
        domain: "media.example.org",
        dateAdded: new Date(Date.now() - 3600000).toISOString(),
      },
      {
        id: "dl-3",
        name: "Node.js-v22.14.0-x64.msi",
        category: "Programs",
        sizeTotal: 34185216,
        sizeDone: 34185216,
        speed: "0 B/s",
        eta: "Finished",
        connections: 4,
        state: "completed",
        progress: 100,
        url: "https://nodejs.org/dist/v22.14.0/node-v22.14.0-x64.msi",
        domain: "nodejs.org",
        dateAdded: new Date(Date.now() - 7200000).toISOString(),
      },
      {
        id: "dl-4",
        name: "deep-learning-dataset-2026.tar.gz",
        category: "Compressed",
        sizeTotal: 1887436800,
        sizeDone: 377487360,
        speed: "0 B/s",
        eta: "Paused",
        connections: 8,
        state: "paused",
        progress: 20,
        url: "https://data.example.org/archive/deep-learning-dataset-2026.tar.gz",
        domain: "data.example.org",
        dateAdded: new Date(Date.now() - 10800000).toISOString(),
      },
    ];

    await desktopPage.addInitScript((items) => {
      localStorage.setItem("edm_downloads_v1", JSON.stringify(items));
      localStorage.setItem("edm_theme_palette", "blue");
    }, mockDownloads);

    await desktopPage.goto("http://localhost:15234/");
    await desktopPage.waitForTimeout(600);

    // Click first item to select it
    const firstItemText = await desktopPage.$('text="Ubuntu-24.04-desktop-amd64.iso"');
    if (firstItemText) {
      await firstItemText.click();
      await desktopPage.waitForTimeout(300);
    }

    // Save Main Desktop view
    const mainPath = path.join(assetsDir, "desktop-main.png");
    const mainVersioned = path.join(screenshotsDir, "edm-desktop-dashboard-v0.0.5.png");
    await desktopPage.screenshot({ path: mainPath, fullPage: false });
    fs.copyFileSync(mainPath, mainVersioned);
    console.log("[Playwright] Saved assets/desktop-main.png and assets/screenshots/edm-desktop-dashboard-v0.0.5.png");

    // -------------------------------------------------------------
    // 2. Download Status & Segment Telemetry Inspector Modal
    // -------------------------------------------------------------
    console.log("[Playwright] Opening inspector modal for telemetry screenshot...");
    // Find 'View Segments' or double click the item
    const viewSegmentsBtn = await desktopPage.$('button:has-text("View Segments")');
    if (viewSegmentsBtn) {
      await viewSegmentsBtn.click();
    } else if (firstItemText) {
      await firstItemText.dblclick();
    }

    await desktopPage.waitForTimeout(800);

    // Select the modal element specifically
    const modalElement = await desktopPage.$('.panel-3d.w-full.max-w-2xl');
    const telePath = path.join(assetsDir, "download-telemetry.png");
    const teleVersioned = path.join(screenshotsDir, "edm-telemetry-inspector-v0.0.5.png");
    if (modalElement) {
      await modalElement.screenshot({ path: telePath });
    } else {
      await desktopPage.screenshot({ path: telePath });
    }
    fs.copyFileSync(telePath, teleVersioned);
    console.log("[Playwright] Saved assets/download-telemetry.png and assets/screenshots/edm-telemetry-inspector-v0.0.5.png");

    await desktopContext.close();

    // -------------------------------------------------------------
    // 3. Browser Extension Popup
    // -------------------------------------------------------------
    console.log("[Playwright] Capturing browser-extension.png...");
    const extContext = await browser.newContext({
      viewport: { width: 400, height: 330 },
      deviceScaleFactor: 2,
    });
    const extPage = await extContext.newPage();

    // Mock chrome.runtime and chrome.storage for extension popup
    await extPage.addInitScript(() => {
      const mockTasks = [
        {
          id: "task-ext-1",
          filename: "Forgotten.Island.2026.1080p.WEB-DL.mkv",
          status: "downloading",
          total: 2469606195,
          downloaded: 1258291200,
          speed: 8912896,
        },
        {
          id: "task-ext-2",
          filename: "Ubuntu-24.04-desktop-amd64.iso",
          status: "completed",
          total: 5043912704,
          downloaded: 5043912704,
          speed: 0,
        },
      ];

      window.chrome = {
        runtime: {
          connect: () => ({
            onMessage: {
              addListener: (cb) => {
                // Immediately emit snapshot
                setTimeout(() => {
                  cb({
                    type: "snapshot",
                    connectionStatus: "connected",
                    lifecycleState: "Active",
                    palette: "blue",
                    theme: "dark",
                    tasks: mockTasks,
                  });
                }, 40);
              },
            },
            onDisconnect: {
              addListener: () => {},
            },
            postMessage: () => {},
          }),
          sendMessage: (msg, cb) => {
            if (cb) cb({ success: true });
          },
          getManifest: () => ({ version: "0.0.5" }),
        },
        storage: {
          local: {
            get: (keys, cb) => {
              const res = {
                edm_settings: { interceptedExts: "zip,iso,exe,mp4,mkv,tar" },
                edm_token: "mock-token",
                edm_port: 14370,
              };
              if (cb) cb(res);
              return Promise.resolve(res);
            },
            set: (data, cb) => {
              if (cb) cb();
              return Promise.resolve();
            },
          },
        },
      };
    });

    await extPage.goto("http://localhost:15235/popup.html");
    await extPage.waitForSelector(".download-card", { timeout: 4000 });
    await extPage.waitForTimeout(600);

    const extPath = path.join(assetsDir, "browser-extension.png");
    const extVersioned = path.join(screenshotsDir, "edm-browser-extension-v0.0.5.png");
    await extPage.screenshot({ path: extPath });
    fs.copyFileSync(extPath, extVersioned);
    console.log("[Playwright] Saved assets/browser-extension.png and assets/screenshots/edm-browser-extension-v0.0.5.png");

    await extContext.close();
  } finally {
    await browser.close();
    desktopServer.close();
    extServer.close();
  }

  console.log("[Playwright] All fresh screenshots generated successfully!");
}

main().catch((err) => {
  console.error("[Playwright] Screenshot generation failed:", err);
  process.exit(1);
});
