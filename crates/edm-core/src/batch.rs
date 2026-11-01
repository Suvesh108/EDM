use std::collections::HashSet;

/// Expands batch pattern URLs such as:
/// - `https://example.com/file[01-10].zip` -> `file01.zip` .. `file10.zip` (with zero padding)
/// - `https://example.com/archive_[a-f].tar.gz` -> `archive_a.tar.gz` .. `archive_f.tar.gz`
/// - `https://example.com/{us,eu,asia}/data.bin` -> `us`, `eu`, `asia`
///
/// Guardrails:
/// - Hard cap of 1,000 items maximum
/// - Rejects reversed ranges (e.g. `[10-01]` or `[z-a]`)
/// - Rejects malformed brackets or oversized ranges
pub fn expand_batch_pattern(pattern: &str) -> Result<Vec<String>, String> {
    let trimmed = pattern.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }

    let results = vec![trimmed.to_string()];

    // 1. Expand brace sets: {a,b,c}
    if let Some(start_idx) = trimmed.find('{') {
        if let Some(end_idx) = trimmed[start_idx..].find('}') {
            let end_abs = start_idx + end_idx;
            let inner = &trimmed[start_idx + 1..end_abs];
            let options: Vec<&str> = inner.split(',').map(|s| s.trim()).filter(|s| !s.is_empty()).collect();
            if options.is_empty() {
                return Err("Empty set in brace expression".into());
            }

            let mut expanded = Vec::new();
            for opt in options {
                let s = format!("{}{}{}", &trimmed[..start_idx], opt, &trimmed[end_abs + 1..]);
                let sub = expand_batch_pattern(&s)?;
                expanded.extend(sub);
                if expanded.len() > 1000 {
                    return Err("Batch expansion exceeded safety limit of 1,000 items".into());
                }
            }
            return Ok(deduplicate(expanded));
        }
    }

    // 2. Expand bracket ranges: [01-20] or [a-z]
    if let Some(start_idx) = trimmed.find('[') {
        if let Some(end_idx) = trimmed[start_idx..].find(']') {
            let end_abs = start_idx + end_idx;
            let inner = &trimmed[start_idx + 1..end_abs];
            let parts: Vec<&str> = inner.split('-').collect();
            if parts.len() == 2 {
                let p1 = parts[0].trim();
                let p2 = parts[1].trim();

                // Check numeric range
                if let (Ok(num1), Ok(num2)) = (p1.parse::<u32>(), p2.parse::<u32>()) {
                    if num1 > num2 {
                        return Err(format!("Reversed numeric range [{}..{}] is not supported", num1, num2));
                    }
                    let count = num2 - num1 + 1;
                    if count > 1000 {
                        return Err(format!("Range length {} exceeds safety cap of 1,000 items", count));
                    }

                    let pad_len = if p1.starts_with('0') && p1.len() > 1 {
                        p1.len()
                    } else {
                        0
                    };

                    let mut expanded = Vec::new();
                    for n in num1..=num2 {
                        let formatted_num = if pad_len > 0 {
                            format!("{:0width$}", n, width = pad_len)
                        } else {
                            n.to_string()
                        };
                        let s = format!("{}{}{}", &trimmed[..start_idx], formatted_num, &trimmed[end_abs + 1..]);
                        let sub = expand_batch_pattern(&s)?;
                        expanded.extend(sub);
                        if expanded.len() > 1000 {
                            return Err("Batch expansion exceeded safety limit of 1,000 items".into());
                        }
                    }
                    return Ok(deduplicate(expanded));
                }

                // Check single character alpha range
                if p1.len() == 1 && p2.len() == 1 {
                    let c1 = p1.chars().next().unwrap();
                    let c2 = p2.chars().next().unwrap();
                    if c1.is_ascii_alphabetic() && c2.is_ascii_alphabetic() {
                        if c1 > c2 {
                            return Err(format!("Reversed alphabetic range [{}..{}] is not supported", c1, c2));
                        }
                        let mut expanded = Vec::new();
                        for byte in (c1 as u8)..=(c2 as u8) {
                            let ch = byte as char;
                            let s = format!("{}{}{}", &trimmed[..start_idx], ch, &trimmed[end_abs + 1..]);
                            let sub = expand_batch_pattern(&s)?;
                            expanded.extend(sub);
                            if expanded.len() > 1000 {
                                return Err("Batch expansion exceeded safety limit of 1,000 items".into());
                            }
                        }
                        return Ok(deduplicate(expanded));
                    }
                }
            }
        }
    }

    Ok(results)
}

fn deduplicate(items: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for it in items {
        if seen.insert(it.clone()) {
            out.push(it);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_expand_numeric_padded() {
        let pattern = "https://example.com/file[01-05].zip";
        let expanded = expand_batch_pattern(pattern).expect("expansion failed");
        assert_eq!(expanded.len(), 5);
        assert_eq!(expanded[0], "https://example.com/file01.zip");
        assert_eq!(expanded[4], "https://example.com/file05.zip");
    }

    #[test]
    fn test_expand_alpha_range() {
        let pattern = "https://cdn.site.com/chunk_[a-d].bin";
        let expanded = expand_batch_pattern(pattern).expect("expansion failed");
        assert_eq!(expanded.len(), 4);
        assert_eq!(expanded[0], "https://cdn.site.com/chunk_a.bin");
        assert_eq!(expanded[3], "https://cdn.site.com/chunk_d.bin");
    }

    #[test]
    fn test_expand_braces() {
        let pattern = "https://site.com/{us,eu,asia}/archive.tar";
        let expanded = expand_batch_pattern(pattern).expect("expansion failed");
        assert_eq!(expanded.len(), 3);
        assert_eq!(expanded[0], "https://site.com/us/archive.tar");
        assert_eq!(expanded[1], "https://site.com/eu/archive.tar");
        assert_eq!(expanded[2], "https://site.com/asia/archive.tar");
    }

    #[test]
    fn test_reject_reversed_range() {
        assert!(expand_batch_pattern("https://example.com/file[10-01].zip").is_err());
        assert!(expand_batch_pattern("https://example.com/file[z-a].zip").is_err());
    }

    #[test]
    fn test_reject_oversized_range() {
        assert!(expand_batch_pattern("https://example.com/file[0001-2000].zip").is_err());
    }
}
