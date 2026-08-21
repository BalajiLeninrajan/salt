//! Dedup and job discovery.
//!
//! `dedup` decides which messages exist at all, so it is the most
//! consequential function in the crate that produces no output of its own. The
//! order-invariance tests here are what let the scan be parallelised at all: a
//! survivor that depends on which thread finished first would make the report
//! unreproducible, and no amount of corpus testing would reliably catch it.

use salt::scan::{dedup, jobs_for};
use salt::types::{Harness, Message, Role, TsPrecision, ALL_HARNESSES};

fn msg(ts: i64, cwd: Option<&str>, text: &str) -> Message {
    Message {
        harness: Harness::Codex,
        role: Role::User,
        ts,
        ts_precision: TsPrecision::Exact,
        cwd: cwd.map(str::to_owned),
        session_id: "s1".into(),
        text: text.into(),
    }
}

#[test]
fn collapses_replays_of_the_same_text_in_a_session() {
    // Codex rewrites a session's whole history into a new rollout on every
    // fork, so the same prompt arrives many times with fresh timestamps.
    let mut m = vec![
        msg(300, Some("/a"), "fix the thing"),
        msg(100, Some("/a"), "fix the thing"),
        msg(200, Some("/a"), "fix the thing"),
    ];
    let dropped = dedup(&mut m);
    assert_eq!(dropped, 2);
    assert_eq!(m.len(), 1);
    assert_eq!(m[0].ts, 100, "the earliest occurrence is the real one");
}

#[test]
fn different_text_or_session_is_not_a_replay() {
    let mut a = msg(1, Some("/a"), "one");
    let mut b = msg(2, Some("/a"), "two");
    b.text = "two".into();
    let mut c = msg(3, Some("/a"), "one");
    c.session_id = "s2".into();
    a.session_id = "s1".into();
    let mut m = vec![a, b, c];
    assert_eq!(dedup(&mut m), 0);
    assert_eq!(m.len(), 3);
}

#[test]
fn roles_are_deduped_independently() {
    let mut user = msg(1, Some("/a"), "same words");
    user.role = Role::User;
    let mut agent = msg(2, Some("/a"), "same words");
    agent.role = Role::Agent;
    let mut m = vec![user, agent];
    assert_eq!(
        dedup(&mut m),
        0,
        "a user and an agent saying it are two events"
    );
}

#[test]
fn ties_break_on_cwd_so_the_survivor_never_depends_on_thread_order() {
    // Same timestamp, different working directory: without a tie-break the
    // winner is whichever thread happened to produce it first, and the prompt
    // would be attributed to a different project between runs.
    let mut m = vec![msg(500, Some("/z"), "hey"), msg(500, Some("/a"), "hey")];
    dedup(&mut m);
    assert_eq!(m[0].cwd.as_deref(), Some("/a"));

    let mut reversed = vec![msg(500, Some("/a"), "hey"), msg(500, Some("/z"), "hey")];
    dedup(&mut reversed);
    assert_eq!(reversed[0].cwd.as_deref(), Some("/a"));
}

#[test]
fn a_message_with_no_cwd_loses_to_one_that_has_it() {
    let mut m = vec![msg(1, None, "hey"), msg(1, Some("/a"), "hey")];
    dedup(&mut m);
    assert_eq!(
        m[0].cwd.as_deref(),
        None,
        "None sorts first, so it survives"
    );
}

/// The property the whole parallel scan rests on.
#[test]
fn the_result_is_invariant_under_input_order() {
    let build = || {
        vec![
            msg(300, Some("/b"), "alpha"),
            msg(100, Some("/a"), "alpha"),
            msg(100, Some("/z"), "alpha"),
            msg(200, Some("/a"), "beta"),
            msg(50, None, "gamma"),
            msg(50, Some("/a"), "gamma"),
            msg(999, Some("/c"), "delta"),
        ]
    };
    let fingerprint = |mut v: Vec<Message>| {
        dedup(&mut v);
        v.into_iter()
            .map(|m| (m.ts, m.cwd, m.text))
            .collect::<Vec<_>>()
    };

    let expected = fingerprint(build());
    assert_eq!(expected.len(), 4);

    // Every rotation, plus the reverse, must land on the same answer.
    for shift in 0..7 {
        let mut v = build();
        v.rotate_left(shift);
        assert_eq!(
            fingerprint(v),
            expected,
            "rotation by {shift} changed the result"
        );
    }
    let mut reversed = build();
    reversed.reverse();
    assert_eq!(fingerprint(reversed), expected);
}

#[test]
fn dedup_of_nothing_is_nothing() {
    let mut empty: Vec<Message> = Vec::new();
    assert_eq!(dedup(&mut empty), 0);
}

#[test]
fn jobs_are_discovered_per_harness_and_sized() {
    let dir = tempfile::tempdir().expect("tempdir");
    let home = dir.path();
    let claude = home.join(".claude").join("projects").join("p");
    let codex = home.join(".codex").join("sessions").join("2026");
    let archived = home.join(".codex").join("archived_sessions");
    for d in [&claude, &codex, &archived] {
        std::fs::create_dir_all(d).expect("mkdir");
    }
    std::fs::write(claude.join("a.jsonl"), "hello").expect("write");
    std::fs::write(codex.join("b.jsonl"), "hi").expect("write");
    std::fs::write(archived.join("c.jsonl"), "x").expect("write");
    // Not a session log; must not be picked up.
    std::fs::write(claude.join("notes.txt"), "ignored").expect("write");

    let jobs = jobs_for(&ALL_HARNESSES, home);
    assert_eq!(jobs.len(), 3);
    assert_eq!(jobs.iter().map(|j| j.bytes).sum::<u64>(), 8);
    assert_eq!(
        jobs.iter().filter(|j| j.harness == Harness::Codex).count(),
        2
    );

    // Asking for one harness must not sweep up another's files.
    let only_claude = jobs_for(&[Harness::Claude], home);
    assert_eq!(only_claude.len(), 1);
    assert_eq!(only_claude[0].harness, Harness::Claude);
}

#[test]
fn a_missing_harness_directory_is_not_an_error() {
    let dir = tempfile::tempdir().expect("tempdir");
    assert!(jobs_for(&ALL_HARNESSES, dir.path()).is_empty());
}
