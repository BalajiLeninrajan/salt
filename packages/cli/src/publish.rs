//! Sends the report to the dashboard.
//!
//! Publishing is the only path to a link, so this is the one place anything
//! leaves the machine. It is a single POST; the payload is ~30 KB.
//!
//! No gzip yet, deliberately. The receiving Worker does not decompress today
//! (`packages/site/worker/index.ts` reads the body straight into `JSON.parse`),
//! so a CLI that compressed first would break every publish until the Worker
//! shipped. The two have to land in that order — Worker first, then this.

use anyhow::{anyhow, bail, Result};

const DEFAULT_HOST: &str = "https://salt.balajileninrajan.dev";

/// Matches the cap the Worker enforces. Duplicated there and here on purpose
/// for now — the shared-constant cleanup is a separate change that touches the
/// site package too.
const MAX_BODY_BYTES: usize = 512 * 1024;

#[derive(Debug)]
pub struct Published {
    pub url: String,
    pub expires_in_days: f64,
}

/// The dashboard host. `SALT_HOST` overrides it; an empty value counts as unset.
pub fn host() -> String {
    let h = match std::env::var("SALT_HOST") {
        Ok(v) if !v.is_empty() => v,
        _ => DEFAULT_HOST.to_string(),
    };
    h.trim_end_matches('/').to_string()
}

pub fn publish(report_json: &str) -> Result<Published> {
    let endpoint = format!("{}/api/publish", host());

    // Checked before the request so an oversized report never leaves the
    // machine at all.
    if report_json.len() > MAX_BODY_BYTES {
        bail!(
            "this report is {} KB, over the 512 KB publishing limit — \
             narrow it with --since, or keep it local with --json",
            report_json.len() / 1024
        );
    }

    // A refusal carries its reason in the body, so the status must not be
    // turned into an error that throws that body away.
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .http_status_as_error(false)
        .build()
        .into();

    let mut response = agent
        .post(&endpoint)
        .header("content-type", "application/json")
        .send(report_json)
        .map_err(|_| {
            anyhow!("could not reach {endpoint} — check your connection, or use --json")
        })?;

    let status = response.status().as_u16();
    let body = response
        .body_mut()
        .read_to_string()
        .map_err(|_| anyhow!("could not read the response from {endpoint}"))?;

    if !(200..300).contains(&status) {
        // The Worker answers with `{"error": "..."}`; anything else is passed
        // through raw so a proxy's HTML at least reaches the user.
        let explanation = serde_json::from_str::<serde_json::Value>(&body)
            .ok()
            .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(str::to_string))
            .unwrap_or_else(|| body.trim().to_string());
        if explanation.is_empty() {
            bail!("{endpoint} rejected the report with HTTP {status}");
        }
        bail!("{endpoint} rejected the report (HTTP {status}): {explanation}");
    }

    let parsed: serde_json::Value = serde_json::from_str(&body)
        .map_err(|_| anyhow!("the publishing endpoint returned something that is not a link"))?;

    // The server also returns an `id`; the CLI has no use for it.
    let url = parsed.get("url").and_then(|v| v.as_str());
    let days = parsed.get("expires_in_days").and_then(serde_json::Value::as_f64);
    match (url, days) {
        (Some(url), Some(expires_in_days)) => {
            Ok(Published { url: url.to_string(), expires_in_days })
        }
        _ => Err(anyhow!("the publishing endpoint returned something that is not a link")),
    }
}
