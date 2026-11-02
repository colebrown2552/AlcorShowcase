//! Guarded recapture of live pages, plus the durable receipts and snapshot archive that
//! make a refresh safe to interrupt. The merge functions do no network work: the caller
//! renders the live URL and atomically replaces the page only after `finish` succeeds.
use crate::app::Page;
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;

/// A page may be refreshed only from its own project's HTTPS site on the default port.
fn checked_live_url(source: &Value, page: &Page) -> Result<()> {
    ensure!(
        matches!(source["kind"].as_str(), Some("github" | "site")),
        "Live refresh requires an imported website project, not an HTML-only snapshot"
    );
    let site = source["url"]
        .as_str()
        .and_then(|s| url::Url::parse(s).ok())
        .context("The project has no valid site URL")?;
    let url = url::Url::parse(&page.url).context("The saved page has no valid live URL")?;
    ensure!(
        url.scheme() == "https"
            && url.origin() == site.origin()
            && url.username().is_empty()
            && url.password().is_none()
            && url.port_or_known_default() == Some(443),
        "Live refresh is limited to pages on the project's own HTTPS site"
    );
    Ok(())
}

fn has_local_canvas_changes(page: &Page) -> bool {
    !page.edits.is_empty() || !page.history.is_empty() || !page.future.is_empty()
}

fn valid_commit(value: &str) -> bool {
    value.len() == 40 && value.bytes().all(|c| c.is_ascii_hexdigit())
}

