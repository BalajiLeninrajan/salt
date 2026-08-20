//! Text primitives shared by the stripper, the matcher, and the report.
//!
//! Most of what the TypeScript implementation needed here does not exist in
//! Rust: `str::split_whitespace` already uses the Unicode `White_Space`
//! property (so U+0085 splits and U+FEFF does not), and `str` compares in
//! UTF-8 byte order, which is the code-point order the report's tie-breaks
//! require. Those were emulated in TS and come free here.

/// Bytes that count as part of a word: `[A-Za-z0-9_']`.
///
/// Byte-level rather than char-level on purpose. Every word byte is ASCII, so
/// a byte >= 0x80 — any part of a multi-byte character — is correctly a
/// non-word byte, and scanning outward from a match can never split a
/// character.
#[inline]
pub fn is_word_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b == b'\''
}

/// True when `text[..at]` ends on a word byte.
#[inline]
pub fn word_byte_before(text: &str, at: usize) -> bool {
    at > 0 && is_word_byte(text.as_bytes()[at - 1])
}

/// True when `text[at..]` begins on a word byte.
#[inline]
pub fn word_byte_at(text: &str, at: usize) -> bool {
    text.as_bytes().get(at).copied().is_some_and(is_word_byte)
}

/// Expands `[start, end)` outward over word bytes, for the allowlist check.
pub fn whole_word(text: &str, start: usize, end: usize) -> (usize, usize) {
    let bytes = text.as_bytes();
    let mut s = start;
    while s > 0 && is_word_byte(bytes[s - 1]) {
        s -= 1;
    }
    let mut e = end;
    while e < bytes.len() && is_word_byte(bytes[e]) {
        e += 1;
    }
    (s, e)
}
