//! Parsing for `--since`.

use anyhow::{bail, Result};
use chrono::{NaiveDate, Utc};

const DAY_MS: i128 = 86_400_000;

/// Accepts either an RFC-3339-ish date (`2026-01-01`) or a span (`30d`, `12w`).
/// Returns ms since epoch.
pub fn parse_since(raw: &str) -> Result<i64> {
    // Rust's `trim` and JavaScript's disagree on exactly two code points:
    // Rust strips U+0085 (NEL) and keeps U+FEFF, JavaScript does the reverse. A
    // BOM riding along from `--since "$(cat cutoff.txt)"` is the realistic case,
    // so trim the union and accept both.
    let t = raw.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}');

    // A trailing unit letter commits the input to the span branch: a bad span
    // is never retried as a date. Anything else — including `2026-02-31`,
    // whose last character is a digit — falls through to the date branch and
    // so reports the date error.
    if let Some(unit @ ('d' | 'w' | 'm' | 'y')) = t.chars().last() {
        let rest = &t[..t.len() - unit.len_utf8()];
        let Some(n) = parse_signed(rest) else {
            bail!("invalid span: {t}");
        };
        let days = match unit {
            'd' => n,
            'w' => n.saturating_mul(7),
            'm' => n.saturating_mul(30),
            _ => n.saturating_mul(365),
        };
        // JS numbers absorb any span the `^-?\d+$` check lets through; i64
        // would panic or wrap, so the arithmetic saturates instead. Only
        // absurd inputs reach the clamp, and they were already meaningless.
        let ms = (Utc::now().timestamp_millis() as i128).saturating_sub(days.saturating_mul(DAY_MS));
        return Ok(ms.clamp(i64::MIN as i128, i64::MAX as i128) as i64);
    }

    if let Some(ms) = parse_date(t) {
        return Ok(ms);
    }
    bail!("invalid date: {t} (expected YYYY-MM-DD or a span like 30d)")
}

/// `^-?\d+$`, in i128 so the multipliers above have room to saturate rather
/// than overflow. Digit-only strings too long even for i128 saturate here.
fn parse_signed(s: &str) -> Option<i128> {
    let digits = s.strip_prefix('-').unwrap_or(s);
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    Some(s.parse::<i128>().unwrap_or({
        if s.starts_with('-') {
            i128::MIN
        } else {
            i128::MAX
        }
    }))
}

/// `^(\d{4})-(\d{2})-(\d{2})$` at UTC midnight, or `None` when the input is
/// not that shape or not a real calendar date.
fn parse_date(t: &str) -> Option<i64> {
    let b = t.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return None;
    }
    let digits = |r: std::ops::Range<usize>| {
        b[r.clone()].iter().all(u8::is_ascii_digit).then(|| {
            t[r].bytes()
                .fold(0i32, |acc, d| acc * 10 + i32::from(d - b'0'))
        })
    };
    let year = digits(0..4)?;
    let month = digits(5..7)?;
    let day = digits(8..10)?;
    // `Date.UTC` maps years 0-99 onto 1900-1999, so the TS round-trip check
    // rejects any four-digit year below 100. chrono would happily accept them,
    // so reject explicitly to keep the two implementations in step.
    if year < 100 {
        return None;
    }
    // from_ymd_opt is the round-trip check: it returns None for rollovers like
    // 2026-02-31 that `Date.UTC` would silently push into March.
    let date = NaiveDate::from_ymd_opt(year, month as u32, day as u32)?;
    Some(date.and_hms_opt(0, 0, 0)?.and_utc().timestamp_millis())
}