/// Digest the captured design state, excluding comments and discovery metadata
/// which may legitimately change while the canvas stays untouched.
pub fn baseline(page: &Page) -> String {
    let bytes = serde_json::to_vec(&serde_json::json!({"html":page.html,"nodes":page.nodes,
        "viewport":page.viewport,"screenshot":page.screenshot}))
    .expect("Page is serializable");
    ring::digest::digest(&ring::digest::SHA256, &bytes)
        .as_ref()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn digest(bytes: &[u8]) -> String {
    ring::digest::digest(&ring::digest::SHA256, bytes)
        .as_ref()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Stable, bounded child ID even when a valid page ID is 128 bytes long.
pub fn batch_request_id(job_id: &str, page_id: &str) -> String {
    let basis = serde_json::to_vec(&[job_id, page_id]).expect("IDs are serializable");
    format!("refresh/{}", digest(&basis))
}

fn checked_id(value: &str, label: &str) -> Result<()> {
    ensure!(
        !value.is_empty()
            && value.len() <= 128
            && value
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_')),
        "Invalid {label}"
    );
    Ok(())
}

fn checked_request_id(value: &str) -> Result<()> {
    ensure!((8..=128).contains(&value.len()) && value.bytes().all(|b|
        b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b':' | b'/')),
        "A unique request_id of 8–128 letters, digits, or -_.:/ is required");
    Ok(())
}

fn project_directory(data: &Path, project_id: &str) -> Result<PathBuf> {
    checked_id(project_id, "project ID")?;
    Ok(data.join("projects").join(project_id))
}

fn operation_path(data: &Path, project_id: &str, request_id: &str) -> Result<PathBuf> {
    checked_request_id(request_id)?;
    Ok(project_directory(data, project_id)?
        .join("live-refresh-operations")
        .join(format!("{}.json", digest(request_id.as_bytes()))))
}

fn timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

/// Persist a reservation before any capture or page replacement. Duplicate
/// IDs return the prior record; changed inputs under the same ID are rejected.
pub fn reserve(
    data: &Path,
    project_id: &str,
    request_id: &str,
    action: &str,
    input: &Value,
    job_id: Option<&str>,
) -> Result<(bool, Value)> {
    let path = operation_path(data, project_id, request_id)?;
    fs::create_dir_all(path.parent().context("Operation directory missing")?)?;
    let fingerprint = digest(&serde_json::to_vec(
        &json!({"action":action,"input":input}),
    )?);
    let record = json!({"request_id":request_id,"project_id":project_id,"action":action,"fingerprint":fingerprint,
        "input":input,"state":"pending","job_id":job_id,"started_at":timestamp(),"result":null});
    match fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
    {
        Ok(mut file) => {
            file.write_all(&serde_json::to_vec(&record)?)?;
            file.sync_all()?;
            Ok((true, record))
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            let old: Value = serde_json::from_slice(&fs::read(path)?)
                .context("Refresh operation receipt is unreadable; do not replay")?;
            ensure!(
                old["request_id"] == request_id && old["fingerprint"] == fingerprint,
                "request_id was already used for a different live-refresh operation"
            );
            Ok((false, old))
        }
        Err(e) => Err(e.into()),
    }
}

/// Read the durable record for one refresh or restore request.
///
/// # Errors
/// Fails on invalid IDs or a missing record.
pub fn operation(data: &Path, project_id: &str, request_id: &str) -> Result<Value> {
    let path = operation_path(data, project_id, request_id)?;
    if !path.exists() {
        return Ok(json!({"request_id":request_id,"project_id":project_id,"state":"not_found"}));
    }
    let value: Value = serde_json::from_slice(&fs::read(path)?)
        .context("Refresh operation receipt is unreadable; do not replay")?;
    ensure!(
        value["request_id"] == request_id && value["project_id"] == project_id,
        "Refresh operation identity mismatch"
    );
    Ok(value)
}

/// Finish a pending request with its final state and result; finished records never change.
///
/// # Errors
/// Fails when the record is missing or cannot be written.
pub fn complete(
    data: &Path,
    project_id: &str,
    request_id: &str,
    state: &str,
    result: Value,
) -> Result<Value> {
    ensure!(
        matches!(state, "completed" | "conflict" | "failed" | "partial"),
        "Invalid refresh operation state"
    );
    let path = operation_path(data, project_id, request_id)?;
    let mut value = operation(data, project_id, request_id)?;
    ensure!(
        value["state"] == "pending",
        "Refresh operation is not pending"
    );
    value["state"] = json!(state);
    value["result"] = result;
    value["completed_at"] = json!(timestamp());
    write_atomic(&path, &value)?;
    Ok(value)
}

/// Persist bounded job progress without completing or re-dispatching it.
pub fn progress(data: &Path, project_id: &str, request_id: &str, result: Value) -> Result<()> {
    let path = operation_path(data, project_id, request_id)?;
    let mut value = operation(data, project_id, request_id)?;
    ensure!(
        value["state"] == "pending",
        "Refresh operation is not pending"
    );
    value["result"] = result;
    value["updated_at"] = json!(timestamp());
    write_atomic(&path, &value)
}

fn write_atomic(path: &Path, value: &impl serde::Serialize) -> Result<()> {
    let parent = path.parent().context("Destination directory missing")?;
    fs::create_dir_all(parent)?;
    let temp = parent.join(format!(".refresh-{}.tmp", Uuid::new_v4().simple()));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)?;
    file.write_all(&serde_json::to_vec(value)?)?;
    file.sync_all()?;
    drop(file);
    fs::rename(temp, path)?;
    Ok(())
}

/// Save a complete immutable copy before replacing a legacy or edited page.
/// The screenshot URL continues to point to the original saved PNG.
pub fn archive(data: &Path, project_id: &str, page: &Page, reason: &str) -> Result<String> {
    checked_id(&page.id, "page ID")?;
    let directory = project_directory(data, project_id)?
        .join("live-refresh-snapshots")
        .join(&page.id);
    fs::create_dir_all(&directory)?;
    // In addition to the app's edit lock, serialize allocation across
    // cooperating processes sharing this local snapshot directory. The OS
    // releases the advisory lock when the handle closes, including on crash.
    let lock = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .open(directory.join(".archive.lock"))?;
    lock.try_lock()
        .map_err(|error| anyhow::anyhow!("Snapshot store is busy: {error}"))?;
    // Derive the next order from immutable snapshots so it survives a restart
    // and also advances if the wall clock moves backwards.
    let previous = snapshots(data, project_id, &page.id)?;
    let last = previous["snapshots"]
        .as_array()
        .context("Invalid snapshot list")?
        .iter()
        .map(snapshot_order)
        .max()
        .unwrap_or(0);
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
        .try_into()
        .unwrap_or(u64::MAX);
    let order = now.max(last.checked_add(1).context("Snapshot order exhausted")?);
    let id = Uuid::new_v4().simple().to_string();
    let path = directory.join(format!("{id}.json"));
    ensure!(!path.exists(), "Snapshot ID already exists");
    write_atomic(
        &path,
        &json!({"snapshot_id":id,"project_id":project_id,"page_id":page.id,
        "created_at":timestamp(),"created_at_order_ns":order,"reason":reason,"page":page}),
    )?;
    Ok(id)
}

