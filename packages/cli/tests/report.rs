//! Ported from the TypeScript `test/report.test.ts`.

use std::collections::HashSet;
use std::fs;

use chrono::{Local, TimeZone};
use salt::matcher::{Matcher, Overrides};
use salt::report::{build, project_name};
use salt::types::{Harness, Message, Report, Role, ScanStats, TsPrecision};

/// Timestamps are built from *local* wall-clock time, because the report dates
/// by the publisher's calendar day: a fixed UTC instant would land on different
/// days depending on where the test runs.
fn at(year: i32, month: u32, day: u32, hour: u32) -> i64 {
    Local
        .with_ymd_and_hms(year, month, day, hour, 0, 0)
        .unwrap()
        .timestamp_millis()
}

fn day_of(ts: i64) -> String {
    format!(
        "{}",
        Local.timestamp_millis_opt(ts).unwrap().format("%Y-%m-%d")
    )
}

fn message(text: &str, ts: i64, harness: Harness, precision: TsPrecision, role: Role) -> Message {
    Message {
        harness,
        role,
        ts,
        ts_precision: precision,
        cwd: Some("/tmp/proj".to_string()),
        session_id: "s1".to_string(),
        text: text.to_string(),
    }
}

fn prompt(text: &str, ts: i64, harness: Harness, precision: TsPrecision) -> Message {
    message(text, ts, harness, precision, Role::User)
}

fn reply(text: &str, ts: i64, harness: Harness) -> Message {
    message(text, ts, harness, TsPrecision::Exact, Role::Agent)
}

fn build_from(messages: Vec<Message>) -> Report {
    build(
        messages,
        ScanStats::default(),
        &Matcher::new(&Overrides::default()),
        "0.1.2",
    )
}

#[test]
fn counts_totals_and_rates() {
    let r = build_from(vec![
        prompt(
            "this is fucking broken",
            at(2026, 8, 17, 10),
            Harness::Claude,
            TsPrecision::Exact,
        ),
        prompt(
            "looks fine",
            at(2026, 8, 17, 11),
            Harness::Claude,
            TsPrecision::Exact,
        ),
    ]);
    assert_eq!(r.totals.prompts, 2);
    assert_eq!(r.totals.swears, 1);
    assert_eq!(r.totals.prompts_with_swear, 1);
    assert_eq!(r.totals.swears_per_100_prompts, 50.0);
}

#[test]
fn rate_counts_every_swear_not_every_prompt() {
    // Three swears in one prompt is 300 per 100, not 100.
    let r = build_from(vec![prompt(
        "fuck this fucking shit",
        at(2026, 8, 17, 10),
        Harness::Codex,
        TsPrecision::Exact,
    )]);
    assert_eq!(r.totals.swears, 3);
    assert_eq!(r.totals.prompts_with_swear, 1);
    assert_eq!(r.totals.swears_per_100_prompts, 300.0);
}

/// Day resolution tolerates a session-level timestamp, so these count; the
/// coverage note is what tells the reader they are dated approximately.
#[test]
fn session_precision_prompts_are_counted_and_disclosed() {
    let r = build_from(vec![
        prompt(
            "fuck",
            at(2026, 8, 17, 10),
            Harness::Cursor,
            TsPrecision::Session,
        ),
        prompt(
            "fuck",
            at(2026, 8, 17, 10),
            Harness::Claude,
            TsPrecision::Exact,
        ),
    ]);
    let counted: u64 = r.daily.iter().map(|d| d.prompts).sum();
    assert_eq!(counted, 2);
    assert_eq!(r.coverage.session_precision_prompts, 1);
    assert!(r.coverage.notes.iter().any(|n| n.contains("session-level")));
}

#[test]
fn days_carry_severity_weight() {
    let r = build_from(vec![
        prompt(
            "fuck damn",
            at(2026, 8, 17, 10),
            Harness::Claude,
            TsPrecision::Exact,
        ),
        prompt(
            "shit",
            at(2026, 8, 17, 11),
            Harness::Claude,
            TsPrecision::Exact,
        ),
    ]);
    assert_eq!(r.daily.len(), 1);
    assert_eq!(r.daily[0].prompts, 2);
    assert_eq!(r.daily[0].swears, 3);
    // strong 10 + mild 5 + medium 8
    assert_eq!(r.daily[0].weight, 23);
}

#[test]
fn top_words_are_ranked() {
    let r = build_from(vec![prompt(
        "fuck fuck shit",
        at(2026, 8, 17, 10),
        Harness::Codex,
        TsPrecision::Exact,
    )]);
    assert_eq!(r.top_words[0].word, "fuck");
    assert_eq!(r.top_words[0].count, 2);
    assert!((r.top_words[0].share - 2.0 / 3.0).abs() < 1e-9);
}

