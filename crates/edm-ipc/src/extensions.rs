//! Single source of truth for allowed extension IDs, origins, and browser configurations.
//! Used across Native Messaging manifests, WebSocket Origin verification, HTTP token handoff,
//! installer hooks, registry repair routines, and diagnostics.

pub const CHROMIUM_UNPACKED_ID: &str = "ginpdimhcdbojbhemgjedghkeolbcmgj";
pub const CHROME_WEB_STORE_ID: &str = "ebdcbpghekpbgjiclaclbgmdnimeheci";
pub const EDGE_ADDONS_ID: &str = "knldjmfmopnpolahpmmgbagdohdnhkik";
pub const BRAVE_SECONDARY_ID: &str = "cphjfljhggknldkppchfobogknclmblg";

pub const FIREFOX_GECKO_ID: &str = "edm@suvesh.dev";

/// All allowed extension IDs for Chromium-based browsers (Chrome, Edge, Brave, etc.)
pub const CHROMIUM_ALLOWED_IDS: &[&str] = &[
    CHROMIUM_UNPACKED_ID,
    CHROME_WEB_STORE_ID,
    EDGE_ADDONS_ID,
    BRAVE_SECONDARY_ID,
];

/// All allowed extension IDs for Firefox
pub const FIREFOX_ALLOWED_IDS: &[&str] = &[
    FIREFOX_GECKO_ID,
];

/// Default store URLs for one-click installation
pub const DEFAULT_CHROME_STORE_URL: &str =
    "https://chromewebstore.google.com/detail/edm-edge-download-manager/ebdcbpghekpbgjiclaclbgmdnimeheci";
pub const DEFAULT_EDGE_STORE_URL: &str =
    "https://microsoftedge.microsoft.com/addons/detail/edm-edge-download-manager/knldjmfmopnpolahpmmgbagdohdnhkik";
pub const DEFAULT_FIREFOX_XPI_URL: &str =
    "http://127.0.0.1:14370/firefox.xpi";

/// Returns the slice of allowed Chromium extension IDs.
pub fn allowed_chromium_ids() -> &'static [&'static str] {
    CHROMIUM_ALLOWED_IDS
}

/// Returns the slice of allowed Firefox extension IDs.
pub fn allowed_firefox_ids() -> &'static [&'static str] {
    FIREFOX_ALLOWED_IDS
}

/// Returns formatted Chromium Native Messaging manifest origins (e.g. "chrome-extension://<id>/").
pub fn allowed_chromium_origins() -> Vec<String> {
    CHROMIUM_ALLOWED_IDS
        .iter()
        .map(|id| format!("chrome-extension://{}/", id))
        .collect()
}

/// Validates whether an extension ID matches any registered Chromium or Firefox extension ID.
pub fn is_allowed_extension_id(id: &str) -> bool {
    let clean = id.trim();
    CHROMIUM_ALLOWED_IDS.contains(&clean) || FIREFOX_ALLOWED_IDS.contains(&clean)
}

/// Validates whether an Origin header string matches an authorized extension origin.
///
/// Accepts:
/// - `chrome-extension://<allowed-id>` (with or without trailing slash)
/// - `moz-extension://<uuid>` (Firefox extension internal UUID origin)
///
/// Rejects:
/// - Any unknown or arbitrary `chrome-extension://<attacker-id>`
/// - Any external web origin (`http://`, `https://`)
/// - Empty, malformed, or null origins
pub fn is_allowed_origin(origin: &str) -> bool {
    let trimmed = origin.trim().trim_end_matches('/');
    if let Some(rest) = trimmed.strip_prefix("chrome-extension://") {
        let ext_id = rest.split('/').next().unwrap_or(rest);
        CHROMIUM_ALLOWED_IDS.contains(&ext_id)
    } else if trimmed.starts_with("moz-extension://") {
        // Firefox web extensions send an internal UUID origin on WebSocket / fetch calls.
        // True extension identity is authenticated via the Hello handshake containing FIREFOX_GECKO_ID.
        true
    } else {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_all_known_extension_ids_accepted() {
        assert!(is_allowed_extension_id(CHROMIUM_UNPACKED_ID));
        assert!(is_allowed_extension_id(CHROME_WEB_STORE_ID));
        assert!(is_allowed_extension_id(EDGE_ADDONS_ID));
        assert!(is_allowed_extension_id(BRAVE_SECONDARY_ID));
        assert!(is_allowed_extension_id(FIREFOX_GECKO_ID));
    }

    #[test]
    fn test_unknown_extension_ids_rejected() {
        assert!(!is_allowed_extension_id("malicious_extension_id"));
        assert!(!is_allowed_extension_id("abcdefghijklmnopqrstuvwxyz123456"));
        assert!(!is_allowed_extension_id(""));
        assert!(!is_allowed_extension_id("attacker@evil.com"));
    }

    #[test]
    fn test_chromium_origins_accepted() {
        for id in CHROMIUM_ALLOWED_IDS {
            let o1 = format!("chrome-extension://{}", id);
            let o2 = format!("chrome-extension://{}/", id);
            assert!(is_allowed_origin(&o1), "Failed for {}", o1);
            assert!(is_allowed_origin(&o2), "Failed for {}", o2);
        }
    }

    #[test]
    fn test_firefox_moz_extension_origin_accepted() {
        assert!(is_allowed_origin("moz-extension://b4b5e6fc-5231-419b-a010-86b2496a3fc4"));
        assert!(is_allowed_origin("moz-extension://b4b5e6fc-5231-419b-a010-86b2496a3fc4/"));
    }

    #[test]
    fn test_malicious_and_external_origins_rejected() {
        assert!(!is_allowed_origin("https://evil.com"));
        assert!(!is_allowed_origin("http://127.0.0.1:3000"));
        assert!(!is_allowed_origin("http://localhost:14370"));
        assert!(!is_allowed_origin("chrome-extension://unknownfakeextensionid123456"));
        assert!(!is_allowed_origin("null"));
        assert!(!is_allowed_origin(""));
    }

    #[test]
    fn test_allowed_chromium_origins_formatting() {
        let origins = allowed_chromium_origins();
        assert_eq!(origins.len(), CHROMIUM_ALLOWED_IDS.len());
        for origin in origins {
            assert!(origin.starts_with("chrome-extension://"));
            assert!(origin.ends_with('/'));
        }
    }
}