/// List the archived captures of one page, newest first.
///
/// # Errors
/// Fails on invalid IDs or unreadable archives.
pub fn snapshots(data: &Path, project_id: &str, page_id: &str) -> Result<Value> {
    checked_id(page_id, "page ID")?;
    let path = project_directory(data, project_id)?
        .join("live-refresh-snapshots")
        .join(page_id);
    if !path.exists() {
        return Ok(json!({"project_id":project_id,"page_id":page_id,"snapshots":[]}));
    }
    let mut rows = Vec::new();
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(stem) = name.strip_suffix(".json") else {
            continue;
        };
        if stem.len() != 32 || !stem.bytes().all(|b| b.is_ascii_hexdigit()) {
            continue;
        }
        let raw = fs::read(entry.path())?;
        let row: Value = serde_json::from_slice(&raw)?;
        ensure!(
            row["project_id"] == project_id && row["page_id"] == page_id,
            "Snapshot identity mismatch"
        );
        rows.push(json!({"snapshot_id":row["snapshot_id"],"revision":row["page"]["revision"],"commit":row["page"]["commit"],
            "created_at":row["created_at"],"created_at_order_ns":row["created_at_order_ns"],"reason":row["reason"],"comment_count":row["page"]["comments"].as_array().map_or(0,Vec::len)}));
    }
    rows.sort_by(|a, b| {
        snapshot_order(b)
            .cmp(&snapshot_order(a))
            .then_with(|| a["snapshot_id"].as_str().cmp(&b["snapshot_id"].as_str()))
    });
    Ok(json!({"project_id":project_id,"page_id":page_id,"snapshots":rows}))
}

// Legacy snapshots only recorded whole seconds. Their relative order within
// a second is unknowable, so the ID tie-break remains deterministic only.
fn snapshot_order(row: &Value) -> u64 {
    row["created_at_order_ns"].as_u64().unwrap_or_else(|| {
        row["created_at"]
            .as_u64()
            .unwrap_or(0)
            .saturating_mul(1_000_000_000)
    })
}

/// Load one archived capture.
///
/// # Errors
/// Fails when the snapshot is missing or does not belong to the page.
pub fn snapshot(data: &Path, project_id: &str, page_id: &str, snapshot_id: &str) -> Result<Page> {
    checked_id(page_id, "page ID")?;
    ensure!(
        snapshot_id.len() == 32 && snapshot_id.bytes().all(|b| b.is_ascii_hexdigit()),
        "Invalid snapshot ID"
    );
    let path = project_directory(data, project_id)?
        .join("live-refresh-snapshots")
        .join(page_id)
        .join(format!("{snapshot_id}.json"));
    let row: Value = serde_json::from_slice(&fs::read(path).context("Snapshot not found")?)?;
    ensure!(
        row["snapshot_id"] == snapshot_id
            && row["project_id"] == project_id
            && row["page_id"] == page_id,
        "Snapshot identity mismatch"
    );
    let page: Page = serde_json::from_value(row["page"].clone())?;
    ensure!(page.id == page_id, "Snapshot page identity mismatch");
    Ok(page)
}

/// Restore an archived canvas without replacing current comment threads. The
/// caller archives `current` first and commits the returned page atomically.
pub fn restored(saved: &Page, current: &Page, expected_revision: u64) -> Result<Page> {
    ensure!(
        current.revision == expected_revision,
        "Revision conflict: page changed from {expected_revision} to {}",
        current.revision
    );
    ensure!(
        saved.id == current.id && saved.url == current.url,
        "Snapshot no longer belongs to this page"
    );
    let mut page = saved.clone();
    page.revision = expected_revision
        .checked_add(1)
        .context("Page revision overflow")?;
    page.comments = current.comments.clone();
    page.discovery = current.discovery.clone();
    // Keep all already-committed receipt proofs even when an older archive is restored.
    page.live_refresh_history = current.live_refresh_history.clone();
    comment_warnings(&mut page);
    Ok(page)
}

