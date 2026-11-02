//! Ephemeral presence for clients of the same authenticated workspace server.
//! Labels are display metadata, not authenticated user identities or permissions.
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    time::{Duration, Instant},
};

/// One client's periodic presence report.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Heartbeat {
    /// Random 32-hex-digit ID chosen by the browser tab.
    pub session_id: String,
    /// Display name; not an authenticated identity.
    pub name: String,
    /// Page the client is viewing, if any.
    pub page_id: Option<String>,
    /// Selected layer's selector, if any.
    pub selector: Option<String>,
    /// Pointer position in page coordinates.
    pub cursor: Option<Point>,
    /// True when the tab is closing or switching projects.
    #[serde(default)]
    pub leave: bool,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
/// A position in page coordinates.
pub struct Point {
    /// Horizontal offset in CSS pixels.
    pub x: f64,
    /// Vertical offset in CSS pixels.
    pub y: f64,
}

#[derive(Serialize)]
struct Presence {
    session_id: String,
    name: String,
    project_id: String,
    page_id: Option<String>,
    selector: Option<String>,
    cursor: Option<Point>,
    #[serde(skip)]
    seen: Instant,
}

/// Presence for every project on this server; entries expire after 15 seconds.
#[derive(Default)]
pub struct Room {
    sessions: BTreeMap<String, Presence>,
}

impl Room {
    /// Record or remove one session and return everyone currently on project_id.
    ///
    /// # Errors
    /// Fails on a malformed session ID, name, selection or cursor, or when the room is full.
    pub fn heartbeat(&mut self, project_id: &str, input: Heartbeat) -> Result<Value> {
        ensure!(
            input.session_id.len() == 32 && input.session_id.bytes().all(|c| c.is_ascii_hexdigit()),
            "Invalid session ID"
        );
        ensure!(
            !input.name.trim().is_empty()
                && input.name.chars().count() <= 80
                && !input.name.chars().any(char::is_control),
            "Name must contain 1–80 characters without control characters"
        );
        ensure!(
            input.selector.as_ref().is_none_or(|s| s.len() <= 4096),
            "Selection is too long"
        );
        ensure!(
            input.cursor.as_ref().is_none_or(|p| p.x.is_finite()
                && p.y.is_finite()
                && p.x >= 0.0
                && p.y >= 0.0
                && p.x <= 100_000.0
                && p.y <= 100_000.0),
            "Invalid cursor position"
        );
        let now = Instant::now();
        self.sessions
            .retain(|_, s| now.duration_since(s.seen) < Duration::from_secs(15));
        if input.leave {
            // A delayed leave for a previous project cannot remove its new presence.
            if self
                .sessions
                .get(&input.session_id)
                .is_some_and(|s| s.project_id == project_id)
            {
                self.sessions.remove(&input.session_id);
            }
        } else {
            ensure!(
                self.sessions.contains_key(&input.session_id) || self.sessions.len() < 128,
                "Workspace presence is full; try again shortly"
            );
            self.sessions.insert(
                input.session_id.clone(),
                Presence {
                    session_id: input.session_id,
                    name: input.name.trim().into(),
                    project_id: project_id.into(),
                    page_id: input.page_id,
                    selector: input.selector,
                    cursor: input.cursor,
                    seen: now,
                },
            );
        }
        Ok(serde_json::to_value(
            self.sessions
                .values()
                .filter(|s| s.project_id == project_id)
                .collect::<Vec<_>>(),
        )?)
    }
}

/// An edit named a page revision that is no longer current; the API maps it to HTTP 409.
#[derive(Debug)]
pub struct RevisionConflict {
    /// Revision the client read before editing.
    pub expected: u64,
    /// Revision saved now.
    pub current: u64,
}
impl std::fmt::Display for RevisionConflict {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "Revision conflict: page changed from {} to {}. Your input is preserved; review the latest page before applying it again.",
            self.expected, self.current
        )
    }
}
impl std::error::Error for RevisionConflict {}
