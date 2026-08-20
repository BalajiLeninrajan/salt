//! User overrides for the profanity lexicon.
//!
//! Nobody should have to fork the binary to fix a false positive, so the
//! matcher is configurable at `~/.config/salt/lexicon.toml`:
//!
//! ```toml
//! remove = ["hell"]            # stop counting these
//! allow  = ["cassowary"]       # innocent words to never match inside
//!
//! [add]
//! blast = "mild"               # word = tier
//! ```

use std::collections::BTreeMap;
use std::io::ErrorKind;
use std::path::PathBuf;

use anyhow::{anyhow, Result};
use serde::Deserialize;

use crate::matcher::Overrides;
use crate::types::Tier;

/// The file as serde sees it. Every field defaults when absent, so a lexicon
/// may set only the sections it cares about, but a field that is *present*
/// with the wrong type fails deserialisation and rejects the whole file —
/// silently ignoring a malformed lexicon would produce a wrong report.
/// Unknown top-level keys are ignored, as they were in v1.
#[derive(Deserialize, Default)]
struct File {
    /// Ordered by key rather than by document position: `toml` only preserves
    /// document order behind its `preserve_order` feature. The order is
    /// observable only when two keys differ solely in case (`Blast` vs
    /// `blast`), since the matcher lets the first insertion win.
    #[serde(default)]
    add: BTreeMap<String, String>,
    #[serde(default)]
    remove: Vec<String>,
    #[serde(default)]
    allow: Vec<String>,
}

pub fn default_path() -> PathBuf {
    // No XDG_CONFIG_HOME handling: v1 hardcoded `~/.config` and the path is
    // part of the documented contract.
    dirs::home_dir()
        .unwrap_or_default()
        .join(".config/salt/lexicon.toml")
}

/// Tier names are trimmed with Unicode `str::trim` and folded ASCII-only, both
/// inherited from v1: `"\u{85}mild"` parses because NEL is White_Space, while
/// `"\u{feff}mild"` does not.
fn parse_tier(s: &str) -> Option<Tier> {
    Tier::parse(&s.trim().to_ascii_lowercase())
}

/// Loads overrides from `path`. A missing *default* file is not an error; a
/// missing explicit one is, because the user asked for it by name.
pub fn load_overrides(path: Option<&str>) -> Result<Overrides> {
    let explicit = path.is_some();
    let p = path.map(PathBuf::from).unwrap_or_else(default_path);

    let body = match std::fs::read_to_string(&p) {
        Ok(body) => body,
        Err(e) if !explicit && e.kind() == ErrorKind::NotFound => return Ok(Overrides::default()),
        Err(_) => return Err(anyhow!("could not read lexicon at {}", p.display())),
    };

    let file: File =
        toml::from_str(&body).map_err(|_| anyhow!("could not parse lexicon at {}", p.display()))?;

    Ok(Overrides {
        // An unknown tier drops just that entry — a typo in one line should not
        // cost the user the rest of their lexicon.
        add: file
            .add
            .into_iter()
            .filter_map(|(word, tier)| Some((word.to_ascii_lowercase(), parse_tier(&tier)?)))
            .collect(),
        remove: file.remove,
        allow: file.allow,
    })
}