/// Recompute after merging the very latest comments under the project lock.
pub fn comment_warnings(page: &mut Page) {
    page.warnings.retain(|w| {
        !w.starts_with("Comment pins retain their original coordinates;")
            && !w.contains("comment pin(s) fall outside the refreshed page;")
    });
    if page.comments.is_empty() {
        return;
    }
    page.warnings.push(
        "Comment pins retain their original coordinates; the page layout may have changed".into(),
    );
    let width = page.viewport["width"].as_f64().unwrap_or(0.0);
    let height = page.viewport["height"].as_f64().unwrap_or(0.0);
    let outside = page
        .comments
        .iter()
        .filter(
            |comment| match (comment["x"].as_f64(), comment["y"].as_f64()) {
                (Some(x), Some(y)) => x < 0.0 || y < 0.0 || x > width || y > height,
                _ => true,
            },
        )
        .count();
    if outside > 0 {
        page.warnings.push(format!("{outside} comment pin(s) fall outside the refreshed page; their coordinates and threads were preserved"));
    }
}

/// True when the page still matches the digest recorded by its last clean live capture.
pub fn known_clean(page: &Page) -> bool {
    !has_local_canvas_changes(page)
        && (page.commit.is_empty() || valid_commit(&page.commit))
        && !page.live_baseline.is_empty()
        && page.live_baseline == baseline(page)
}

/// Reserve headroom for one Chromium capture without disturbing other work.
pub const MIN_RENDER_AVAILABLE: u64 = 600 * 1024 * 1024;

/// Free physical memory in bytes, or `None` when the platform cannot report it.
#[cfg(windows)]
pub fn available_physical_memory() -> Option<u64> {
    #[repr(C)]
    struct MemoryStatus {
        length: u32,
        load: u32,
        total_phys: u64,
        avail_phys: u64,
        total_page: u64,
        avail_page: u64,
        total_virtual: u64,
        avail_virtual: u64,
        avail_extended: u64,
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GlobalMemoryStatusEx(status: *mut MemoryStatus) -> i32;
    }
    let mut status = MemoryStatus {
        length: std::mem::size_of::<MemoryStatus>() as u32,
        load: 0,
        total_phys: 0,
        avail_phys: 0,
        total_page: 0,
        avail_page: 0,
        total_virtual: 0,
        avail_virtual: 0,
        avail_extended: 0,
    };
    // The structure has the Windows MEMORYSTATUSEX layout and length required
    // by the API. It contains no pointers and is exclusively borrowed here.
    if unsafe { GlobalMemoryStatusEx(&mut status) } == 0 {
        None
    } else {
        Some(status.avail_phys)
    }
}

/// Free physical memory in bytes, or `None` when the platform cannot report it.
#[cfg(target_os = "linux")]
pub fn available_physical_memory() -> Option<u64> {
    let data = fs::read_to_string("/proc/meminfo").ok()?;
    let line = data
        .lines()
        .find(|line| line.starts_with("MemAvailable:"))?;
    line.split_whitespace()
        .nth(1)?
        .parse::<u64>()
        .ok()?
        .checked_mul(1024)
}

/// Free physical memory in bytes, or `None` when the platform cannot report it.
#[cfg(not(any(windows, target_os = "linux")))]
pub fn available_physical_memory() -> Option<u64> {
    None
}

/// Refuse to start Chromium when free physical memory is unknown or below the minimum.
///
/// # Errors
/// Fails closed when memory is insufficient or cannot be measured.
pub fn check_render_memory(available: Option<u64>) -> Result<()> {
    let available = available
        .context("Available physical memory could not be determined; the page was not changed")?;
    ensure!(
        available >= MIN_RENDER_AVAILABLE,
        "Not enough available physical memory for a Chromium refresh (need at least 600 MiB); the page was not changed"
    );
    Ok(())
}

/// True when a batch result means later pages must not be refreshed.
pub fn batch_should_stop(row: &Value) -> bool {
    matches!(
        row["result"]["code"].as_str(),
        Some(
            "preview_commit_changed"
                | "preview_commit_unavailable"
                | "insufficient_memory"
                | "memory_unavailable"
        )
    )
}

