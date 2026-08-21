//! salt — how much do you swear at your coding agents?
//!
//! The binary is a thin shell over this library so integration tests can reach
//! the real code paths; a `[[bin]]` target cannot be imported from `tests/`.

// Nothing here needs to reach past the type system. Stating it as a lint makes
// that a property of the crate rather than of whoever reviews the next patch.
#![forbid(unsafe_code)]

pub mod args;
pub mod db;
pub mod lexicon;
pub mod matcher;
pub mod publish;
pub mod report;
pub mod scan;
pub mod since;
pub mod strip;
pub mod text;
pub mod types;
pub mod ui;
