//! Command-line parsing.
//!
//! Hand-rolled rather than pulled from a crate, because the surface is seven
//! flags and the exit codes are a contract: a usage problem exits 2, anything
//! else exits 1. A parser generator would own that decision.

use crate::types::Harness;

/// A problem with the arguments themselves. Reported bare on stderr, exit 2.
#[derive(Debug)]
pub struct UsageError(pub String);

impl std::fmt::Display for UsageError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for UsageError {}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Args {
    pub json: bool,
    pub no_open: bool,
    pub help: bool,
    pub version: bool,
    /// Raw `--harness` tokens, still unvalidated.
    ///
    /// Validation is deliberately deferred: the TypeScript version resolved
    /// harness names inside the parser, so `salt --help --harness bogus` exited
    /// 2 instead of printing help. Keeping the tokens raw lets `--help` and
    /// `--version` win, which is what someone reaching for `--help` wants.
    pub harness_tokens: Vec<String>,
    pub since: Option<String>,
    pub lexicon: Option<String>,
}

/// `--flag` / `--flag=value` / `--flag value`, no short aliases, no positionals.
///
/// One arm per option. An earlier shape matched the flag name twice — once to
/// decide whether it took a value, then again to pick the field — with a
/// fallthrough on the inner match, so adding an option and forgetting the
/// second half would silently set a different field.
pub fn parse(argv: &[String]) -> Result<Args, UsageError> {
    let mut args = Args::default();
    let mut rest = argv.iter().map(String::as_str);

    while let Some(arg) = rest.next() {
        // Accepted and separates nothing, since there are no positionals.
        if arg == "--" {
            continue;
        }
        if !arg.starts_with('-') {
            return Err(UsageError(format!(
                "Unexpected argument '{arg}'. This command does not take positional arguments"
            )));
        }

        let (name, inline) = match arg.split_once('=') {
            Some((n, v)) => (n, Some(v)),
            None => (arg, None),
        };

        match name {
            "--json" => args.json = bare(name, inline)?,
            "--no-open" => args.no_open = bare(name, inline)?,
            "--help" => args.help = bare(name, inline)?,
            "--version" => args.version = bare(name, inline)?,
            // Repeatable and comma-separated both work.
            "--harness" => args.harness_tokens.extend(
                value(name, inline, &mut rest)?
                    .split(',')
                    .map(str::to_owned),
            ),
            "--since" => args.since = Some(value(name, inline, &mut rest)?.to_owned()),
            "--lexicon" => args.lexicon = Some(value(name, inline, &mut rest)?.to_owned()),
            _ => return Err(UsageError(format!("Unknown option '{name}'"))),
        }
    }

    Ok(args)
}

/// A flag that takes no value.
fn bare(name: &str, inline: Option<&str>) -> Result<bool, UsageError> {
    match inline {
        None => Ok(true),
        Some(_) => Err(UsageError(format!(
            "Option '{name}' does not take an argument"
        ))),
    }
}

/// A flag's value, from `=value` or the next argument.
fn value<'a>(
    name: &str,
    inline: Option<&'a str>,
    rest: &mut impl Iterator<Item = &'a str>,
) -> Result<&'a str, UsageError> {
    inline
        .or_else(|| rest.next())
        .ok_or_else(|| UsageError(format!("Option '{name} <value>' argument missing")))
}

/// Resolves `--harness` tokens, after `--help` and `--version` have had their say.
pub fn resolve_harnesses(tokens: &[String]) -> Result<Vec<Harness>, UsageError> {
    tokens
        .iter()
        .map(|t| {
            Harness::parse(t)
                .ok_or_else(|| UsageError(format!("unknown harness: {}", t.trim().to_lowercase())))
        })
        .collect()
}

pub fn usage() -> &'static str {
    "salt — how much do you swear at your coding agents?

Usage: salt [options]

Options:
  --no-open              Do not launch a browser
  --harness <list>       Limit to claude, codex, cursor (comma-separated)
  --since <date|span>    Only count prompts since 2026-01-01 or 30d
  --json                 Print the report JSON to stdout and exit — nothing is published
  --lexicon <path>       Use an alternate lexicon file
  --help                 Show this help
  --version              Show the version"
}
