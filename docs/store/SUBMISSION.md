# EDM Extension Submission & Publishing Guide

This document outlines the step-by-step submission procedures for publishing the EDM browser extension across all major browser stores.

---

## 1. Artifacts Created by CI / Build

Running `node extension/build.js` generates:
1. `extension/dist/edm-extension-chromium.zip`:
   - Contains: `manifest.json` (Chromium Manifest V3), compiled `background.js`, `content.js`, `popup.js`, `options.js`, `popup.html`, `options.html`, `popup.css`, `logo.png`, `hashes.json`.
   - Used for **Chrome Web Store** and **Microsoft Edge Add-ons**.
2. `extension/dist/firefox/edm-firefox.xpi`:
   - Contains: Firefox Manifest V3 with `browser_specific_settings.gecko.id: "edm@suvesh.dev"`.
   - Signed as an unlisted add-on via Mozilla `web-ext sign` for direct distribution via GitHub Releases and the desktop app's built-in `/firefox.xpi` server.

---

## 2. Chrome Web Store Submission Steps

1. **Sign in to Chrome Developer Dashboard:**
   - URL: [https://chrome.google.com/webstore/devconsole](https://chrome.google.com/webstore/devconsole)
   - Ensure your developer account is active ($5 one-time registration fee paid).
2. **Upload Package:**
   - Click **Add new item**.
   - Upload `extension/dist/edm-extension-chromium.zip`.
3. **Store Listing Details:**
   - Copy description, short description, category, and language from `docs/store/LISTING.md`.
   - Upload 128x128 icon (`extension/src/logo.png`).
   - Upload at least 1 screenshot (1280x800) and the small promo tile (440x280).
4. **Privacy Practices Tab:**
   - **Single Purpose Description:** Enter the single-purpose statement from `docs/store/LISTING.md`.
   - **Permission Justifications:** Copy the exact 1-line justification for each permission from `docs/store/PERMISSIONS.md`.
   - **Data Usage:** Select "No" for collection of user personal data or analytics.
   - **Privacy Policy Link:** Paste `https://suvesh108.github.io/EDM/store/PRIVACY.html`.
5. **Submit for Review:**
   - Click **Submit for review**. Review typically takes 24–48 hours.

---

## 3. Microsoft Edge Add-ons Submission Steps

1. **Sign in to Microsoft Partner Center:**
   - URL: [https://partner.microsoft.com/dashboard/microsoftedge](https://partner.microsoft.com/dashboard/microsoftedge)
2. **Create New Extension:**
   - Click **Create new extension**.
   - Upload `extension/dist/edm-extension-chromium.zip` (Edge supports the identical Chromium zip).
3. **Store Listing:**
   - Fill in Title ("EDM — Edge Download Manager"), Short Description, and Full Description from `docs/store/LISTING.md`.
   - Upload screenshots and 128x128 icon.
4. **Properties & Certification Notes:**
   - Category: "Productivity"
   - Support URL: `https://github.com/Suvesh108/EDM`
   - Privacy Policy URL: `https://suvesh108.github.io/EDM/store/PRIVACY.html`
   - **Notes for Certification:** Mention that the extension requires the EDM Windows desktop application (link to GitHub Releases) to establish local loopback WebSocket communication.
5. **Publish:**
   - Click **Publish**. Review typically takes 1–3 business days.

---

## 4. Mozilla Firefox (AMO) Signing & Distribution

Because EDM connects to a local Windows Native Messaging Host and desktop application, it is signed as an **unlisted** extension or submitted for self-distribution:

1. **AMO API Keys:**
   - Obtain `JWT issuer` and `JWT secret` from [https://addons.mozilla.org/en-US/developers/addon/api/key/](https://addons.mozilla.org/en-US/developers/addon/api/key/).
   - Add them to GitHub repository secrets as `AMO_JWT_ISSUER` and `AMO_JWT_SECRET`.
2. **Automated Signing via CI:**
   - CI invokes:
     ```bash
     npx web-ext sign --source-dir extension/dist/firefox --api-key $AMO_JWT_ISSUER --api-secret $AMO_JWT_SECRET --channel unlisted
     ```
   - The signed `.xpi` is placed into `extension/dist/firefox/edm-firefox.xpi` and attached as an asset to GitHub Releases.
3. **In-App Direct Install:**
   - The EDM desktop app automatically serves this signed `.xpi` with MIME type `application/x-xpinstall` on `http://127.0.0.1:14370/firefox.xpi`.
   - When the user clicks "Add to Firefox" in the setup wizard, Firefox opens the URL and natively prompts the user to install the signed add-on.
