use std::process::ExitCode;
use std::time::Instant;

use salt::args::{self, UsageError};
use salt::types::ALL_HARNESSES;
use salt::{lexicon, matcher::Matcher, publish, report, scan, since, ui};

const VERSION: &str = env!("CARGO_PKG_VERSION");

fn gb(bytes: u64) -> String {
    format!("{:.1}", bytes as f64 / 1e9)
}

/// JavaScript prints `30`, not `30.0`, and this string is user-facing.
fn days(n: f64) -> String {
    if n.fract() == 0.0 {
        format!("{}", n as i64)
    } else {
        format!("{n}")
    }
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            // A usage problem is the user's typo and exits 2; everything else
            // is a failure of ours and exits 1.
            if let Some(u) = e.downcast_ref::<UsageError>() {
                eprintln!("{u}");
                return ExitCode::from(2);
            }
            eprintln!("Error: {e}");
            ExitCode::from(1)
        }
    }
}

fn run() -> anyhow::Result<()> {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let args = args::parse(&argv)?;

    if args.help {
        println!("{}", args::usage());
        return Ok(());
    }
    if args.version {
        println!("salt {VERSION}");
        return Ok(());
    }

    let harnesses = args::resolve_harnesses(&args.harness_tokens)?;
    let harnesses = if harnesses.is_empty() { ALL_HARNESSES.to_vec() } else { harnesses };

    // Argument problems must surface before a multi-second scan starts.
    let since = args.since.as_deref().map(since::parse_since).transpose()?;
    let overrides = lexicon::load_overrides(args.lexicon.as_deref())?;
    let matcher = Matcher::new(&overrides);

    let home = dirs::home_dir().ok_or_else(|| anyhow::anyhow!("could not find your home directory"))?;

    if args.json {
        let mut out = scan::scan(&harnesses, &home);
        if let Some(cutoff) = since {
            out.messages.retain(|m| m.ts >= cutoff);
        }
        let report = report::build(out.messages, out.stats, &matcher, VERSION);
        println!("{}", serde_json::to_string(&report)?);
        return Ok(());
    }

    let ui = ui::new();
    ui.intro("salt — how much do you swear at your coding agents?");

    let mut spinner = ui.spinner();
    spinner.begin("Reading local sessions…");
    let started = Instant::now();
    let mut out = {
        let s = &spinner;
        scan::scan_with(&harnesses, &home, |files, total, bytes| {
            s.message(&format!("{files}/{total} files · {} GB", gb(bytes)));
        })
    };
    // The since filter runs after dedup on purpose: a replayed prompt's
    // earliest occurrence may predate the cutoff, and collapsing first keeps
    // it out.
    if let Some(cutoff) = since {
        out.messages.retain(|m| m.ts >= cutoff);
    }
    let elapsed = started.elapsed().as_secs_f64();
    let messages = out.messages.len();
    spinner.stop(&format!(
        "Scanned {} files ({} GB) in {elapsed:.1}s — {messages} messages.",
        out.stats.files_scanned,
        gb(out.stats.bytes_scanned),
    ));

    let report = report::build(out.messages, out.stats, &matcher, VERSION);
    let json = serde_json::to_string(&report)?;

    // Publishing is the only path to the dashboard, so it says plainly what is
    // about to leave the machine. The project names are the part worth naming
    // out loud — nothing else in the report identifies anything.
    ui.log(&format!(
        "Publishing to {} — {} prompts, {} projects by name, no prompt text.",
        publish::host(),
        report.totals.prompts,
        report.projects.len(),
    ));

    let published = publish::publish(&json)?;
    ui.outro(&format!(
        "{}\nAnyone with the link can read it. It expires in {} days.",
        published.url,
        days(published.expires_in_days),
    ));
    if !args.no_open {
        // A browser that will not open is not a reason to fail the run.
        let _ = opener::open(&published.url);
    }
    Ok(())
}
