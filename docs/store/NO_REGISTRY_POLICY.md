# Architectural Invariant: Why Registry External Extension Installation Is Strictly Prohibited

## Background
Historically, Windows applications could forcefully register browser extensions into Chromium-based browsers (Chrome, Edge, Brave) by creating registry keys under:
- `HKCU\Software\Google\Chrome\Extensions\<extension-id>`
- `HKLM\Software\Google\Chrome\Extensions\<extension-id>`
- `HKCU\Software\Microsoft\Edge\Extensions\<extension-id>`
- Group Policy `ExtensionInstallForcelist` / `ExtensionInstallSources`

**EDM strictly prohibits writing to any of these registry external extension keys or enterprise policy settings.**

---

## Technical & Security Reasons

### 1. Requires Administrator Elevation
Writing to `HKLM\Software\...` or Group Policy keys (`Software\Policies\...`) requires Administrator / UAC elevation. EDM is engineered to run in non-elevated user mode (`HKCU` only) with zero administrative dependencies.

### 2. Triggers "Installed by Enterprise Policy" & Antivirus Alerts
Modern versions of Google Chrome and Microsoft Edge treat external extension registry keys as suspicious enterprise or PUP (Potentially Unwanted Program) injections. When a third-party desktop installer writes to these keys:
- The browser displays alarming warnings: *"Your browser is managed by your organization"* or *"This extension was installed by a third party and disabled for your security"*.
- Microsoft Defender and third-party AV scanners flag the installer as malware due to behavioral heuristics.

### 3. Immediate Rejection & Takedown from Chrome Web Store & Edge Add-ons
Both Google and Microsoft developer policies explicitly prohibit desktop applications from silently or forcefully injecting store extensions into user profiles without the user explicitly clicking an "Install" or "Get" button inside the browser UI. Violations lead to immediate developer account suspension.

### 4. Blocked by `BlockExternalExtensions`
Starting in Chromium 25 and reinforced in Chromium 114+, the `BlockExternalExtensions` policy default disables all extensions installed through the Windows registry unless they originate from an Active Directory domain or enterprise MDM enrollment. On standard Windows consumer PCs, registry-injected extensions are either discarded or silently stripped on browser restart.

---

## The Sanctioned Path: Native One-Click Flow

EDM uses the sanctioned, user-respecting architecture:
1. **Registered Native Messaging Host:** EDM registers `com.edm.nmh` in `HKCU\Software\<Browser>\NativeMessagingHosts`, which is the official, documented Windows IPC mechanism.
2. **One-Click Store Prompt:** When the user clicks **"Add to <browser>"**, EDM launches the browser's own executable targeting the official Web Store / Add-ons store page (`https://microsoftedge.microsoft.com/addons/...` or `https://chromewebstore.google.com/...`).
3. **Native Consent Dialog:** The browser presents its own native, verified installation dialog. The user clicks "Add extension", and the browser installs it into their profile cleanly without any security flags.
4. **Resilient Handshake:** The EDM setup wizard and desktop app listen for the extension's loopback `hello` message. If the user cancels the prompt or closes the tab, EDM does not produce an error and the button remains available.
