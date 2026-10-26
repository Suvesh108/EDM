//! FTP / FTPS Feature Pack (Native Rust Implementation)
//! Features: FTP file downloads, passive mode (PASV) parser, byte-offset resumption (REST)

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FtpTarget {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub pass: String,
    pub path: String,
    pub is_secure: bool,
}

pub struct FtpPack;

impl FtpPack {
    /// Parse an FTP/FTPS URL into structured target parameters
    pub fn parse_url(url_str: &str) -> Result<FtpTarget, String> {
        let parsed = url::Url::parse(url_str).map_err(|e| format!("Invalid FTP URL: {}", e))?;

        let is_secure = match parsed.scheme() {
            "ftp" => false,
            "ftps" => true,
            _ => return Err("URL scheme is not ftp or ftps".into()),
        };

        let host = parsed
            .host_str()
            .ok_or_else(|| "FTP URL missing host".to_string())?
            .to_string();

        let port = parsed.port().unwrap_or(if is_secure { 990 } else { 21 });
        let user = if parsed.username().is_empty() {
            "anonymous".to_string()
        } else {
            parsed.username().to_string()
        };
        let pass = parsed.password().unwrap_or("anonymous@edm.net").to_string();
        let path = parsed.path().to_string();

        Ok(FtpTarget {
            host,
            port,
            user,
            pass,
            path,
            is_secure,
        })
    }

    /// Parse FTP 227 PASV response: `227 Entering Passive Mode (h1,h2,h3,h4,p1,p2)`
    pub fn parse_pasv_response(resp: &str) -> Result<(String, u16), String> {
        let open_paren = resp
            .find('(')
            .ok_or_else(|| "Missing '(' in PASV response".to_string())?;
        let close_paren = resp
            .find(')')
            .ok_or_else(|| "Missing ')' in PASV response".to_string())?;

        let numbers_str = &resp[open_paren + 1..close_paren];
        let nums: Vec<u16> = numbers_str
            .split(',')
            .filter_map(|s| s.trim().parse::<u16>().ok())
            .collect();

        if nums.len() != 6 {
            return Err("Invalid number count in PASV response".to_string());
        }

        let ip = format!("{}.{}.{}.{}", nums[0], nums[1], nums[2], nums[3]);
        let port = (nums[4] << 8) | nums[5];

        Ok((ip, port))
    }

    /// Generate standard FTP command lines with CRLF terminator
    pub fn cmd_user(user: &str) -> String {
        format!("USER {}\r\n", user)
    }

    pub fn cmd_pass(pass: &str) -> String {
        format!("PASS {}\r\n", pass)
    }

    pub fn cmd_type_binary() -> &'static str {
        "TYPE I\r\n"
    }

    pub fn cmd_pasv() -> &'static str {
        "PASV\r\n"
    }

    pub fn cmd_size(path: &str) -> String {
        format!("SIZE {}\r\n", path)
    }

    pub fn cmd_rest(offset: u64) -> String {
        format!("REST {}\r\n", offset)
    }

    pub fn cmd_retr(path: &str) -> String {
        format!("RETR {}\r\n", path)
    }

    pub fn cmd_quit() -> &'static str {
        "QUIT\r\n"
    }
}
