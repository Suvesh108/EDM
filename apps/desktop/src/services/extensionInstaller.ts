import {
  tauriPrepareExtensionFiles,
  tauriGetExtensionFolderPath,
  tauriRemoveExtensionFolder,
  tauriOpenBrowserUrl,
  tauriDetectInstalledBrowsers,
} from "./tauriBridge";

export interface BrowserOption {
  id: "chrome" | "edge" | "brave";
  name: string;
  installed: boolean;
  extensionUrl: string;
}

export const EXTENSION_URLS: Record<string, string> = {
  chrome: "chrome://extensions",
  edge: "edge://extensions",
  brave: "brave://extensions",
};

/**
 * Copies the bundled browser extension to the permanent user folder.
 * Overwrites existing files and verifies that manifest.json exists in destination.
 */
export async function copyExtensionToUserFolder(): Promise<string> {
  const destPath = await tauriPrepareExtensionFiles();
  return destPath;
}

/**
 * Copies the destination folder path to system clipboard.
 */
export async function copyPathToClipboard(path: string): Promise<boolean> {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(path);
      return true;
    }
    // Fallback for document copy
    const textarea = document.createElement("textarea");
    textarea.value = path;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    const successful = document.execCommand("copy");
    document.body.removeChild(textarea);
    return successful;
  } catch (err) {
    console.warn("Failed to copy path to clipboard:", err);
    return false;
  }
}

/**
 * Detects which Chromium-based browsers are installed on the user machine.
 */
export async function detectInstalledChromiumBrowsers(): Promise<BrowserOption[]> {
  const detected = await tauriDetectInstalledBrowsers();
  const options: BrowserOption[] = [
    {
      id: "chrome",
      name: "Google Chrome",
      installed: false,
      extensionUrl: "chrome://extensions",
    },
    {
      id: "edge",
      name: "Microsoft Edge",
      installed: false,
      extensionUrl: "edge://extensions",
    },
    {
      id: "brave",
      name: "Brave Browser",
      installed: false,
      extensionUrl: "brave://extensions",
    },
  ];

  for (const b of detected) {
    const match = options.find((opt) => opt.id === b.id);
    if (match) {
      match.installed = Boolean(b.installed);
    }
  }

  // If none explicitly detected as true in browser list (or mock/fallback), default Chrome and Edge to available
  const hasAnyInstalled = options.some((o) => o.installed);
  if (!hasAnyInstalled) {
    options[0].installed = true;
    options[1].installed = true;
  }

  return options;
}

/**
 * Launches the selected browser directly to its internal extensions page.
 */
export async function openExtensionsPage(browserId: string): Promise<void> {
  const url = EXTENSION_URLS[browserId] || "chrome://extensions";
  await tauriOpenBrowserUrl(browserId, url);
}

/**
 * Runs the full preparation pipeline:
 * 1. Copies extension files to user folder & verifies manifest.json
 * 2. Copies path to clipboard
 * 3. Launches browser directly to extension URL
 */
export async function runExtensionInstallFlow(browserId: string): Promise<{
  success: boolean;
  folderPath: string;
  clipboardCopied: boolean;
  error?: string;
}> {
  try {
    const folderPath = await copyExtensionToUserFolder();
    const clipboardCopied = await copyPathToClipboard(folderPath);
    await openExtensionsPage(browserId);

    return {
      success: true,
      folderPath,
      clipboardCopied,
    };
  } catch (err: any) {
    return {
      success: false,
      folderPath: "",
      clipboardCopied: false,
      error: err?.message || String(err),
    };
  }
}

/**
 * Removes the copied extension directory from user folder.
 */
export async function cleanupExtensionFolder(): Promise<boolean> {
  return await tauriRemoveExtensionFolder();
}

/**
 * Retrieves the current extension folder path.
 */
export async function getExtensionPath(): Promise<string> {
  return await tauriGetExtensionFolderPath();
}
