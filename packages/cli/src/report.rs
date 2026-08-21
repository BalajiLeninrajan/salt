//! Aggregation — and the privacy boundary.
//!
//! Message text enters this module and does not leave it. Everything below is a
//! count, a rate, or a matched lexicon word; nothing that reaches the browser,
//! the cache, or stdout carries what was actually written. `build` takes the
//! messages by value so the prompt text is dropped on return rather than left
//! alive in the caller's vector.
//!
//! The user's side and the agent's side are aggregated separately. `totals`,
//! `daily`, and `projects` are all user-scoped; the agent gets its own counters
//! rather than being folded into the headline number.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::ffi::OsStr;
use std::path::Path;

use chrono::{DateTime, Local, Utc};

use crate::matcher::{Hit, Matcher};
use crate::types::{
    AgentDayStat, AgentHarnessStats, AgentTotals, Coverage, DayStat, Harness, HarnessStats,
    Message, ProjectStat, Report, Role, ScanStats, Tier, Totals, TsPrecision, WordStat,
    ALL_HARNESSES,
};

#[derive(Default, Clone, Copy)]
struct Bucket {
    prompts: u64,
    swears: u64,
    prompts_with_swear: u64,
}

impl Bucket {
    fn add(&mut self, swears: u64) {
        self.prompts += 1;
        self.swears += swears;
        if swears > 0 {
            self.prompts_with_swear += 1;
        }
    }
}

/// Days carry a third counter: prompts, swears, and the severity weight of
/// those swears, which is what the calendar shades by.
#[derive(Default, Clone, Copy)]
struct Day {
    prompts: u64,
    swears: u64,
    weight: u64,
}

fn rate(swears: u64, prompts: u64) -> f64 {
    if prompts == 0 {
        0.0
    } else {
        // Multiply before dividing, as the TypeScript does, so the rounding is
        // bit-identical between the two implementations.
        100.0 * swears as f64 / prompts as f64
    }
}

/// The publisher's own calendar day. A prompt typed at 11pm belongs to that
/// evening, not to the next UTC date, and this is a log of one person's days.
fn local_date(ts: i64) -> String {
    match DateTime::from_timestamp_millis(ts) {
        Some(t) => t.with_timezone(&Local).format("%Y-%m-%d").to_string(),
        // Beyond chrono's range; JS would produce "NaN-NaN-NaN" here. Keeping a
        // parseable string means one absurd timestamp cannot break the calendar.
        None => "0000-00-00".to_string(),
    }
}

/// Ranks matched words by frequency, ties broken alphabetically so the order is
/// stable across runs. Byte order on `str` is the code point order the
/// TypeScript had to emulate.
fn rank_words(counts: HashMap<String, (Tier, u64)>, total: u64) -> Vec<WordStat> {
    let mut out: Vec<WordStat> = counts
        .into_iter()
        .map(|(word, (tier, count))| WordStat {
            word,
            tier,
            count,
            share: if total == 0 {
                0.0
            } else {
                count as f64 / total as f64
            },
        })
        .collect();
    out.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.word.cmp(&b.word)));
    out
}

fn harness_stats(map: &HashMap<Harness, Bucket>) -> Vec<HarnessStats> {
    ALL_HARNESSES
        .iter()
        .filter_map(|h| {
            let b = map.get(h)?;
            Some(HarnessStats {
                harness: *h,
                prompts: b.prompts,
                swears: b.swears,
                prompts_with_swear: b.prompts_with_swear,
                rate: rate(b.swears, b.prompts),
            })
        })
        .collect()
}