/// The privacy guarantee: nothing a user typed may appear in the output.
#[test]
fn report_never_contains_prompt_text() {
    const SENTINEL: &str = "zzsentinelzz";
    let r = build_from(vec![prompt(
        &format!("{SENTINEL} this is fucking broken"),
        at(2026, 8, 17, 10),
        Harness::Claude,
        TsPrecision::Exact,
    )]);
    let json = serde_json::to_string(&r).unwrap();
    assert!(!json.contains(SENTINEL));
    // The matched swear itself is expected; the surrounding prose is not.
    assert!(json.contains("fucking"));
    assert!(!json.contains("this is"));
}

#[test]
fn home_directory_is_not_a_project() {
    let mut p = prompt(
        "hi",
        at(2026, 8, 17, 10),
        Harness::Claude,
        TsPrecision::Exact,
    );
    p.cwd = Some(dirs::home_dir().unwrap().to_str().unwrap().to_string());
    let r = build_from(vec![p]);
    // home dir must not leak as a project
    assert!(r.projects.is_empty());
}

#[test]
fn agent_messages_are_counted_separately() {
    let r = build_from(vec![
        prompt(
            "fix this fucking bug",
            at(2026, 8, 17, 10),
            Harness::Claude,
            TsPrecision::Exact,
        ),
        reply("damn, good catch", at(2026, 8, 17, 11), Harness::Claude),
        reply("all done", at(2026, 8, 17, 12), Harness::Claude),
    ]);

    // The user's headline number sees only the user's own prompt.
    assert_eq!(r.totals.prompts, 1);
    assert_eq!(r.totals.swears, 1);
    assert_eq!(r.totals.swears_per_100_prompts, 100.0);

    assert_eq!(r.agent.messages, 2);
    assert_eq!(r.agent.swears, 1);
    assert_eq!(r.agent.messages_with_swear, 1);
    assert_eq!(r.agent.swears_per_100_messages, 50.0);

    assert_eq!(r.agent_top_words[0].word, "damn");
    assert_eq!(r.top_words[0].word, "fucking");
}

#[test]
fn agent_messages_do_not_reach_user_scoped_sections() {
    let r = build_from(vec![reply("damn", at(2026, 8, 17, 10), Harness::Claude)]);
    assert_eq!(r.totals.prompts, 0);
    assert_eq!(r.totals.swears, 0);
    assert!(r.daily.is_empty());
    assert!(r.projects.is_empty());
    assert!(r.by_harness.is_empty());
    assert_eq!(r.agent.messages, 1);
    assert_eq!(r.agent_by_harness[0].harness, Harness::Claude);
    assert_eq!(r.agent_by_harness[0].messages, 1);
}

#[test]
fn agent_daily_is_split_by_harness() {
    let (t1, t2, t3, t4) = (
        at(2026, 8, 17, 10),
        at(2026, 8, 17, 11),
        at(2026, 8, 17, 12),
        at(2026, 8, 18, 9),
    );
    let r = build_from(vec![
        reply("damn", t1, Harness::Claude),
        reply("all fine", t2, Harness::Claude),
        reply("shit", t3, Harness::Codex),
        reply("damn again", t4, Harness::Claude),
    ]);

    let row = |ts: i64, harness: Harness| {
        let date = day_of(ts);
        r.agent_daily
            .iter()
            .find(|d| d.date == date && d.harness == harness)
            .unwrap_or_else(|| panic!("missing {date}/{}", harness.as_str()))
    };
    assert_eq!(r.agent_daily.len(), 3);
    assert_eq!(row(t1, Harness::Claude).messages, 2);
    assert_eq!(row(t1, Harness::Claude).swears, 1);
    assert_eq!(row(t3, Harness::Codex).swears, 1);
    assert_eq!(row(t4, Harness::Claude).swears, 1);

    // Every agent swear lands in exactly one day/harness bucket.
    let summed: u64 = r.agent_daily.iter().map(|d| d.swears).sum();
    assert_eq!(summed, r.agent.swears);
}

#[test]
fn agent_daily_excludes_user_prompts() {
    let r = build_from(vec![prompt(
        "fuck this",
        at(2026, 8, 17, 10),
        Harness::Claude,
        TsPrecision::Exact,
    )]);
    assert!(r.agent_daily.is_empty());
    assert_eq!(r.daily.len(), 1);
}

#[test]
fn report_never_contains_agent_text() {
    const SENTINEL: &str = "zzagentzz";
    let r = build_from(vec![reply(
        &format!("{SENTINEL} that was damn close"),
        at(2026, 8, 17, 10),
        Harness::Codex,
    )]);
    let json = serde_json::to_string(&r).unwrap();
    assert!(!json.contains(SENTINEL));
    assert!(json.contains("damn"));
}

#[test]
fn word_count_splits_on_unicode_whitespace() {
    let r = build_from(vec![
        // NEL splits (2 words), ZWNBSP does not (1 word).
        prompt(
            "a\u{85}b",
            at(2026, 8, 17, 10),
            Harness::Claude,
            TsPrecision::Exact,
        ),
        prompt(
            "c\u{feff}d",
            at(2026, 8, 17, 11),
            Harness::Claude,
            TsPrecision::Exact,
        ),
    ]);
    assert_eq!(r.totals.words, 3);
}

