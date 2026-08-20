//! Port of test/since.test.ts. The dedup-ordering case there belongs to the
//! scan module and lives with those tests.

use chrono::Utc;
use salt::since::parse_since;

const DAY_MS: i64 = 86_400_000;

fn err(raw: &str) -> String {
    parse_since(raw).unwrap_err().to_string()
}

#[test]
fn parses_spans_and_dates() {
    // 2026-01-01T00:00:00Z.
    assert_eq!(parse_since("2026-01-01").unwrap(), 1_767_225_600_000);

    let week = parse_since("7d").unwrap();
    let delta = (Utc::now().timestamp_millis() - week).div_euclid(DAY_MS);
    assert!((6..=7).contains(&delta), "delta was {delta}");

    assert!(parse_since("garbage").is_err());
    assert!(parse_since("xd").is_err());
}

#[test]
fn span_units_multiply() {
    let now = Utc::now().timestamp_millis();
    for (raw, days) in [("1d", 1), ("2w", 14), ("3m", 90), ("1y", 365)] {
        let got = parse_since(raw).unwrap();
        // now is sampled before the call, so the cutoff can only be older.
        let drift = (now - days * DAY_MS) - got;
        assert!((0..1000).contains(&drift), "{raw} drifted {drift}ms");
    }
}

#[test]
fn negative_spans_look_forward() {
    let now = Utc::now().timestamp_millis();
    let got = parse_since("-7d").unwrap();
    let drift = (now + 7 * DAY_MS) - got;
    assert!((0..1000).contains(&drift), "drifted {drift}ms");
}

#[test]
fn input_is_trimmed() {
    assert_eq!(parse_since("  2026-01-01\n").unwrap(), 1_767_225_600_000);
    assert!(parse_since(" 7d ").is_ok());
}

#[test]
fn bad_span_reports_the_span_error() {
    assert_eq!(err("xd"), "invalid span: xd");
    assert_eq!(err("d"), "invalid span: d");
    assert_eq!(err("1.5d"), "invalid span: 1.5d");
    assert_eq!(err("7 d"), "invalid span: 7 d");
    assert_eq!(err("--7d"), "invalid span: --7d");
}

#[test]
fn bad_date_reports_the_date_error() {
    const SUFFIX: &str = " (expected YYYY-MM-DD or a span like 30d)";
    // Rollovers end in a digit, so they miss the span branch entirely and get
    // the date message even though they look like a number.
    assert_eq!(err("2026-02-31"), format!("invalid date: 2026-02-31{SUFFIX}"));
    assert_eq!(err("garbage"), format!("invalid date: garbage{SUFFIX}"));
    assert_eq!(err(""), format!("invalid date: {SUFFIX}"));
    assert_eq!(err("2026-1-01"), format!("invalid date: 2026-1-01{SUFFIX}"));
    assert_eq!(err("2026-13-01"), format!("invalid date: 2026-13-01{SUFFIX}"));
    assert_eq!(err("2026-00-01"), format!("invalid date: 2026-00-01{SUFFIX}"));
    // Date.UTC maps a year under 100 into the 1900s, which the TS round-trip
    // check then rejects.
    assert_eq!(err("0026-01-01"), format!("invalid date: 0026-01-01{SUFFIX}"));
}

#[test]
fn real_calendar_dates_round_trip() {
    assert_eq!(parse_since("1970-01-01").unwrap(), 0);
    assert_eq!(parse_since("2024-02-29").unwrap(), 1_709_164_800_000);
    assert_eq!(parse_since("2026-08-10").unwrap(), 1_786_320_000_000);
    // Not a leap year: 2026-02-29 is a rollover.
    assert!(parse_since("2026-02-29").is_err());
}

#[test]
fn absurd_spans_saturate_instead_of_panicking() {
    // `^-?\d+$` accepts these, and JS just produced a huge float; the port
    // must not overflow.
    assert!(parse_since("999999999999999999999999999999d").is_ok());
    assert!(parse_since("-999999999999999999999999999999y").is_ok());
}