pub fn build(messages: Vec<Message>, stats: ScanStats, matcher: &Matcher, version: &str) -> Report {
    let mut totals = Totals::default();
    let mut by_harness: HashMap<Harness, Bucket> = HashMap::new();
    let mut by_day: BTreeMap<String, Day> = BTreeMap::new();
    let mut by_project: HashMap<String, (u64, u64)> = HashMap::new();
    let mut word_counts: HashMap<String, (Tier, u64)> = HashMap::new();
    let mut sessions: HashSet<(Harness, String)> = HashSet::new();
    let mut session_precision: u64 = 0;

    let mut agent = AgentTotals::default();
    let mut agent_by_harness_map: HashMap<Harness, Bucket> = HashMap::new();
    let mut agent_by_day: BTreeMap<(String, Harness), (u64, u64)> = BTreeMap::new();
    let mut agent_word_counts: HashMap<String, (Tier, u64)> = HashMap::new();

    // One repo lookup per distinct cwd. `project_name` walks the ancestor chain
    // stat'ing `.git`, and a busy project turns up in thousands of prompts; v1
    // repeated the whole chain for every one of them.
    let mut project_cache: HashMap<String, Option<String>> = HashMap::new();
    let home = dirs::home_dir();

    for p in messages {
        let hits: Vec<Hit> = matcher.find(&p.text);
        let swears = hits.len() as u64;
        let date = local_date(p.ts);

        if p.role == Role::Agent {
            agent.messages += 1;
            agent.words += p.text.split_whitespace().count() as u64;
            agent.swears += swears;
            if swears > 0 {
                agent.messages_with_swear += 1;
            }
            Matcher::tally(&hits, &mut agent_word_counts);
            agent_by_harness_map
                .entry(p.harness)
                .or_default()
                .add(swears);
            let e = agent_by_day.entry((date, p.harness)).or_default();
            e.0 += 1;
            e.1 += swears;
            continue;
        }

        totals.prompts += 1;
        totals.words += p.text.split_whitespace().count() as u64;
        totals.swears += swears;
        if swears > 0 {
            totals.prompts_with_swear += 1;
        }

        Matcher::tally(&hits, &mut word_counts);

        sessions.insert((p.harness, p.session_id));
        by_harness.entry(p.harness).or_default().add(swears);

        let day = by_day.entry(date).or_default();
        day.prompts += 1;
        day.swears += swears;
        for h in &hits {
            day.weight += h.tier.weight();
        }

        // Cursor stores no per-message time, only when the chat was last touched.
        // At day resolution that is close enough to keep — the calendar counts it,
        // and coverage says so.
        if p.ts_precision != TsPrecision::Exact {
            session_precision += 1;
        }

        if let Some(cwd) = p.cwd {
            let name = project_cache
                .entry(cwd)
                .or_insert_with_key(|cwd| project_name_with_home(cwd, home.as_deref()))
                .clone();
            if let Some(name) = name {
                let e = by_project.entry(name).or_insert((0, 0));
                e.0 += 1;
                e.1 += swears;
            }
        }
    }

    totals.sessions = sessions.len() as u64;
    totals.swears_per_100_prompts = rate(totals.swears, totals.prompts);
    agent.swears_per_100_messages = rate(agent.swears, agent.messages);

    let mut projects: Vec<ProjectStat> = by_project
        .into_iter()
        .map(|(name, (prompts, swears))| ProjectStat {
            name,
            prompts,
            swears,
            rate: rate(swears, prompts),
        })
        .collect();
    projects.sort_by(|a, b| {
        b.swears
            .cmp(&a.swears)
            .then_with(|| b.prompts.cmp(&a.prompts))
            .then_with(|| a.name.cmp(&b.name))
    });

    let agent_by_harness: Vec<AgentHarnessStats> = harness_stats(&agent_by_harness_map)
        .into_iter()
        .map(|s| AgentHarnessStats {
            harness: s.harness,
            messages: s.prompts,
            swears: s.swears,
            messages_with_swear: s.prompts_with_swear,
            rate: s.rate,
        })
        .collect();

    let daily: Vec<DayStat> = by_day
        .into_iter()
        .map(|(date, d)| DayStat {
            date,
            prompts: d.prompts,
            swears: d.swears,
            weight: d.weight,
        })
        .collect();

    // Days a harness was idle are absent rather than zero-filled; the chart
    // reads a gap as zero.
    let agent_daily: Vec<AgentDayStat> = agent_by_day
        .into_iter()
        .map(|((date, harness), (messages, swears))| AgentDayStat {
            date,
            harness,
            messages,
            swears,
        })
        .collect();

    let mut notes: Vec<String> = Vec::new();
    if session_precision > 0 {
        notes.push(format!(
            "{session_precision} Cursor prompts have session-level timestamps only; they are dated by when their chat was last touched."
        ));
    }
    if stats.files_failed > 0 {
        // Not pluralised, deliberately: the TypeScript wording is the wire
        // contract, so "1 files could not be read." is the correct output.
        notes.push(format!("{} files could not be read.", stats.files_failed));
    }
    if stats.duplicates_dropped > 0 {
        notes.push(format!(
            "{} replayed prompts were collapsed; agent harnesses rewrite session history on fork and resume.",
            stats.duplicates_dropped
        ));
    }

    Report {
        // JS `Date#toISOString`: always exactly three fractional digits.
        generated_at: Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string(),
        version: version.to_string(),
        by_harness: harness_stats(&by_harness),
        top_words: rank_words(word_counts, totals.swears),
        totals,
        daily,
        projects,
        agent_by_harness,
        agent_daily,
        agent_top_words: rank_words(agent_word_counts, agent.swears),
        agent,
        coverage: Coverage {
            files_scanned: stats.files_scanned,
            files_failed: stats.files_failed,
            bytes_scanned: stats.bytes_scanned,
            duplicates_dropped: stats.duplicates_dropped,
            session_precision_prompts: session_precision,
            notes,
        },
    }
}

/// Reduces a working directory to a shareable project name: the basename of the
/// enclosing git repository, else the leaf directory.
///
/// This used to normalise path components by hand so that no spelling of the
/// home directory (`/Users/name/.`, `/Users//name`) slipped past the exclusion.
/// `Path` already does exactly that — it compares by components, so repeated
/// separators and non-leading `.` are equal by construction — and its
/// `ancestors()` is the same chain the hand-rolled walk produced.
pub fn project_name(cwd: &str) -> Option<String> {
    project_name_with_home(cwd, dirs::home_dir().as_deref())
}

/// Same, with the home directory resolved once by the caller — `build` looks it
/// up per report rather than per message.
fn project_name_with_home(cwd: &str, home: Option<&Path>) -> Option<String> {
    let path = Path::new(cwd);
    // The home directory is not a project; prompts typed there would otherwise
    // rank as one and expose the account name.
    if home == Some(path) {
        return None;
    }

    // A `.git` *file* counts too: that is what a worktree or submodule
    // checkout has.
    path.ancestors()
        .find(|dir| dir.join(".git").exists())
        .unwrap_or(path)
        .file_name()
        .and_then(OsStr::to_str)
        .map(str::to_owned)
}
