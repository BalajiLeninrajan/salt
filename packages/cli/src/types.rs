//! Core types, and the wire schema of the published report.
//!
//! The report structs mirror `packages/core/src/report.ts` field for field and
//! in order — the site consumes this JSON and `packages/core` cannot be
//! imported from Rust, so the shape is held by convention plus the parity
//! harness in `scripts/parity.mjs`.

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Tier {
    Mild,
    Medium,
    Strong,
    Acronym,
}

impl Tier {
    /// Severity weights. A single "fuck" should outweigh a single "damn";
    /// acronyms sit just under the strong words they stand in for. The
    /// calendar shades by the sum of these, so they are part of the wire
    /// contract (`TIER_WEIGHT` in `packages/core/src/report.ts`).
    pub fn weight(self) -> u64 {
        match self {
            Tier::Mild => 5,
            Tier::Medium => 8,
            Tier::Strong => 10,
            Tier::Acronym => 6,
        }
    }

    pub fn parse(s: &str) -> Option<Tier> {
        match s {
            "mild" => Some(Tier::Mild),
            "medium" => Some(Tier::Medium),
            "strong" => Some(Tier::Strong),
            "acronym" => Some(Tier::Acronym),
            _ => None,
        }
    }
}

/// Ordering is the report's `by_harness` order, and `Ord` is derived from it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Harness {
    Claude,
    Codex,
    Cursor,
}

pub const ALL_HARNESSES: [Harness; 3] = [Harness::Claude, Harness::Codex, Harness::Cursor];

impl Harness {
    pub fn parse(s: &str) -> Option<Harness> {
        match s.trim().to_ascii_lowercase().as_str() {
            "claude" => Some(Harness::Claude),
            "codex" => Some(Harness::Codex),
            "cursor" => Some(Harness::Cursor),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Harness::Claude => "claude",
            Harness::Codex => "codex",
            Harness::Cursor => "cursor",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Role {
    User,
    Agent,
}

/// Cursor stores no per-message time, only when the chat was last touched.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TsPrecision {
    Exact,
    Session,
}

/// One turn from one harness.
///
/// `text` is transient: it reaches the profanity matcher and is dropped. It is
/// never serialised, cached, or sent to the browser.
#[derive(Debug, Clone)]
pub struct Message {
    pub harness: Harness,
    pub role: Role,
    /// Milliseconds since the Unix epoch, matching the JS original.
    pub ts: i64,
    pub ts_precision: TsPrecision,
    pub cwd: Option<String>,
    pub session_id: String,
    pub text: String,
}

#[derive(Debug, Default, Clone, Copy)]
pub struct ScanStats {
    pub files_scanned: u64,
    pub files_failed: u64,
    pub bytes_scanned: u64,
    pub duplicates_dropped: u64,
}

// ---------------------------------------------------------------------------
// Wire schema. Field order below is the serialised order; do not reorder.
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Serialize)]
pub struct Totals {
    pub sessions: u64,
    pub prompts: u64,
    pub words: u64,
    pub swears: u64,
    pub prompts_with_swear: u64,
    pub swears_per_100_prompts: f64,
}

#[derive(Debug, Serialize)]
pub struct HarnessStats {
    pub harness: Harness,
    pub prompts: u64,
    pub swears: u64,
    pub prompts_with_swear: u64,
    pub rate: f64,
}

#[derive(Debug, Default, Serialize)]
pub struct AgentTotals {
    pub messages: u64,
    pub words: u64,
    pub swears: u64,
    pub messages_with_swear: u64,
    pub swears_per_100_messages: f64,
}

#[derive(Debug, Serialize)]
pub struct AgentHarnessStats {
    pub harness: Harness,
    pub messages: u64,
    pub swears: u64,
    pub messages_with_swear: u64,
    pub rate: f64,
}

#[derive(Debug, Serialize)]
pub struct WordStat {
    pub word: String,
    pub tier: Tier,
    pub count: u64,
    pub share: f64,
}

#[derive(Debug, Serialize)]
pub struct DayStat {
    pub date: String,
    pub prompts: u64,
    pub swears: u64,
    /// Sum of tier weights over that day's swears; what the calendar shades by.
    pub weight: u64,
}

#[derive(Debug, Serialize)]
pub struct AgentDayStat {
    pub date: String,
    pub harness: Harness,
    pub messages: u64,
    pub swears: u64,
}

#[derive(Debug, Serialize)]
pub struct ProjectStat {
    pub name: String,
    pub prompts: u64,
    pub swears: u64,
    pub rate: f64,
}

#[derive(Debug, Default, Serialize)]
pub struct Coverage {
    pub files_scanned: u64,
    pub files_failed: u64,
    pub bytes_scanned: u64,
    pub duplicates_dropped: u64,
    pub session_precision_prompts: u64,
    pub notes: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct Report {
    pub generated_at: String,
    pub version: String,
    pub totals: Totals,
    pub by_harness: Vec<HarnessStats>,
    pub top_words: Vec<WordStat>,
    pub daily: Vec<DayStat>,
    pub projects: Vec<ProjectStat>,
    pub agent: AgentTotals,
    pub agent_by_harness: Vec<AgentHarnessStats>,
    pub agent_daily: Vec<AgentDayStat>,
    pub agent_top_words: Vec<WordStat>,
    pub coverage: Coverage,
}