/// Check before rendering. Any local canvas edits or undo/redo history are a
/// conflict: refreshing must not discard them, even if a page was later undone.
pub fn preflight(
    source: &Value,
    page: &Page,
    expected_revision: u64,
    keep_snapshot: bool,
) -> Result<()> {
    checked_live_url(source, page)?;
    ensure!(
        page.revision == expected_revision,
        "Revision conflict: page changed from {expected_revision} to {}",
        page.revision
    );
    ensure!(
        keep_snapshot || known_clean(page),
        "Live refresh conflict: this page has local edits or an unverified legacy baseline; archive its current design before refreshing"
    );
    Ok(())
}

/// Validate the live render and merge it with the latest saved comment state.
/// `snapshot` is the page checked before the network call, `current` is read
/// again under the edit lock, and `fresh` must be captured from the URL without
/// passing the old HTML. The caller must clear the input clone's old commit so a
/// missing HTTP commit header cannot accidentally be represented as a new one.
pub fn finish(
    source: &Value,
    snapshot: &Page,
    current: &Page,
    mut fresh: Page,
    expected_revision: u64,
    expected_commit: Option<&str>,
    keep_snapshot: bool,
) -> Result<Page> {
    preflight(source, snapshot, expected_revision, keep_snapshot)?;
    preflight(source, current, expected_revision, keep_snapshot)?;
    ensure!(
        snapshot.id == current.id && snapshot.url == current.url,
        "Page identity changed during live refresh"
    );
    ensure!(
        fresh.id == current.id && fresh.url == current.url,
        "Rendered page identity does not match the saved page"
    );
    let next = expected_revision
        .checked_add(1)
        .context("Page revision overflow")?;
    ensure!(
        fresh.revision == next && fresh.status == "ready",
        "Live render did not produce the expected new page revision"
    );
    ensure!(
        !has_local_canvas_changes(&fresh),
        "Live render unexpectedly contains canvas edits or history"
    );
    // Sites that report their deployed commit must report a well-formed one; a pinned
    // batch additionally requires every page to come from the same commit.
    ensure!(
        (fresh.commit.is_empty() && expected_commit.is_none()) || valid_commit(&fresh.commit),
        "Live site did not return a valid deployed commit; saved page was preserved"
    );
    ensure!(
        known_clean(&fresh),
        "Live render did not record a verified clean baseline"
    );
    if let Some(expected) = expected_commit {
        ensure!(
            valid_commit(expected),
            "Expected deployed commit must be a full Git SHA"
        );
        ensure!(
            fresh.commit.eq_ignore_ascii_case(expected),
            "Live site commit changed during refresh; saved page was preserved"
        );
    }
    let width = fresh.viewport["width"]
        .as_f64()
        .context("Live render omitted page width")?;
    let height = fresh.viewport["height"]
        .as_f64()
        .context("Live render omitted page height")?;
    ensure!(
        width.is_finite() && width > 0.0 && height.is_finite() && height > 0.0,
        "Live render produced invalid page dimensions"
    );
    // Comments may change independently during capture without changing the
    // page revision. Preserve the latest complete values, including coordinates.
    fresh.comments = current.comments.clone();
    fresh.discovery = current.discovery.clone();
    comment_warnings(&mut fresh);
    Ok(fresh)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const COMMIT: &str = "0123456789abcdef0123456789abcdef01234567";
    #[test]
    fn batch_request_ids_stay_bounded_for_maximum_page_ids() {
        let page = "x".repeat(128);
        let id = batch_request_id(&"y".repeat(128), &page);
        assert!(checked_request_id(&id).is_ok());
        assert_eq!(id, batch_request_id(&"y".repeat(128), &page));
        assert_ne!(id, batch_request_id(&"y".repeat(128), &"z".repeat(128)));
    }
    fn source() -> Value {
        json!({"kind":"github","url":"https://www.example.com"})
    }
    fn page() -> Page {
        let mut p:Page=serde_json::from_value(json!({"id":"page-1","title":"Page","url":"https://www.example.com/about/",
            "status":"ready","viewport":{"width":1440,"height":900},"screenshot":"/files/old.png","revision":7,
            "nodes":[],"html":"<p>old</p>","commit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "comments":[{"id":"one","x":90.25,"y":800,"body":"Preserve me","replies":[]}],
            "discovery":{"sitemap_status":"listed"}})).unwrap();
        p.live_baseline = baseline(&p);
        p
    }
    fn fresh(old: &Page) -> Page {
        let mut value = old.clone();
        value.revision += 1;
        value.commit = COMMIT.into();
        value.html = "<p>fresh</p>".into();
        value.screenshot = "/files/new.png".into();
        value.live_baseline = baseline(&value);
        value
    }
    #[test]
    fn preserves_latest_comments_exactly_and_warns_for_out_of_bounds_pins() {
        let snapshot = page();
        let mut current = snapshot.clone();
        current.comments.push(
            json!({"id":"two","x":50,"y":1200,"body":"new reply","replies":[{"body":"hello"}]}),
        );
        let expected = serde_json::to_vec(&current.comments).unwrap();
        let merged = finish(
            &source(),
            &snapshot,
            &current,
            fresh(&snapshot),
            7,
            Some(COMMIT),
            false,
        )
        .unwrap();
        assert_eq!(serde_json::to_vec(&merged.comments).unwrap(), expected);
        assert_eq!(merged.id, snapshot.id);
        assert_eq!(merged.discovery, current.discovery);
        assert_eq!(merged.commit, COMMIT);
        assert_eq!(merged.revision, 8);
        assert!(merged.warnings.iter().any(|w| w.contains("1 comment pin")));
    }
    #[test]
    fn rejects_each_kind_of_canvas_history_without_mutating_it() {
        for key in ["edits", "history", "future"] {
            let mut p = page();
            match key {
                "edits" => p.edits.push(json!({"text":"changed"})),
                "history" => p.history.push("old edit".into()),
                _ => p.future.push("redo".into()),
            }
            let before = serde_json::to_vec(&p).unwrap();
            assert!(preflight(&source(), &p, 7, false).is_err());
            assert!(preflight(&source(), &p, 7, true).is_ok());
            assert_eq!(serde_json::to_vec(&p).unwrap(), before);
        }
    }
    #[test]
    fn rejects_stale_revisions_and_page_identity_changes() {
        let original = page();
        let mut current = original.clone();
        current.revision = 8;
        assert!(
            finish(
                &source(),
                &original,
                &current,
                fresh(&original),
                7,
                None,
                false
            )
            .is_err()
        );
        let mut changed = fresh(&original);
        changed.id = "different".into();
        assert!(finish(&source(), &original, &original, changed, 7, None, false).is_err());
        assert!(preflight(&source(), &original, 6, false).is_err());
    }
    #[test]
    fn reported_commits_are_validated_and_can_pin_a_whole_job() {
        let original = page();
        let mut missing = fresh(&original);
        missing.commit.clear();
        // A site that reports no commit can still be refreshed, but not under a pinned commit.
        assert!(
            finish(
                &source(),
                &original,
                &original,
                missing.clone(),
                7,
                None,
                false
            )
            .is_ok()
        );
        assert!(
            finish(
                &source(),
                &original,
                &original,
                missing,
                7,
                Some(COMMIT),
                false
            )
            .is_err()
        );
        let mut malformed = fresh(&original);
        malformed.commit = "not-a-commit".into();
        assert!(finish(&source(), &original, &original, malformed, 7, None, false).is_err());
        assert!(
            finish(
                &source(),
                &original,
                &original,
                fresh(&original),
                7,
                Some("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
                false
            )
            .is_err()
        );
        assert!(
            finish(
                &source(),
                &original,
                &original,
                fresh(&original),
                7,
                Some("invalid"),
                false
            )
            .is_err()
        );
    }
    #[test]
    fn refuses_html_snapshots_and_other_hosts() {
        let mut p = page();
        assert!(preflight(&json!({"kind":"html"}), &p, 7, false).is_err());
        p.url = "https://example.com/".into();
        assert!(preflight(&source(), &p, 7, false).is_err());
        p.url = "https://www.example.com:8443/".into();
        assert!(preflight(&source(), &p, 7, false).is_err());
    }
    #[test]
    fn legacy_or_modified_baselines_require_explicit_snapshot() {
        let mut p = page();
        p.live_baseline.clear();
        assert!(preflight(&source(), &p, 7, false).is_err());
        assert!(preflight(&source(), &p, 7, true).is_ok());
        p.live_baseline = baseline(&p);
        p.html.push_str("changed");
        assert!(preflight(&source(), &p, 7, false).is_err());
    }
    #[test]
    fn changed_deploy_commit_stops_batch_before_remaining_pages() {
        let changed = json!({"state":"conflict","result":{"code":"preview_commit_changed"}});
        let local = json!({"state":"conflict","result":{"code":"local_or_legacy_conflict"}});
        let unavailable =
            json!({"state":"conflict","result":{"code":"preview_commit_unavailable"}});
        assert!(batch_should_stop(&changed));
        assert!(batch_should_stop(&unavailable));
        assert!(batch_should_stop(
            &json!({"result":{"code":"insufficient_memory"}})
        ));
        assert!(!batch_should_stop(&local));
    }
    #[test]
    fn refresh_memory_preflight_uses_injected_values_and_fails_closed() {
        assert!(check_render_memory(Some(MIN_RENDER_AVAILABLE)).is_ok());
        assert!(check_render_memory(Some(MIN_RENDER_AVAILABLE - 1)).is_err());
        assert!(check_render_memory(None).is_err());
    }
    #[test]
    fn immutable_archive_and_receipt_replay_preserve_comments_and_history() -> Result<()> {
        let parent = std::env::temp_dir().join("alcor-design-tests");
        fs::create_dir_all(&parent)?;
        let dir = parent.join(format!("live-refresh-test-{}", Uuid::new_v4().simple()));
        fs::create_dir(&dir)?;
        let run = (|| -> Result<()> {
            let mut old = page();
            old.edits.push(json!({"text":"local design"}));
            old.history.push("undo state".into());
            let old_bytes = serde_json::to_vec(&old)?;
            let id = archive(&dir, "project-1", &old, "before_live_refresh")?;
            let archived = snapshot(&dir, "project-1", "page-1", &id)?;
            assert_eq!(serde_json::to_vec(&archived)?, old_bytes);
            assert_eq!(
                snapshots(&dir, "project-1", "page-1")?["snapshots"]
                    .as_array()
                    .unwrap()
                    .len(),
                1
            );
            let input = json!({"page_id":"page-1","expected_revision":7,"keep_snapshot":true});
            let (created, _) = reserve(&dir, "project-1", "request-test-1", "page", &input, None)?;
            assert!(created);
            let (created, _) = reserve(&dir, "project-1", "request-test-1", "page", &input, None)?;
            assert!(!created);
            assert!(
                reserve(
                    &dir,
                    "project-1",
                    "request-test-1",
                    "page",
                    &json!({"page_id":"other"}),
                    None
                )
                .is_err()
            );
            complete(
                &dir,
                "project-1",
                "request-test-1",
                "completed",
                json!({"snapshot_id":id}),
            )?;
            assert_eq!(
                operation(&dir, "project-1", "request-test-1")?["state"],
                "completed"
            );
            let mut current = fresh(&old);
            current.edits.clear();
            current.history.clear();
            current.future.clear();
            current
                .comments
                .push(json!({"id":"new","x":5,"y":6,"body":"later"}));
            current
                .live_refresh_history
                .insert("later-op".into(), json!({"revision":8}));
            let previous = serde_json::to_vec(&current.comments)?;
            let recovered = restored(&archived, &current, 8)?;
            assert_eq!(serde_json::to_vec(&recovered.comments)?, previous);
            assert_eq!(recovered.revision, 9);
            assert_eq!(recovered.history, old.history);
            assert!(recovered.live_refresh_history.contains_key("later-op"));
            assert!(restored(&archived, &current, 7).is_err());
            Ok(())
        })();
        // Only this explicitly created test directory, within the intended
        // private fixture parent, may be removed recursively.
        let resolved = dir.canonicalize()?;
        let expected = parent.canonicalize()?;
        ensure!(
            resolved.parent() == Some(expected.as_path())
                && resolved
                    .file_name()
                    .is_some_and(|v| v.to_string_lossy().starts_with("live-refresh-test-")),
            "Invalid test cleanup target"
        );
        fs::remove_dir_all(resolved)?;
        run
    }
}
