# EDM Feature Quality Checklist

Use this checklist template for every new feature or major refactor implemented in EDM. All sections must be evaluated and documented before marking work as complete.

---

## 1. Feature Identification
- **Feature Name**:
- **Target Version**:
- **Tracking / Issue Reference**:

---

## 2. Setting and Default
- **Configuration Key**: (e.g. `settings.downloads.expiredLinkRecovery`)
- **Default Value**: (e.g. `true` / `false` / `"ask"`)
- **Off-Switch Behavior**: Verify that toggling this setting off completely disables background listeners and prevents side-effects without breaking any other subsystem.

---

## 3. Sleep Impact
- **Idle State Behavior**: Does this feature create timers, threads, or background I/O when downloads are idle?
- **Deep Sleep Blocking**: Does this feature prevent EDM from entering `listener_sleep` or deep sleep? If yes, provide the technical rationale.
- **Wake Compatibility**: Verify that incoming wake signals (`edm-nmh.exe`, `edm://`) function without delay.

---

## 4. Protocol Changes
- **IPC / WebSocket Additions**: List any new variants or fields added to `ExtensionMessage`, `AppReply`, `InboundWsMessage`, or `OutboundWsMessage`.
- **Field Optionality**: Confirm all new fields are optional (`#[serde(default)]` / `?`) to preserve forward and backward compatibility.
- **Protocol Version**: State whether `PROTOCOL_VERSION` was incremented and describe negotiation.

---

## 5. Extension & Firefox Impact
- **Chromium Impact**: State any new permissions, content scripts, or manifest modifications. Confirm stable `"key"` preserves extension ID.
- **Firefox Compatibility**: State any Gecko-specific differences, update URL changes, or API limitations (e.g. MV3 service workers vs event pages).
- **Graceful Degradation**: Verify that an older extension running against a newer desktop app (or vice versa) works without crashing.

---

## 6. Migration
- **SQLite Schema Changes**: Document table additions, columns, or indexes. Confirm forward-safe migrations using PRAGMA user_version.
- **Local Storage / Settings Migration**: Document schema upgrades in `localStorage` or `app_settings`. Confirm safe defaults on missing keys.

---

## 7. Tests
- **Automated Unit Tests**:
  - `cargo test -p <crate>`
- **Integration Tests with `edm-testsrv`**:
  - Test profile added / verified:
  - Command: `cargo test --test <integration_test>`
- **Full Verification Suite**:
  - `powershell -ExecutionPolicy Bypass -File scripts/verify-all.ps1` (Must pass with 0 errors, 0 warnings).

---

## 8. Manual Test Steps
Provide step-by-step instructions for what the human developer must manually verify on a clean system:
1. Step 1:
2. Step 2:
3. Step 3:

---

## 9. Docs and Changelog
- [ ] Updated `CHANGELOG.md` with user-facing description.
- [ ] Updated `docs/EDM_SPEC.md` if architectural contracts changed.
- [ ] Added or updated tooltips and settings descriptions in desktop UI and extension popup.