#[test]
fn tied_projects_order_by_code_point() {
    // U+FF5E sorts before U+1F4A9 byte-wise; JS `<` on UTF-16 units says the opposite.
    let dir = std::env::temp_dir().join("salt-tie");
    let mut a = prompt(
        "hi",
        at(2026, 8, 17, 10),
        Harness::Claude,
        TsPrecision::Exact,
    );
    a.cwd = Some(dir.join("～tools").to_str().unwrap().to_string());
    let mut b = prompt(
        "hi",
        at(2026, 8, 17, 11),
        Harness::Claude,
        TsPrecision::Exact,
    );
    b.cwd = Some(dir.join("\u{1F4A9}app").to_str().unwrap().to_string());
    let r = build_from(vec![a, b]);
    let names: Vec<&str> = r.projects.iter().map(|p| p.name.as_str()).collect();
    assert_eq!(names, ["～tools", "\u{1F4A9}app"]);
}

#[test]
fn non_canonical_home_spellings_are_not_projects() {
    let home = dirs::home_dir()
        .unwrap()
        .to_str()
        .unwrap()
        .trim_end_matches('/')
        .to_string();
    let segs: Vec<&str> = home.split('/').filter(|s| !s.is_empty()).collect();
    assert_eq!(project_name(&format!("{home}/.")), None);
    assert_eq!(project_name(&format!("{home}//")), None);
    assert_eq!(project_name(&format!("/{}", segs.join("//"))), None);
    assert_eq!(project_name(&format!("/{}", segs.join("/./"))), None);
}

#[test]
fn project_name_comes_from_normalized_components() {
    let dir = tempfile::tempdir().unwrap();
    let repo = dir.path().join("repo");
    fs::create_dir_all(repo.join(".git")).unwrap();
    let repo = repo.to_str().unwrap();
    assert_eq!(project_name(&format!("{repo}/.")).as_deref(), Some("repo"));
    assert_eq!(
        project_name(&format!("{}//repo", dir.path().to_str().unwrap())).as_deref(),
        Some("repo")
    );
    // With no .git in reach the leaf directory wins, `.` normalized away.
    assert_eq!(
        project_name("/nonexistent-salt/leaf/.").as_deref(),
        Some("leaf")
    );
}

/// A `.git` file — a worktree or submodule checkout — marks a repo too.
#[test]
fn project_name_accepts_a_git_file() {
    let dir = tempfile::tempdir().unwrap();
    let repo = dir.path().join("worktree");
    fs::create_dir_all(repo.join("src")).unwrap();
    fs::write(repo.join(".git"), "gitdir: /elsewhere\n").unwrap();
    assert_eq!(
        project_name(repo.join("src").to_str().unwrap()).as_deref(),
        Some("worktree")
    );
}

#[test]
fn project_name_is_basename_only() {
    let r = build_from(vec![prompt(
        "hi",
        at(2026, 8, 17, 10),
        Harness::Claude,
        TsPrecision::Exact,
    )]);
    assert_eq!(r.projects[0].name, "proj");
    let json = serde_json::to_string(&r).unwrap();
    // absolute path must not leak
    assert!(!json.contains("/tmp/proj"));
}

/// The cache must not change the answer when one cwd repeats, nor let two
/// different cwds share an entry.
#[test]
fn repeated_cwds_aggregate_into_one_project() {
    let mk = |cwd: &str, text: &str| {
        let mut p = prompt(
            text,
            at(2026, 8, 17, 10),
            Harness::Claude,
            TsPrecision::Exact,
        );
        p.cwd = Some(cwd.to_string());
        p
    };
    let r = build_from(vec![
        mk("/nonexistent-salt/alpha", "fuck"),
        mk("/nonexistent-salt/alpha", "fine"),
        mk("/nonexistent-salt/beta", "damn"),
    ]);
    let names: HashSet<&str> = r.projects.iter().map(|p| p.name.as_str()).collect();
    assert_eq!(names, HashSet::from(["alpha", "beta"]));
    let alpha = r.projects.iter().find(|p| p.name == "alpha").unwrap();
    assert_eq!(alpha.prompts, 2);
    assert_eq!(alpha.swears, 1);
    assert_eq!(alpha.rate, 50.0);
}

/// `toISOString` shape: exactly three fractional digits, always.
#[test]
fn generated_at_is_iso_with_millis() {
    let r = build_from(vec![]);
    assert_eq!(r.generated_at.len(), 24, "{}", r.generated_at);
    assert!(r.generated_at.ends_with('Z'));
    assert_eq!(&r.generated_at[10..11], "T");
    assert_eq!(&r.generated_at[19..20], ".");
    assert_eq!(r.version, "0.1.2");
}
