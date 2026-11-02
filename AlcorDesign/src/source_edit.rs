//! Isolated, review-branch-only source editing.
//!
//! CSS and PHP drafts are saved under the data directory and pushed only to a dedicated
//! `alcordesign/<project>` branch of the configured GitHub repository. Git runs against an
//! app-private bare cache, so the configured checkout, its index and worktree are never modified.
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};
use uuid::Uuid;

const MAX_SOURCE: usize = 2_000_000;

#[derive(Debug)]
struct GitFailure {
    definitive_rejection: bool,
}
impl std::fmt::Display for GitFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Git operation failed; check repository access or branch state")
    }
}
impl std::error::Error for GitFailure {}

#[derive(Clone, Serialize, Deserialize)]
struct Draft {
    content: String,
    version: String,
    base_sha: String,
    base_blob: String,
    mode: String,
    provenance: Value,
    dirty: bool,
}
#[derive(Clone, Serialize, Deserialize)]
struct Change {
    path: String,
    version: String,
    blob: String,
}
#[derive(Clone, Serialize, Deserialize)]
struct Pending {
    transaction_id: String,
    #[serde(default)]
    requested_base: String,
    #[serde(default)]
    draft_set_version: String,
    commit: String,
    previous_remote: Option<String>,
    changes: Vec<Change>,
    state: String,
}
fn pending_json(pending: &Pending) -> Value {
    let mut result = json!(pending);
    result["request_id"] = json!(pending.transaction_id);
    result
}
#[derive(Clone, Serialize, Deserialize)]
struct SaveReceipt {
    path: String,
    expected_version: String,
    content_blob: String,
    result: Value,
}
#[derive(Clone, Serialize, Deserialize)]
struct SyncReceipt {
    base_branch: String,
    #[serde(default)]
    draft_set_version: String,
    result: Value,
}
#[derive(Clone, Serialize, Deserialize)]
struct SyncReservation {
    base_branch: String,
    #[serde(default)]
    draft_set_version: String,
    files: BTreeMap<String, String>,
}
fn draft_versions(state: &State) -> BTreeMap<String, String> {
    state
        .files
        .iter()
        .filter(|(_, draft)| draft.dirty)
        .map(|(path, draft)| (path.clone(), draft.version.clone()))
        .collect()
}
fn draft_set_version(files: &BTreeMap<String, String>) -> String {
    let bytes = serde_json::to_vec(files).expect("Draft versions are serializable");
    ring::digest::digest(&ring::digest::SHA256, &bytes)
        .as_ref()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
fn checked_draft_set_version(value: &str) -> Result<()> {
    ensure!(
        value.len() == 64
            && value
                .bytes()
                .all(|b| b.is_ascii_digit() || matches!(b, b'a'..=b'f')),
        "A valid 64-character lowercase draft_set_version is required"
    );
    Ok(())
}
#[derive(Serialize, Deserialize)]
struct State {
    project_id: String,
    branch: String,
    base_branch: Option<String>,
    #[serde(default)]
    files: BTreeMap<String, Draft>,
    #[serde(default)]
    save_receipts: BTreeMap<String, SaveReceipt>,
    #[serde(default)]
    sync_receipts: BTreeMap<String, SyncReceipt>,
    #[serde(default)]
    sync_reservations: BTreeMap<String, SyncReservation>,
    pending_sync: Option<Pending>,
    last_sync: Option<Value>,
}
fn checked_request_id(id: &str) -> Result<()> {
    ensure!((8..=128).contains(&id.len()) && id.bytes().all(|b|b.is_ascii_alphanumeric()||matches!(b,b'-'|b'_'|b'.'|b':'|b'/')),
        "A unique request_id of 8–128 letters, digits, or -_.:/ is required");
    Ok(())
}

fn checked_project(project: &str) -> Result<()> {
    ensure!(
        !project.is_empty()
            && project.len() <= 128
            && project
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'),
        "Invalid project identifier"
    );
    Ok(())
}
fn checked_path(path: &str, root: &str) -> Result<()> {
    ensure!(
        !path.is_empty()
            && path.len() <= 4096
            && !path.starts_with('/')
            && !path.contains(['\\', ':', '\0'])
            && !path.chars().any(char::is_control)
            && path.split('/').all(|part| !part.is_empty()
                && part != "."
                && part != ".."
                && !part.eq_ignore_ascii_case(".git")),
        "Invalid repository source path"
    );
    ensure!(
        root.is_empty() || path.starts_with(&format!("{root}/")),
        "Source path is outside the editable website root"
    );
    ensure!(
        path.split('/')
            .all(|part| !part.starts_with('.') && part != "node_modules" && part != "vendor"),
        "Hidden and dependency folders are not editable"
    );
    let lower = path.to_ascii_lowercase();
    ensure!(
        lower.ends_with(".css") || lower.ends_with(".php"),
        "Only tracked CSS and PHP files can be edited"
    );
    Ok(())
}
fn branch_name(branch: &str) -> Result<()> {
    ensure!(
        !branch.is_empty()
            && branch.len() <= 200
            && !branch.starts_with('-')
            && !branch.starts_with('/')
            && !branch.ends_with('/')
            && !branch.ends_with('.')
            && !branch.contains("..")
            && !branch.contains("@{")
            && !branch.contains("//")
            && !branch.contains(".lock")
            && branch
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'/' | b'-' | b'_' | b'.')),
        "Invalid source base branch"
    );
    Ok(())
}
fn url_path(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
}

/// Execute git noninteractively with bounded output/time. Error messages never
/// include command arguments, repository content, credentials, or stderr.
fn git(
    repo: &Path,
    args: &[&str],
    input: Option<&[u8]>,
    index: Option<&Path>,
    seconds: u64,
) -> Result<Vec<u8>> {
    let mut command = Command::new("git");
    command
        .arg("-C")
        .arg(repo)
        .args([
            "-c",
            "http.lowSpeedLimit=1",
            "-c",
            "http.lowSpeedTime=20",
            "-c",
            "core.hooksPath=",
            "-c",
            "commit.gpgsign=false",
        ])
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "Never")
        .env("GIT_LITERAL_PATHSPECS", "1")
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_COMMON_DIR")
        .env_remove("GIT_INDEX_FILE")
        .env_remove("GIT_OBJECT_DIRECTORY")
        .env_remove("GIT_ALTERNATE_OBJECT_DIRECTORIES")
        .env_remove("GIT_NAMESPACE")
        .env_remove("GIT_CONFIG_COUNT")
        .env_remove("GIT_CONFIG_PARAMETERS")
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(index) = index {
        command.env("GIT_INDEX_FILE", index);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW, without DETACHED_PROCESS
    }
    run_git_command(command, input, seconds)
}
fn run_git_command(mut command: Command, input: Option<&[u8]>, seconds: u64) -> Result<Vec<u8>> {
    let mut child = command.spawn().context("Unable to start Git")?;
    if let Some(bytes) = input {
        let mut stdin = child.stdin.take().context("Git input unavailable")?;
        let data = bytes.to_vec();
        thread::spawn(move || {
            let _ = stdin.write_all(&data);
        });
    }
    let stdout = child.stdout.take().context("Git output unavailable")?;
    let stderr = child
        .stderr
        .take()
        .context("Git error output unavailable")?;
    let (output_tx, output_rx) = std::sync::mpsc::sync_channel(1);
    thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = stdout
            .take((MAX_SOURCE + 1_000_000) as u64)
            .read_to_end(&mut bytes);
        let _ = output_tx.send(bytes);
    });
    let (error_tx, error_rx) = std::sync::mpsc::sync_channel(1);
    thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = stderr.take(64_000).read_to_end(&mut bytes);
        let _ = error_tx.send(bytes);
    });
    let deadline = Instant::now() + Duration::from_secs(seconds);
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            // Descendants may still hold the pipes. Detach readers instead of
            // waiting on unrelated processes; the original push is uncertain.
            return Err(GitFailure {
                definitive_rejection: false,
            }
            .into());
        }
        thread::sleep(Duration::from_millis(50));
    };
    // A completed parent may still have a descendant holding a pipe. Bound
    // that wait by the same deadline and never treat it as non-delivery.
    let bytes = output_rx
        .recv_timeout(deadline.saturating_duration_since(Instant::now()))
        .map_err(|_| GitFailure {
            definitive_rejection: false,
        })?;
    let errors = error_rx
        .recv_timeout(deadline.saturating_duration_since(Instant::now()))
        .map_err(|_| GitFailure {
            definitive_rejection: false,
        })?;
    if !status.success() {
        // Inspect standard Git rejection markers internally; stderr is never
        // returned, logged, or persisted because it can contain credentials.
        let message = String::from_utf8_lossy(&errors).to_ascii_lowercase();
        let definitive_rejection = message.contains("[rejected]")
            || message.contains("[remote rejected]")
            || message.contains("authentication failed")
            || message.contains("could not read username")
            || message.contains("permission denied (publickey)");
        return Err(GitFailure {
            definitive_rejection,
        }
        .into());
    }
    ensure!(
        bytes.len() <= MAX_SOURCE + 999_999,
        "Git response exceeds the source size limit"
    );
    Ok(bytes)
}
fn git_text(repo: &Path, args: &[&str], index: Option<&Path>, seconds: u64) -> Result<String> {
    Ok(String::from_utf8(git(repo, args, None, index, seconds)?)?
        .trim()
        .to_owned())
}
/// Read the checkout's origin remote and confirm it still points at the configured repository.
///
/// # Errors
/// Fails when Git cannot be queried or the origin now names another repository.
pub fn repository_origin(repo: &Path, github: &crate::config::GithubRepo) -> Result<String> {
    let remote = git_text(repo, &["remote", "get-url", "origin"], None, 10)?;
    ensure!(
        github.matches_remote(&remote),
        "Configured repository origin changed; source sync is unavailable"
    );
    Ok(remote)
}
fn run_sha(value: &str) -> Result<&str> {
    ensure!(
        value.len() == 40 && value.bytes().all(|c| c.is_ascii_hexdigit()),
        "Invalid Git object identifier"
    );
    Ok(value)
}

/// Source drafts and review-branch sync for one project.
pub struct SourceEdits<'a> {
    /// Configured checkout; read for its remote only, never written.
    pub repo: &'a Path,
    /// Application data directory that holds drafts, receipts and the Git cache.
    pub data: &'a Path,
    /// Project whose drafts these are.
    pub project: &'a str,
    /// Git remote to fetch from and push to.
    /// Caller validates the configured repository origin before constructing this.
    pub remote: &'a str,
    /// Repository web URL for branch, compare and commit links.
    pub repository: &'a str,
    /// Branch that review branches start from when a project has not chosen one.
    pub default_base: &'a str,
    /// Repository folder holding the web root; edits outside it are refused (empty: anywhere).
    pub source_root: &'a str,
}
struct Heads {
    base: String,
    branch: Option<String>,
    ancestor: Option<String>,
}
impl Heads {
    fn branch_precedes_base(&self) -> bool {
        self.branch
            .as_deref()
            .is_some_and(|branch| self.ancestor.as_deref() == Some(branch))
    }
    fn diverged(&self) -> bool {
        match (&self.branch, &self.ancestor) {
            (Some(branch), Some(ancestor)) => ancestor != branch && ancestor != &self.base,
            _ => false,
        }
    }
    fn build_head(&self) -> &str {
        if self.branch.is_none() || self.branch_precedes_base() {
            &self.base
        } else {
            self.branch.as_deref().unwrap()
        }
    }
}
impl SourceEdits<'_> {
    fn branch_url(&self, branch: &str) -> String {
        format!("{}/tree/{}", self.repository, url_path(branch))
    }
    fn compare_url(&self, base: &str, branch: &str) -> String {
        format!(
            "{}/compare/{}...{}",
            self.repository,
            url_path(base),
            url_path(branch)
        )
    }
    fn directory(&self) -> Result<PathBuf> {
        checked_project(self.project)?;
        Ok(self.data.join("source-edits").join(self.project))
    }
    fn state_path(&self) -> Result<PathBuf> {
        Ok(self.directory()?.join("drafts.json"))
    }
    fn load(&self) -> Result<State> {
        let path = self.state_path()?;
        if !path.exists() {
            return Ok(State {
                project_id: self.project.into(),
                branch: format!("alcordesign/{}", self.project),
                base_branch: None,
                files: BTreeMap::new(),
                save_receipts: BTreeMap::new(),
                sync_receipts: BTreeMap::new(),
                sync_reservations: BTreeMap::new(),
                pending_sync: None,
                last_sync: None,
            });
        }
        let state: State = serde_json::from_slice(&fs::read(path)?)
            .context("Could not read saved source drafts")?;
        ensure!(
            state.project_id == self.project
                && state.branch == format!("alcordesign/{}", self.project),
            "Saved source workspace identity mismatch"
        );
        Ok(state)
    }
    fn save(&self, state: &State) -> Result<()> {
        let dir = self.directory()?;
        fs::create_dir_all(&dir)?;
        let target = self.state_path()?;
        let tmp = dir.join(format!("drafts-{}.tmp", Uuid::new_v4().simple()));
        let mut file = fs::File::create(&tmp)?;
        file.write_all(&serde_json::to_vec(state)?)?;
        file.sync_all()?;
        fs::rename(&tmp, &target).context("Could not save source draft atomically")?;
        Ok(())
    }
    fn bare(&self) -> Result<PathBuf> {
        let dir = self.directory()?;
        fs::create_dir_all(&dir)?;
        let bare = dir.join("git");
        if !bare.exists() {
            // Initialize without a working tree, hooks, or repository checkout.
            git(
                &dir,
                &["init", "--bare", "--quiet", "--template=", "git"],
                None,
                None,
                30,
            )?;
            let common = git_text(
                self.repo,
                &["rev-parse", "--path-format=absolute", "--git-common-dir"],
                None,
                10,
            )?;
            let objects = PathBuf::from(common).join("objects").canonicalize()?;
            let info = bare.join("objects").join("info");
            fs::create_dir_all(&info)?;
            fs::write(info.join("alternates"), format!("{}\n", objects.display()))?;
        }
        ensure!(
            bare.join("HEAD").is_file(),
            "Private source Git workspace is invalid"
        );
        Ok(bare)
    }
    fn remote_head(&self, bare: &Path, branch: &str) -> Result<Option<String>> {
        branch_name(branch)?;
        let refname = format!("refs/heads/{branch}");
        let text = git_text(
            bare,
            &["ls-remote", "--refs", self.remote, &refname],
            None,
            45,
        )?;
        if text.is_empty() {
            return Ok(None);
        }
        let mut fields = text.split_whitespace();
        let sha = fields.next().context("Invalid remote branch response")?;
        ensure!(
            fields.next() == Some(refname.as_str()) && fields.next().is_none(),
            "Ambiguous remote branch response"
        );
        Ok(Some(run_sha(sha)?.to_owned()))
    }
    fn fetch(&self, bare: &Path, branch: &str, local: &str) -> Result<String> {
        branch_name(branch)?;
        let spec = format!("+refs/heads/{branch}:refs/alcordesign/{local}");
        git(
            bare,
            &[
                "fetch",
                "--quiet",
                "--no-tags",
                "--no-recurse-submodules",
                "--no-write-fetch-head",
                self.remote,
                &spec,
            ],
            None,
            None,
            120,
        )?;
        let sha = git_text(
            bare,
            &[
                "rev-parse",
                "--verify",
                &format!("refs/alcordesign/{local}^{{commit}}"),
            ],
            None,
            10,
        )?;
        Ok(run_sha(&sha)?.to_string())
    }
    fn heads(&self, bare: &Path, base: &str, branch: &str) -> Result<Heads> {
        let base_tip = self.fetch(bare, base, "base")?;
        let advertised = self.remote_head(bare, branch)?;
        let branch_tip = if let Some(expected) = advertised {
            let fetched = self.fetch(bare, branch, "branch")?;
            ensure!(
                fetched == expected,
                "The review branch changed while loading source; refresh and retry"
            );
            Some(fetched)
        } else {
            None
        };
        let ancestor = if let Some(ref tip) = branch_tip {
            let sha=git_text(bare,&["merge-base",&base_tip,tip],None,20)
                .context("The review branch and preview base have unrelated histories; review the branch before editing")?;
            Some(run_sha(&sha)?.to_owned())
        } else {
            None
        };
        Ok(Heads {
            base: base_tip,
            branch: branch_tip,
            ancestor,
        })
    }
    fn optional_blob(
        &self,
        bare: &Path,
        sha: &str,
        path: &str,
    ) -> Result<Option<(String, String)>> {
        checked_path(path, self.source_root)?;
        run_sha(sha)?;
        let output = git(bare, &["ls-tree", "-z", sha, "--", path], None, None, 15)?;
        if output.is_empty() {
            return Ok(None);
        }
        let row = output
            .strip_suffix(&[0])
            .context("Source file not found on the selected GitHub branch")?;
        let line = std::str::from_utf8(row)?;
        let (meta, actual) = line.split_once('\t').context("Invalid Git source record")?;
        ensure!(actual == path, "Ambiguous Git source path");
        let mut fields = meta.split_whitespace();
        let mode = fields.next().context("Git source mode missing")?;
        ensure!(
            matches!(mode, "100644" | "100755") && fields.next() == Some("blob"),
            "Only regular tracked CSS and PHP files can be edited"
        );
        let blob = fields.next().context("Git source blob missing")?;
        ensure!(fields.next().is_none(), "Ambiguous Git source record");
        Ok(Some((mode.to_owned(), run_sha(blob)?.to_owned())))
    }
    fn blob(&self, bare: &Path, sha: &str, path: &str) -> Result<(String, String)> {
        self.optional_blob(bare, sha, path)?
            .context("Source file not found on the selected GitHub branch")
    }
    fn content(&self, bare: &Path, sha: &str, path: &str) -> Result<String> {
        let spec = format!("{sha}:{path}");
        let size = git_text(bare, &["cat-file", "-s", &spec], None, 15)?.parse::<usize>()?;
        ensure!(size <= MAX_SOURCE, "Source file exceeds 2 MB");
        let bytes = git(bare, &["show", &spec], None, None, 20)?;
        ensure!(bytes.len() == size, "Git source length mismatch");
        String::from_utf8(bytes).context("Only UTF-8 CSS and PHP files can be edited")
    }
    fn response(&self, state: &State, path: &str, draft: &Draft) -> Value {
        let base = state.base_branch.as_deref().unwrap_or(self.default_base);
        json!({"project_id":self.project,"path":path,"content":draft.content,"version":draft.version,
            "base_sha":draft.base_sha,"base_blob":draft.base_blob,"mode":draft.mode,"branch":state.branch,"base_branch":base,
            "branch_url":self.branch_url(&state.branch),"compare_url":self.compare_url(base,&state.branch),
            "dirty":draft.dirty,"provenance":draft.provenance})
    }
    fn inventory(
        &self,
        bare: &Path,
        sha: &str,
        needle: &str,
    ) -> Result<BTreeMap<String, (String, String)>> {
        let data = git(bare, &["ls-tree", "-r", "-z", sha], None, None, 30)?;
        let mut records = BTreeMap::new();
        for row in data.split(|b| *b == 0).filter(|row| !row.is_empty()) {
            let Ok(line) = std::str::from_utf8(row) else {
                continue;
            };
            let Some((meta, path)) = line.split_once('\t') else {
                continue;
            };
            let mut parts = meta.split_whitespace();
            let mode = parts.next().unwrap_or("");
            let kind = parts.next().unwrap_or("");
            let blob = parts.next().unwrap_or("");
            if !matches!(mode, "100644" | "100755")
                || kind != "blob"
                || run_sha(blob).is_err()
                || checked_path(path, self.source_root).is_err()
                || !path.to_lowercase().contains(needle)
            {
                continue;
            }
            records.insert(path.to_owned(), (mode.to_owned(), blob.to_owned()));
        }
        Ok(records)
    }
    /// List editable CSS and PHP files on the review branch or its base, flagging files that
    /// changed upstream and saved drafts. Fetches into the private cache; never pushes.
    ///
    /// # Errors
    /// Fails when the remote cannot be fetched or the branches have unrelated histories.
    pub fn files(&self, query: &str) -> Result<Value> {
        ensure!(
            query.chars().count() <= 512,
            "Source search query is too long"
        );
        let state = self.load()?;
        let base = state.base_branch.as_deref().unwrap_or(self.default_base);
        let bare = self.bare()?;
        let heads = self.heads(&bare, base, &state.branch)?;
        let sha = heads.build_head().to_owned();
        let editing_ref = if sha == heads.base {
            base.to_owned()
        } else {
            state.branch.clone()
        };
        let needle = query.to_lowercase();
        let branch_files = self.inventory(&bare, &sha, &needle)?;
        let mut records = BTreeMap::<String, Value>::new();
        if heads.diverged() {
            let base_files = self.inventory(&bare, &heads.base, &needle)?;
            let ancestor_files =
                self.inventory(&bare, heads.ancestor.as_deref().unwrap(), &needle)?;
            let paths = base_files
                .keys()
                .chain(branch_files.keys())
                .cloned()
                .collect::<std::collections::BTreeSet<_>>();
            for path in paths {
                let base_file = base_files.get(&path);
                let branch_file = branch_files.get(&path);
                let ancestor = ancestor_files.get(&path);
                let base_changed = base_file != ancestor;
                let branch_changed = branch_file != ancestor;
                let conflict = base_changed && branch_changed && base_file != branch_file;
                if !conflict
                    && ((base_file.is_none() && base_changed && !branch_changed)
                        || (branch_file.is_none() && branch_changed && !base_changed))
                {
                    continue;
                }
                let from_base = base_changed && !branch_changed;
                let chosen = (if from_base { base_file } else { branch_file })
                    .or(base_file)
                    .or(branch_file);
                let Some((mode, blob)) = chosen else { continue };
                // A delete/modify conflict may show the surviving base blob.
                // Label that blob with the commit it actually came from.
                let chosen_from_base = from_base || (branch_file.is_none() && base_file.is_some());
                let tree_sha = if chosen_from_base {
                    heads.base.as_str()
                } else {
                    sha.as_str()
                };
                let tree_ref = if chosen_from_base {
                    base
                } else {
                    editing_ref.as_str()
                };
                let draft = state.files.get(&path);
                records.insert(path.clone(),json!({"path":path,"kind":path.rsplit('.').next().unwrap_or(""),
                    "blob":blob,"mode":mode,"editable":!conflict,"conflict":conflict,
                    "conflict_reason":if conflict{Some("Preview and review branches changed this file incompatibly; review or rebase the branch.")}else{None},
                    "source_sha":tree_sha,"editing_ref":tree_ref,"dirty":draft.is_some_and(|d|d.dirty)}));
            }
        } else {
            for (path, (mode, blob)) in branch_files {
                let draft = state.files.get(&path);
                records.insert(
                    path.clone(),
                    json!({"path":path,"kind":path.rsplit('.').next().unwrap_or(""),
                    "blob":blob,"mode":mode,"editable":true,"source_sha":sha,"editing_ref":editing_ref,
                    "dirty":draft.is_some_and(|d|d.dirty)}),
                );
            }
        }
        // Observation never rebases or rewrites drafts. Include deleted dirty
        // paths so a remote deletion cannot hide recoverable local work.
        for (path, draft) in &state.files {
            if !draft.dirty || !path.to_lowercase().contains(&needle) {
                continue;
            }
            let row = records.entry(path.clone()).or_insert_with(|| {
                json!({
                    "path":path,"kind":path.rsplit('.').next().unwrap_or(""),
                    "deleted":true,"editable":true,"dirty":true
                })
            });
            row["upstream_changed"] = json!(
                row["blob"].as_str() != Some(&draft.base_blob)
                    || row["mode"].as_str() != Some(&draft.mode)
            );
            row["draft_version"] = json!(draft.version);
        }
        let total = records.len();
        // Bound ordinary inventory rows, never the set of saved dirty drafts.
        let mut ordinary = 0;
        let files = records
            .into_values()
            .filter(|row| {
                if row["dirty"].as_bool() == Some(true) {
                    return true;
                }
                ordinary += 1;
                ordinary <= 2500
            })
            .collect::<Vec<_>>();
        let truncated = files.len() < total;
        Ok(
            json!({"project_id":self.project,"branch":state.branch,"base_branch":base,"editing_ref":editing_ref,
            "sha":sha,"heads":{"base":heads.base,"review":heads.branch,"ancestor":heads.ancestor},
            "files":files,"total":total,"truncated":truncated}),
        )
    }
    /// Open a draft for `path`, saving a clean baseline from the current branch head first.
    ///
    /// # Errors
    /// Fails on an invalid path, a missing file, or when both branches changed the file.
    pub fn open(&self, path: &str, capture: Value) -> Result<Value> {
        checked_path(path, self.source_root)?;
        let mut state = self.load()?;
        if let Some(draft) = state.files.get(path) {
            if draft.dirty || state.pending_sync.is_some() {
                return Ok(self.response(&state, path, draft));
            }
        }
        let bare = self.bare()?;
        let base = state
            .base_branch
            .as_deref()
            .unwrap_or(self.default_base)
            .to_owned();
        let heads = self.heads(&bare, &base, &state.branch)?;
        let base_entry = self.optional_blob(&bare, &heads.base, path)?;
        let review_entry = self.optional_blob(&bare, heads.build_head(), path)?;
        let (sha, editing_ref) = if heads.diverged() {
            let ancestor = self.optional_blob(&bare, heads.ancestor.as_ref().unwrap(), path)?;
            let base_changed = base_entry != ancestor;
            let branch_changed = review_entry != ancestor;
            ensure!(
                !(base_changed && branch_changed && base_entry != review_entry),
                "Source conflict for {path}: both the preview base and review branch changed this file. Review or rebase the branch before editing; saved drafts are preserved"
            );
            if base_changed && !branch_changed {
                (heads.base.clone(), base.clone())
            } else {
                (heads.build_head().to_owned(), state.branch.clone())
            }
        } else if heads.build_head() == heads.base {
            (heads.base.clone(), base.clone())
        } else {
            (heads.build_head().to_owned(), state.branch.clone())
        };
        let (mode, blob) = self.blob(&bare, &sha, path)?;
        let content = self.content(&bare, &sha, path)?;
        let draft = Draft {
            content,
            version: format!("blob:{blob}"),
            base_sha: sha.clone(),
            base_blob: blob,
            mode,
            provenance: json!({"basis":"github_branch","editing_ref":editing_ref,"source_sha":sha,
                "capture_sha":capture["sha"],"capture_basis":capture["basis"],
                "base_branch_blob":base_entry.as_ref().map(|(_,blob)|blob),
                "base_branch_mode":base_entry.as_ref().map(|(mode,_)|mode),
                "review_branch_blob":review_entry.as_ref().map(|(_,blob)|blob),
                "review_branch_mode":review_entry.as_ref().map(|(mode,_)|mode),
                "branches_diverged":heads.diverged(),
                "integration_note":if heads.diverged() {Some("Preview and review branches diverged; eventual promotion may need conflict resolution.")} else {None}}),
            dirty: false,
        };
        state.files.insert(path.to_owned(), draft);
        self.save(&state)?;
        Ok(self.response(&state, path, &state.files[path]))
    }
    /// Save draft content if `expected_version` is still current. Replaying the same
    /// `request_id` returns the original result instead of saving twice.
    ///
    /// # Errors
    /// Fails on a stale version, oversized content or a reused request ID with other input.
    pub fn save_source(
        &self,
        path: &str,
        content: &str,
        expected: &str,
        request_id: &str,
    ) -> Result<Value> {
        checked_path(path, self.source_root)?;
        checked_request_id(request_id)?;
        ensure!(content.len() <= MAX_SOURCE, "Source file exceeds 2 MB");
        let mut state = self.load()?;
        let bare = self.bare()?;
        let blob = String::from_utf8(git(
            &bare,
            &["hash-object", "--stdin"],
            Some(content.as_bytes()),
            None,
            20,
        )?)?
        .trim()
        .to_string();
        run_sha(&blob)?;
        if let Some(receipt) = state.save_receipts.get(request_id) {
            ensure!(
                receipt.path == path
                    && receipt.expected_version == expected
                    && receipt.content_blob == blob,
                "request_id was already used for a different source save"
            );
            let mut result = receipt.result.clone();
            result["content"] = json!(content);
            result["cached_receipt"] = json!(true);
            return Ok(result);
        }
        ensure!(
            !state.sync_receipts.contains_key(request_id)
                && !state.sync_reservations.contains_key(request_id)
                && !state
                    .pending_sync
                    .as_ref()
                    .is_some_and(|p| p.transaction_id == request_id),
            "request_id was already used for a source sync"
        );
        ensure!(
            state.pending_sync.is_none(),
            "A prior GitHub sync needs reconciliation before saving"
        );
        let draft = state
            .files
            .get_mut(path)
            .context("Open the source file before saving")?;
        ensure!(
            draft.version == expected,
            "Source changed since it was opened; your edit was not saved"
        );
        draft.content = content.to_owned();
        draft.dirty = blob != draft.base_blob;
        draft.version = Uuid::new_v4().simple().to_string();
        let mut response = self.response(&state, path, &state.files[path]);
        response["request_id"] = json!(request_id);
        response["saved"] = json!(true);
        response["cached_receipt"] = json!(false);
        let mut durable = response.clone();
        durable.as_object_mut().unwrap().remove("content");
        state.save_receipts.insert(
            request_id.to_owned(),
            SaveReceipt {
                path: path.to_owned(),
                expected_version: expected.to_owned(),
                content_blob: blob,
                result: durable,
            },
        );
        self.save(&state)?;
        Ok(response)
    }
    fn settle(&self, state: &mut State, pending: &Pending) -> Value {
        let mut names = Vec::new();
        for change in &pending.changes {
            if let Some(draft) = state.files.get_mut(&change.path) {
                if draft.version == change.version {
                    draft.base_sha = pending.commit.clone();
                    draft.base_blob = change.blob.clone();
                    draft.dirty = false;
                    draft.version = Uuid::new_v4().simple().to_string();
                    draft.provenance["basis"] = json!("synced_branch");
                    draft.provenance["source_sha"] = json!(pending.commit);
                    draft.provenance["editing_ref"] = json!(state.branch);
                }
            }
            names.push(change.path.clone());
        }
        let base = &pending.requested_base;
        json!({"project_id":self.project,"state":"pushed","request_id":pending.transaction_id,"transaction_id":pending.transaction_id,"draft_set_version":pending.draft_set_version,
            "branch":state.branch,"base_branch":base,"branch_url":self.branch_url(&state.branch),"compare_url":self.compare_url(base,&state.branch),
            "commit":pending.commit,"commit_url":format!("{}/commit/{}",self.repository,pending.commit),
            "changed_files":names,"pushed":true,"uncertain":false,
            "dirty_count":state.files.values().filter(|d|d.dirty).count()})
    }
    fn reconcile(&self, state: &mut State) -> Result<()> {
        let Some(mut pending) = state.pending_sync.clone() else {
            return Ok(());
        };
        let bare = self.bare()?;
        let remote = match self.remote_head(&bare, &state.branch) {
            Ok(value) => value,
            Err(_) => {
                pending.state = "uncertain".into();
                state.pending_sync = Some(pending);
                self.save(state)?;
                return Ok(());
            }
        };
        let descended = if let Some(ref remote_sha) = remote {
            if remote_sha == &pending.commit {
                true
            } else if remote != pending.previous_remote {
                match self.fetch(&bare, &state.branch, "branch") {
                    Ok(ref fetched) if fetched == remote_sha => {
                        git_text(
                            &bare,
                            &["merge-base", &pending.commit, remote_sha],
                            None,
                            15,
                        )
                        .ok()
                        .as_deref()
                            == Some(pending.commit.as_str())
                    }
                    _ => false,
                }
            } else {
                false
            }
        } else {
            false
        };
        if descended {
            let result = self.settle(state, &pending);
            state.sync_receipts.insert(
                pending.transaction_id.clone(),
                SyncReceipt {
                    base_branch: pending.requested_base.clone(),
                    draft_set_version: pending.draft_set_version.clone(),
                    result: result.clone(),
                },
            );
            state.last_sync = Some(result);
            state.pending_sync = None;
            self.save(state)?;
        } else if remote == pending.previous_remote {
            // An unchanged head does not prove that an interrupted push will
            // never arrive later. Only an explicit, settled Git rejection
            // makes an unchanged head conclusive.
            if pending.state == "settled_rejected" {
                let result = json!({"project_id":self.project,"state":"not_pushed","request_id":pending.transaction_id,"transaction_id":pending.transaction_id,"draft_set_version":pending.draft_set_version,
                    "branch":state.branch,"base_branch":pending.requested_base,
                    "branch_url":self.branch_url(&state.branch),"compare_url":self.compare_url(&pending.requested_base,&state.branch),
                    "commit":pending.commit,"pushed":false,"uncertain":false,"dirty_count":state.files.values().filter(|d|d.dirty).count(),
                    "message":"GitHub rejected the push; your drafts remain saved."});
                state.sync_receipts.insert(
                    pending.transaction_id.clone(),
                    SyncReceipt {
                        base_branch: pending.requested_base.clone(),
                        draft_set_version: pending.draft_set_version.clone(),
                        result: result.clone(),
                    },
                );
                state.last_sync = Some(result);
                state.pending_sync = None;
                self.save(state)?;
            } else {
                pending.state = "uncertain".into();
                state.pending_sync = Some(pending);
                self.save(state)?;
            }
        } else {
            pending.state = "remote_changed".into();
            state.pending_sync = Some(pending);
            self.save(state)?;
        }
        Ok(())
    }
    /// Branch names, links, dirty drafts and the last or pending sync for this project.
    ///
    /// # Errors
    /// Fails when the saved draft state cannot be read.
    pub fn status(&self) -> Result<Value> {
        let mut state = self.load()?;
        if state.pending_sync.is_some() {
            self.reconcile(&mut state)?;
        }
        let base = state.base_branch.as_deref().unwrap_or(self.default_base);
        let files=state.files.iter().filter(|(_,d)|d.dirty).map(|(path,d)|json!({"path":path,"version":d.version,"base_sha":d.base_sha,"base_blob":d.base_blob})).collect::<Vec<_>>();
        let set_version = draft_set_version(&draft_versions(&state));
        let pending = state.pending_sync.as_ref().map(pending_json);
        Ok(
            json!({"project_id":self.project,"branch":state.branch,"base_branch":base,
            "branch_url":self.branch_url(&state.branch),"compare_url":self.compare_url(base,&state.branch),
            "dirty_count":files.len(),"files":files,"draft_set_version":set_version,"last_sync":state.last_sync,"pending_sync":pending}),
        )
    }
    /// Reconcile the durable outcome of an earlier save or sync without repeating it.
    ///
    /// # Errors
    /// Fails on an unknown request ID or when the remote cannot be checked.
    pub fn operation_status(&self, request_id: &str) -> Result<Value> {
        checked_request_id(request_id)?;
        let mut state = self.load()?;
        if state
            .pending_sync
            .as_ref()
            .is_some_and(|p| p.transaction_id == request_id)
        {
            self.reconcile(&mut state)?;
        }
        if let Some(receipt) = state.save_receipts.get(request_id) {
            return Ok(
                json!({"request_id":request_id,"operation_type":"save","state":"completed","result":receipt.result}),
            );
        }
        if let Some(receipt) = state.sync_receipts.get(request_id) {
            return Ok(
                json!({"request_id":request_id,"operation_type":"sync","state":"completed","result":receipt.result}),
            );
        }
        if let Some(pending) = state
            .pending_sync
            .as_ref()
            .filter(|p| p.transaction_id == request_id)
        {
            let base = &pending.requested_base;
            return Ok(
                json!({"request_id":request_id,"operation_type":"sync","state":"pending",
                "result":{"project_id":self.project,"request_id":request_id,"transaction_id":request_id,"draft_set_version":pending.draft_set_version,
                    "branch":state.branch,"base_branch":base,"branch_url":self.branch_url(&state.branch),
                    "compare_url":self.compare_url(base,&state.branch),"pushed":null,"uncertain":true,
                    "pending_sync":pending_json(pending),"dirty_count":state.files.values().filter(|d|d.dirty).count()}}),
            );
        }
        if let Some(reservation) = state.sync_reservations.get(request_id).cloned() {
            // The application serializes all source operations. If no pending
            // push or receipt remains after acquiring that lock, this reserved
            // operation stopped before any remote push was dispatched.
            let result = json!({"project_id":self.project,"request_id":request_id,"transaction_id":request_id,"draft_set_version":reservation.draft_set_version,
                "branch":state.branch,"base_branch":reservation.base_branch,
                "branch_url":self.branch_url(&state.branch),"compare_url":self.compare_url(&reservation.base_branch,&state.branch),
                "pushed":false,"uncertain":false,"dirty_count":state.files.values().filter(|d|d.dirty).count(),
                "message":"The original sync stopped before a push; saved drafts are preserved."});
            state.sync_receipts.insert(
                request_id.to_owned(),
                SyncReceipt {
                    base_branch: reservation.base_branch,
                    draft_set_version: reservation.draft_set_version,
                    result: result.clone(),
                },
            );
            state.last_sync = Some(result.clone());
            self.save(&state)?;
            return Ok(
                json!({"request_id":request_id,"operation_type":"sync","state":"completed","result":result}),
            );
        }
        Ok(json!({"request_id":request_id,"operation_type":null,"state":"not_found"}))
    }
    /// Commit saved drafts onto the review branch in the private cache and push it,
    /// refusing if the remote moved or files conflict. Never force-pushes.
    ///
    /// # Errors
    /// Fails on conflicts, a stale `draft_set_version` or a rejected or uncertain push.
    pub fn sync(
        &self,
        selected_base: Option<&str>,
        request_id: &str,
        expected_set: &str,
    ) -> Result<Value> {
        checked_request_id(request_id)?;
        checked_draft_set_version(expected_set)?;
        let mut state = self.load()?;
        let base = selected_base
            .unwrap_or(state.base_branch.as_deref().unwrap_or(self.default_base))
            .to_owned();
        branch_name(&base)?;
        ensure!(
            !state.save_receipts.contains_key(request_id),
            "request_id was already used for a source save"
        );
        if let Some(reservation) = state.sync_reservations.get(request_id) {
            ensure!(
                reservation.base_branch == base && reservation.draft_set_version == expected_set,
                "request_id was already used for a different source sync"
            );
            if state.sync_receipts.contains_key(request_id)
                || state
                    .pending_sync
                    .as_ref()
                    .is_some_and(|p| p.transaction_id == request_id)
            {
                return self.sync_inner(Some(&base), request_id, expected_set);
            }
            let mut result = self.operation_status(request_id)?["result"].clone();
            result["cached_receipt"] = json!(true);
            return Ok(result);
        }
        ensure!(
            state.pending_sync.is_none(),
            "Previous sync outcome is uncertain; check sync status before retrying"
        );
        let files = draft_versions(&state);
        let current_set = draft_set_version(&files);
        state.sync_reservations.insert(
            request_id.to_owned(),
            SyncReservation {
                base_branch: base.clone(),
                draft_set_version: expected_set.to_owned(),
                files,
            },
        );
        if expected_set != current_set {
            let result = json!({"project_id":self.project,"request_id":request_id,"transaction_id":request_id,
                "branch":state.branch,"base_branch":base,"draft_set_version":expected_set,
                "branch_url":self.branch_url(&state.branch),"compare_url":self.compare_url(&base,&state.branch),
                "code":"draft_set_changed","pushed":false,"uncertain":false,"dirty_count":state.files.values().filter(|d|d.dirty).count(),
                "message":"Saved drafts changed since this sync was requested. Refresh their status and review before syncing."});
            state.sync_receipts.insert(
                request_id.to_owned(),
                SyncReceipt {
                    base_branch: base,
                    draft_set_version: expected_set.to_owned(),
                    result: result.clone(),
                },
            );
            state.last_sync = Some(result.clone());
            self.save(&state)?;
            return Ok(result);
        }
        self.save(&state)?;
        match self.sync_inner(Some(&base), request_id, expected_set) {
            Ok(result) => Ok(result),
            Err(error) => {
                let mut state = self.load()?;
                if state
                    .pending_sync
                    .as_ref()
                    .is_some_and(|p| p.transaction_id == request_id)
                {
                    return Ok(self.operation_status(request_id)?["result"].clone());
                }
                let result = json!({"project_id":self.project,"request_id":request_id,"transaction_id":request_id,"draft_set_version":expected_set,
                    "branch":state.branch,"base_branch":base,"branch_url":self.branch_url(&state.branch),
                    "compare_url":self.compare_url(&base,&state.branch),"pushed":false,"uncertain":false,
                    "dirty_count":state.files.values().filter(|d|d.dirty).count(),"message":format!("{error:#}")});
                state.sync_receipts.insert(
                    request_id.to_owned(),
                    SyncReceipt {
                        base_branch: base,
                        draft_set_version: expected_set.to_owned(),
                        result: result.clone(),
                    },
                );
                state.last_sync = Some(result.clone());
                self.save(&state)?;
                Ok(result)
            }
        }
    }
    fn sync_inner(
        &self,
        selected_base: Option<&str>,
        request_id: &str,
        expected_set: &str,
    ) -> Result<Value> {
        checked_request_id(request_id)?;
        let mut state = self.load()?;
        let base = selected_base
            .unwrap_or(state.base_branch.as_deref().unwrap_or(self.default_base))
            .to_owned();
        branch_name(&base)?;
        ensure!(
            !state.save_receipts.contains_key(request_id),
            "request_id was already used for a source save"
        );
        if let Some(receipt) = state.sync_receipts.get(request_id) {
            ensure!(
                receipt.base_branch == base && receipt.draft_set_version == expected_set,
                "request_id was already used for a different source sync"
            );
            let mut result = receipt.result.clone();
            result["cached_receipt"] = json!(true);
            return Ok(result);
        }
        if let Some(pending) = state
            .pending_sync
            .as_ref()
            .filter(|p| p.transaction_id == request_id)
        {
            ensure!(
                pending.requested_base == base && pending.draft_set_version == expected_set,
                "request_id was already used for a different source sync"
            );
            let status = self.operation_status(request_id)?;
            let mut result = status["result"].clone();
            result["cached_receipt"] = json!(true);
            return Ok(result);
        }
        if state.pending_sync.is_some() {
            self.reconcile(&mut state)?;
        }
        ensure!(
            state.pending_sync.is_none(),
            "Previous sync outcome is uncertain; check sync status before retrying"
        );
        if let Some(saved) = &state.base_branch {
            ensure!(
                saved == &base,
                "This project's source base branch is already fixed"
            );
        }
        ensure!(
            base != state.branch,
            "Source base and review branch must be different"
        );
        ensure!(
            draft_set_version(&draft_versions(&state)) == expected_set,
            "Saved drafts changed since this sync was requested; drafts remain saved"
        );
        let dirty = state
            .files
            .iter()
            .filter(|(_, d)| d.dirty)
            .map(|(p, d)| (p.clone(), d.clone()))
            .collect::<Vec<_>>();
        ensure!(!dirty.is_empty(), "There are no saved source edits to sync");
        let bare = self.bare()?;
        let heads = self.heads(&bare, &base, &state.branch)?;
        let before = heads.branch.clone();
        let base_tip = heads.base.clone();
        let head = heads.build_head().to_owned();
        // Compare each file against BOTH the newest base and the review branch.
        // If another actor changed one of these blobs, never overwrite it.
        for (path, draft) in &dirty {
            let base_entry = self
                .optional_blob(&bare, &base_tip, path)
                .with_context(|| format!("Source conflict for {path} on the base branch"))?;
            let head_entry = self
                .optional_blob(&bare, &head, path)
                .with_context(|| format!("Source conflict for {path} on the review branch"))?;
            // After our own previous sync, base may legitimately differ from that
            // synced blob. The base version must remain unchanged since our edit
            // started; store and compare it independently below.
            let captured_base = draft.provenance["base_branch_blob"].as_str();
            let captured_base_mode = draft
                .provenance
                .get("base_branch_mode")
                .map(|v| v.as_str())
                .unwrap_or(Some(draft.mode.as_str()));
            let base_blob = base_entry.as_ref().map(|(_, blob)| blob.as_str());
            let base_mode = base_entry.as_ref().map(|(mode, _)| mode.as_str());
            ensure!(
                base_blob == captured_base && base_mode == captured_base_mode,
                "Source conflict for {path}: the base branch changed since this file was opened; saved draft preserved"
            );
            let captured_review = draft
                .provenance
                .get("review_branch_blob")
                .map(|v| v.as_str())
                .unwrap_or(Some(draft.base_blob.as_str()));
            let captured_review_mode = draft
                .provenance
                .get("review_branch_mode")
                .map(|v| v.as_str())
                .unwrap_or(Some(draft.mode.as_str()));
            let head_blob = head_entry.as_ref().map(|(_, blob)| blob.as_str());
            let head_mode = head_entry.as_ref().map(|(mode, _)| mode.as_str());
            ensure!(
                head_blob == captured_review && head_mode == captured_review_mode,
                "Source conflict for {path}: the review branch changed since this file was opened; saved draft preserved"
            );
        }
        let index = self
            .directory()?
            .join(format!("index-{}", Uuid::new_v4().simple()));
        let build = (|| -> Result<(String, Vec<Change>)> {
            git(&bare, &["read-tree", &head], None, Some(&index), 20)?;
            let mut changes = Vec::new();
            for (path, draft) in &dirty {
                let blob = String::from_utf8(git(
                    &bare,
                    &["hash-object", "-w", "--stdin"],
                    Some(draft.content.as_bytes()),
                    None,
                    30,
                )?)?
                .trim()
                .to_owned();
                run_sha(&blob)?;
                let cache = format!("{},{},{}", draft.mode, blob, path);
                git(
                    &bare,
                    &["update-index", "--add", "--cacheinfo", &cache],
                    None,
                    Some(&index),
                    20,
                )?;
                changes.push(Change {
                    path: path.clone(),
                    version: draft.version.clone(),
                    blob,
                });
            }
            let tree = git_text(&bare, &["write-tree"], Some(&index), 30)?;
            run_sha(&tree)?;
            let commit = String::from_utf8(git(
                &bare,
                &[
                    "-c",
                    "user.name=AlcorDesign",
                    "-c",
                    "user.email=alcordesign@localhost",
                    "commit-tree",
                    &tree,
                    "-p",
                    &head,
                ],
                Some(b"Update source from AlcorDesign\n"),
                None,
                30,
            )?)?
            .trim()
            .to_owned();
            run_sha(&commit)?;
            Ok((commit, changes))
        })();
        if index.exists() {
            fs::remove_file(&index)?;
        }
        let (commit, changes) = build?;
        state.base_branch = Some(base.clone());
        let mut pending = Pending {
            transaction_id: request_id.to_owned(),
            requested_base: base.clone(),
            draft_set_version: expected_set.to_owned(),
            commit: commit.clone(),
            previous_remote: before,
            changes,
            state: "uncertain".into(),
        };
        state.pending_sync = Some(pending.clone());
        self.save(&state)?;
        let refspec = format!("{commit}:refs/heads/{}", state.branch);
        let pushed = git(
            &bare,
            &["push", "--quiet", "--no-verify", self.remote, &refspec],
            None,
            None,
            120,
        );
        if let Err(error) = pushed {
            // A failed/timeout push may have succeeded remotely. Preserve the
            // original transaction and let status reconcile it; never replay.
            if error
                .downcast_ref::<GitFailure>()
                .is_some_and(|failure| failure.definitive_rejection)
            {
                pending.state = "settled_rejected".into();
                state.pending_sync = Some(pending.clone());
                self.save(&state)?;
                self.reconcile(&mut state)?;
                if state.pending_sync.is_none() {
                    return Ok(state.last_sync.clone().unwrap_or(json!({})));
                }
            }
            return Ok(
                json!({"project_id":self.project,"branch":state.branch,"base_branch":base,
                "branch_url":self.branch_url(&state.branch),"compare_url":self.compare_url(&base,&state.branch),
                "pushed":null,"uncertain":true,"request_id":request_id,"transaction_id":pending.transaction_id,"draft_set_version":expected_set,
                "pending_sync":pending_json(&pending),"dirty_count":dirty.len(),
                "message":"GitHub sync outcome needs checking. Your drafts and original transaction are preserved; use Check sync."}),
            );
        }
        // Verify the advertised head. If verification is unavailable, retain
        // pending state; status can reconcile this exact transaction later.
        if self
            .remote_head(&bare, &state.branch)
            .ok()
            .flatten()
            .as_deref()
            != Some(&commit)
        {
            return Ok(
                json!({"project_id":self.project,"branch":state.branch,"base_branch":base,
                "branch_url":self.branch_url(&state.branch),"compare_url":self.compare_url(&base,&state.branch),
                "pushed":null,"uncertain":true,"request_id":request_id,"transaction_id":pending.transaction_id,"draft_set_version":expected_set,
                "pending_sync":pending_json(&pending),"dirty_count":dirty.len(),
                "message":"GitHub sync outcome needs checking. Your drafts and original transaction are preserved; use Check sync."}),
            );
        }
        let mut settled = self.settle(&mut state, &pending);
        settled["cached_receipt"] = json!(false);
        state.sync_receipts.insert(
            request_id.to_owned(),
            SyncReceipt {
                base_branch: base.clone(),
                draft_set_version: expected_set.to_owned(),
                result: settled.clone(),
            },
        );
        state.last_sync = Some(settled.clone());
        state.pending_sync = None;
        self.save(&state)?;
        Ok(settled)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Deliberately not "main": several tests sync against "main" to prove a mismatched base is refused.
    const DEFAULT_BASE: &str = "integration/base";
    const REPOSITORY: &str = "https://github.com/owner/repo";

    struct Fixture {
        root: PathBuf,
        source: PathBuf,
        remote: PathBuf,
        data: PathBuf,
    }
    impl Fixture {
        fn new() -> Result<Self> {
            let parent = std::env::temp_dir().join("alcor-design-tests");

            fs::create_dir_all(&parent)?;
            let root = parent.join(format!("source-edit-{}", Uuid::new_v4().simple()));
            fs::create_dir(&root)?;
            let source = root.join("checkout");
            let remote = root.join("remote.git");
            let data = root.join("data");
            fs::create_dir(&source)?;
            fs::create_dir(&data)?;
            git(
                &source,
                &["init", "--quiet", "-b", DEFAULT_BASE],
                None,
                None,
                30,
            )?;
            git(&source, &["config", "user.name", "Fixture"], None, None, 10)?;
            git(
                &source,
                &["config", "user.email", "fixture@example.com"],
                None,
                None,
                10,
            )?;
            git(
                &root,
                &["init", "--bare", "--quiet", "remote.git"],
                None,
                None,
                30,
            )?;
            fs::create_dir_all(source.join("site"))?;
            fs::write(source.join("site/theme.css"), "body { color: black; }\n")?;
            fs::write(source.join("site/page.php"), "<?php echo 'ok';\n")?;
            fs::write(source.join("site/other.txt"), "original\n")?;
            git(&source, &["add", "--", "site"], None, None, 10)?;
            git(
                &source,
                &["commit", "--quiet", "-m", "initial"],
                None,
                None,
                30,
            )?;
            git(
                &source,
                &["remote", "add", "origin", remote.to_str().unwrap()],
                None,
                None,
                10,
            )?;
            git(
                &source,
                &[
                    "push",
                    "--quiet",
                    "origin",
                    &format!("HEAD:refs/heads/{DEFAULT_BASE}"),
                ],
                None,
                None,
                30,
            )?;
            Ok(Self {
                root,
                source,
                remote,
                data,
            })
        }
        fn workspace(&self) -> SourceEdits<'_> {
            SourceEdits {
                repo: &self.source,
                data: &self.data,
                project: "fixture",
                remote: self.remote.to_str().unwrap(),
                repository: REPOSITORY,
                default_base: DEFAULT_BASE,
                source_root: "site",
            }
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            // Delete only this test's verified, explicitly owned fixture folder.
            let parent = self.root.parent().and_then(|p| p.canonicalize().ok());
            let resolved = self.root.canonicalize().ok();
            if let (Some(parent), Some(resolved)) = (parent, resolved) {
                if resolved.parent() == Some(parent.as_path())
                    && resolved
                        .file_name()
                        .is_some_and(|n| n.to_string_lossy().starts_with("source-edit-"))
                {
                    let _ = fs::remove_dir_all(resolved);
                }
            }
        }
    }
    #[test]
    fn source_path_and_branch_validation() {
        assert!(checked_path("site/wp-content/theme.css", "site").is_ok());
        assert!(checked_path("apps/page.php", "").is_ok());
        assert!(checked_path("apps/page.php", "site").is_err());
        for path in [
            "../../page.php",
            "site/../page.php",
            "site/evil.php:evil",
            "other/password.php",
            "site/a\\b.css",
            "site/.git/config.php",
            "site/.github/theme.css",
            "site/node_modules/pkg/theme.css",
            "site/x.css\n",
        ] {
            assert!(checked_path(path, "site").is_err(), "{path}");
        }
        assert!(branch_name(DEFAULT_BASE).is_ok());
        assert!(branch_name("../main").is_err());
    }
    #[test]
    fn saves_are_atomic_and_multi_file_push_does_not_touch_checkout() -> Result<()> {
        let f = Fixture::new()?;
        let w = f.workspace();
        let files = w.files("")?;
        assert_eq!(files["total"], 2);
        let css = w.open(
            "site/theme.css",
            json!({"sha":"captured","basis":"page_capture_commit"}),
        )?;
        let php = w.open("site/page.php", json!({}))?;
        let v = css["version"].as_str().unwrap();
        let first = w.save_source(
            "site/theme.css",
            "body { color: red; }\n",
            v,
            "save-red-001",
        )?;
        let replay = w.save_source(
            "site/theme.css",
            "body { color: red; }\n",
            v,
            "save-red-001",
        )?;
        assert_eq!(replay["version"], first["version"]);
        assert_eq!(replay["cached_receipt"], true);
        assert!(
            w.save_source("site/theme.css", "bad", v, "save-red-001")
                .is_err()
        );
        assert!(
            w.save_source("site/theme.css", "bad", v, "save-bad-001")
                .is_err()
        );
        let second = w.save_source(
            "site/theme.css",
            "body { color: blue; }\n",
            first["version"].as_str().unwrap(),
            "save-blue-001",
        )?;
        assert!(second["dirty"].as_bool().unwrap());
        w.save_source(
            "site/page.php",
            "<?php echo 'changed';\n",
            php["version"].as_str().unwrap(),
            "save-php-0001",
        )?;
        fs::write(f.source.join("site/other.txt"), "unrelated staged change\n")?;
        git(&f.source, &["add", "--", "site/other.txt"], None, None, 10)?;
        let staged = git_text(&f.source, &["diff", "--cached", "--name-only"], None, 10)?;
        let original_head = git_text(&f.source, &["rev-parse", "HEAD"], None, 10)?;
        // Poison the workspace's default hooks. A direct Git commit using our
        // command wrapper must succeed without running this pre-commit hook.
        let hooks = f.root.join("hostile-hooks");
        fs::create_dir(&hooks)?;
        fs::write(
            hooks.join("pre-commit"),
            "#!/bin/sh\nprintf invoked > ../hostile-hook-ran\nexit 17\n",
        )?;
        // Git skips hooks that are not executable, so mark it executable where that matters.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(hooks.join("pre-commit"), fs::Permissions::from_mode(0o755))?;
        }
        git(
            &f.source,
            &["config", "core.hooksPath", hooks.to_str().unwrap()],
            None,
            None,
            10,
        )?;
        // Positive control: ordinary Git must execute and fail this hostile hook.
        let mut control = Command::new("git");
        control.arg("-C").arg(&f.source).args([
            "commit",
            "--quiet",
            "--allow-empty",
            "-m",
            "hook control",
        ]);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            control.creation_flags(0x0800_0000);
        }
        let attempt = control.output()?;
        let marker = f.root.join("hostile-hook-ran");
        assert!(
            !attempt.status.success() && marker.is_file(),
            "fixture hook must actually run"
        );
        fs::remove_file(&marker)?;
        git(
            &f.source,
            &["commit", "--quiet", "--allow-empty", "-m", "hooks disabled"],
            None,
            None,
            30,
        )?;
        assert!(!marker.exists(), "source commands must not run Git hooks");
        let after_test_head = git_text(&f.source, &["rev-parse", "HEAD"], None, 10)?;
        assert_ne!(original_head, after_test_head);
        fs::write(
            f.source.join("site/other.txt"),
            "second unrelated staged change\n",
        )?;
        git(&f.source, &["add", "--", "site/other.txt"], None, None, 10)?;
        assert_eq!(
            staged,
            git_text(&f.source, &["diff", "--cached", "--name-only"], None, 10)?
        );
        let sync_set = w.status()?["draft_set_version"]
            .as_str()
            .unwrap()
            .to_owned();
        let result = w.sync(None, "sync-first-001", &sync_set)?;
        assert_eq!(result["pushed"], true);
        assert_eq!(result["changed_files"].as_array().unwrap().len(), 2);
        assert_eq!(w.status()?["dirty_count"], 0);
        assert_eq!(
            git_text(
                &f.remote,
                &["show", "refs/heads/alcordesign/fixture:site/theme.css"],
                None,
                10
            )?,
            "body { color: blue; }"
        );
        assert_eq!(
            git_text(&f.source, &["rev-parse", "HEAD"], None, 10)?,
            after_test_head
        );
        assert_eq!(
            git_text(&f.source, &["diff", "--cached", "--name-only"], None, 10)?,
            staged
        );
        assert_eq!(
            fs::read_to_string(f.source.join("site/theme.css"))?,
            "body { color: black; }\n"
        );
        // A delayed identical browser retry after an app/workspace reopen must
        // return the old commit, even if newer unsynced edits now exist.
        let reopened = f.workspace();
        let current = reopened.open("site/theme.css", json!({}))?;
        reopened.save_source(
            "site/theme.css",
            "body { color: green; }\n",
            current["version"].as_str().unwrap(),
            "save-next-001",
        )?;
        let replay = reopened.sync(None, "sync-first-001", &sync_set)?;
        assert_eq!(replay["commit"], result["commit"]);
        assert_eq!(replay["cached_receipt"], true);
        assert_eq!(reopened.status()?["dirty_count"], 1);
        assert!(
            reopened
                .sync(Some("main"), "sync-first-001", &sync_set)
                .is_err()
        );
        let save_status = reopened.operation_status("save-red-001")?;
        assert_eq!(save_status["state"], "completed");
        assert_eq!(save_status["result"]["version"], first["version"]);
        assert!(save_status["result"].get("content").is_none());
        Ok(())
    }
    #[test]
    fn base_conflict_preserves_draft_and_remote_branch() -> Result<()> {
        let f = Fixture::new()?;
        let w = f.workspace();
        let original = w.open("site/theme.css", json!({}))?;
        let edited = w.save_source(
            "site/theme.css",
            "body { color: violet; }\n",
            original["version"].as_str().unwrap(),
            "save-violet-1",
        )?;
        fs::write(f.source.join("site/theme.css"), "body { color: green; }\n")?;
        git(&f.source, &["add", "--", "site/theme.css"], None, None, 10)?;
        git(
            &f.source,
            &["commit", "--quiet", "-m", "concurrent base edit"],
            None,
            None,
            30,
        )?;
        git(
            &f.source,
            &[
                "push",
                "--quiet",
                "origin",
                &format!("HEAD:refs/heads/{DEFAULT_BASE}"),
            ],
            None,
            None,
            30,
        )?;
        let sync_set = w.status()?["draft_set_version"]
            .as_str()
            .unwrap()
            .to_owned();
        let failed = w.sync(None, "sync-conflict-1", &sync_set)?;
        assert_eq!(failed["pushed"], false);
        assert!(
            failed["message"]
                .as_str()
                .unwrap()
                .contains("base branch changed")
        );
        assert_eq!(
            w.sync(None, "sync-conflict-1", &sync_set)?["cached_receipt"],
            true
        );
        let retained = w.open("site/theme.css", json!({}))?;
        assert_eq!(retained["content"], edited["content"]);
        assert_eq!(w.status()?["dirty_count"], 1);
        assert!(w.remote_head(&w.bare()?, "alcordesign/fixture")?.is_none());
        Ok(())
    }
    #[test]
    fn delayed_first_delivery_and_same_id_retry_never_apply_newer_drafts() -> Result<()> {
        let f = Fixture::new()?;
        let w = f.workspace();
        let opened = w.open("site/theme.css", json!({}))?;
        let base = opened["version"].as_str().unwrap();
        let save_id = "delayed-save-001";
        assert_eq!(w.operation_status(save_id)?["state"], "not_found");
        let first = w.save_source("site/theme.css", "body { color: red; }\n", base, save_id)?;
        let retry = w.save_source("site/theme.css", "body { color: red; }\n", base, save_id)?;
        assert_eq!(first["version"], retry["version"]);
        assert_eq!(retry["cached_receipt"], true);
        assert!(
            w.save_source("site/theme.css", "different", base, save_id)
                .is_err()
        );
        assert_eq!(w.operation_status(save_id)?["state"], "completed");

        let sync_id = "delayed-sync-001";
        assert_eq!(w.operation_status(sync_id)?["state"], "not_found");
        // Another window saves a new file before the original sync arrives.
        // It must reject the stale set rather than silently push that file.
        let old_set = w.status()?["draft_set_version"]
            .as_str()
            .unwrap()
            .to_owned();
        let php = w.open("site/page.php", json!({}))?;
        w.save_source(
            "site/page.php",
            "<?php echo 'new';\n",
            php["version"].as_str().unwrap(),
            "later-php-001",
        )?;
        let stale = w.sync(None, sync_id, &old_set)?;
        assert_eq!(stale["code"], "draft_set_changed");
        assert_eq!(stale["pushed"], false);
        assert!(w.remote_head(&w.bare()?, "alcordesign/fixture")?.is_none());
        let current_set = w.status()?["draft_set_version"]
            .as_str()
            .unwrap()
            .to_owned();
        assert!(w.sync(None, sync_id, &current_set).is_err());
        assert_eq!(w.sync(None, sync_id, &old_set)?["cached_receipt"], true);
        // A new explicit request with the reviewed current set pushes once.
        let accepted_id = "delayed-sync-002";
        assert_eq!(w.operation_status(accepted_id)?["state"], "not_found");
        let first = w.sync(None, accepted_id, &current_set)?;
        assert_eq!(first["pushed"], true);
        let retry = w.sync(None, accepted_id, &current_set)?;
        assert_eq!(first["commit"], retry["commit"]);
        assert_eq!(retry["cached_receipt"], true);
        assert!(w.sync(Some("main"), accepted_id, &current_set).is_err());

        // A newer draft after restart must stay local when an arbitrarily late
        // delivery of the original request returns its saved receipt.
        let reopened = f.workspace();
        let current = reopened.open("site/theme.css", json!({}))?;
        reopened.save_source(
            "site/theme.css",
            "body { color: green; }\n",
            current["version"].as_str().unwrap(),
            "later-save-001",
        )?;
        assert_eq!(
            reopened.sync(None, accepted_id, &current_set)?["commit"],
            first["commit"]
        );
        assert_eq!(
            reopened.sync(None, sync_id, &old_set)?["code"],
            "draft_set_changed"
        );
        assert_eq!(reopened.status()?["dirty_count"], 1);
        assert_eq!(
            reopened
                .remote_head(&reopened.bare()?, "alcordesign/fixture")?
                .as_deref(),
            first["commit"].as_str()
        );
        Ok(())
    }
    #[test]
    fn promoted_review_branch_fast_forwards_from_current_preview_base() -> Result<()> {
        let f = Fixture::new()?;
        let w = f.workspace();
        let opened = w.open("site/theme.css", json!({}))?;
        w.save_source(
            "site/theme.css",
            "body { color: red; }\n",
            opened["version"].as_str().unwrap(),
            "save-feature-1",
        )?;
        let set = w.status()?["draft_set_version"]
            .as_str()
            .unwrap()
            .to_owned();
        let feature = w.sync(None, "sync-feature-1", &set)?["commit"]
            .as_str()
            .unwrap()
            .to_owned();
        // Preview integrates the review branch and advances again.
        git(
            &f.source,
            &[
                "fetch",
                "--quiet",
                "origin",
                "refs/heads/alcordesign/fixture",
            ],
            None,
            None,
            30,
        )?;
        git(
            &f.source,
            &["merge", "--quiet", "--ff-only", "FETCH_HEAD"],
            None,
            None,
            30,
        )?;
        fs::write(f.source.join("site/theme.css"), "body { color: teal; }\n")?;
        fs::write(f.source.join("site/added.php"), "<?php echo 'new base';\n")?;
        git(
            &f.source,
            &["add", "--", "site/theme.css", "site/added.php"],
            None,
            None,
            10,
        )?;
        git(
            &f.source,
            &["commit", "--quiet", "-m", "preview advances"],
            None,
            None,
            30,
        )?;
        git(
            &f.source,
            &[
                "push",
                "--quiet",
                "origin",
                &format!("HEAD:refs/heads/{DEFAULT_BASE}"),
            ],
            None,
            None,
            30,
        )?;
        let preview = git_text(&f.source, &["rev-parse", "HEAD"], None, 10)?;
        let files = w.files("")?;
        assert_eq!(files["sha"], preview);
        assert!(
            files["files"]
                .as_array()
                .unwrap()
                .iter()
                .any(|f| f["path"] == "site/added.php")
        );
        let opened = w.open("site/theme.css", json!({}))?;
        assert_eq!(opened["content"], "body { color: teal; }\n");
        assert_eq!(opened["base_sha"], preview);
        w.save_source(
            "site/theme.css",
            "body { color: navy; }\n",
            opened["version"].as_str().unwrap(),
            "save-after-promotion-1",
        )?;
        let set = w.status()?["draft_set_version"]
            .as_str()
            .unwrap()
            .to_owned();
        let result = w.sync(None, "sync-after-promotion-1", &set)?;
        assert_eq!(result["pushed"], true);
        let new_head = result["commit"].as_str().unwrap();
        assert_eq!(
            git_text(&f.remote, &["merge-base", &feature, new_head], None, 10)?,
            feature
        );
        assert_eq!(
            git_text(&f.remote, &["merge-base", &preview, new_head], None, 10)?,
            preview
        );
        assert_eq!(
            git_text(
                &f.remote,
                &["show", &format!("{new_head}:site/added.php")],
                None,
                10
            )?,
            "<?php echo 'new base';"
        );
        Ok(())
    }
    #[test]
    fn diverged_same_file_conflicts_and_safe_base_only_files_survive() -> Result<()> {
        let f = Fixture::new()?;
        let w = f.workspace();
        let opened = w.open("site/theme.css", json!({}))?;
        w.save_source(
            "site/theme.css",
            "body { color: red; }\n",
            opened["version"].as_str().unwrap(),
            "save-diverge-1",
        )?;
        let set = w.status()?["draft_set_version"]
            .as_str()
            .unwrap()
            .to_owned();
        let feature = w.sync(None, "sync-diverge-1", &set)?["commit"]
            .as_str()
            .unwrap()
            .to_owned();
        // Base independently changes the same CSS, a separate PHP file, and
        // adds a new PHP file which is absent on the review branch.
        fs::write(f.source.join("site/theme.css"), "body { color: teal; }\n")?;
        fs::write(
            f.source.join("site/page.php"),
            "<?php echo 'base change';\n",
        )?;
        fs::write(f.source.join("site/added.php"), "<?php echo 'added';\n")?;
        git(
            &f.source,
            &[
                "add",
                "--",
                "site/theme.css",
                "site/page.php",
                "site/added.php",
            ],
            None,
            None,
            10,
        )?;
        git(
            &f.source,
            &["commit", "--quiet", "-m", "diverging preview changes"],
            None,
            None,
            30,
        )?;
        git(
            &f.source,
            &[
                "push",
                "--quiet",
                "origin",
                &format!("HEAD:refs/heads/{DEFAULT_BASE}"),
            ],
            None,
            None,
            30,
        )?;
        assert!(
            format!("{:#}", w.open("site/theme.css", json!({})).unwrap_err())
                .contains("both the preview base and review branch changed")
        );
        let files = w.files("")?;
        assert!(
            files["files"]
                .as_array()
                .unwrap()
                .iter()
                .any(|f| f["path"] == "site/added.php")
        );
        let page = w.open("site/page.php", json!({}))?;
        assert_eq!(page["content"], "<?php echo 'base change';\n");
        assert_eq!(page["provenance"]["branches_diverged"], true);
        let added = w.open("site/added.php", json!({}))?;
        assert!(added["provenance"]["review_branch_blob"].is_null());
        w.save_source(
            "site/page.php",
            "<?php echo 'my page';\n",
            page["version"].as_str().unwrap(),
            "save-base-page-1",
        )?;
        w.save_source(
            "site/added.php",
            "<?php echo 'my added';\n",
            added["version"].as_str().unwrap(),
            "save-base-added-1",
        )?;
        let set = w.status()?["draft_set_version"]
            .as_str()
            .unwrap()
            .to_owned();
        let result = w.sync(None, "sync-base-only-1", &set)?;
        assert_eq!(result["pushed"], true);
        let head = result["commit"].as_str().unwrap();
        assert_eq!(
            git_text(&f.remote, &["merge-base", &feature, head], None, 10)?,
            feature
        );
        assert_eq!(
            git_text(
                &f.remote,
                &["show", &format!("{head}:site/page.php")],
                None,
                10
            )?,
            "<?php echo 'my page';"
        );
        assert_eq!(
            git_text(
                &f.remote,
                &["show", &format!("{head}:site/added.php")],
                None,
                10
            )?,
            "<?php echo 'my added';"
        );
        assert_eq!(
            git_text(
                &f.remote,
                &["show", &format!("{head}:site/theme.css")],
                None,
                10
            )?,
            "body { color: red; }"
        );
        fs::remove_file(f.source.join("site/theme.css"))?;
        git(
            &f.source,
            &["add", "-u", "--", "site/theme.css"],
            None,
            None,
            10,
        )?;
        git(
            &f.source,
            &["commit", "--quiet", "-m", "delete preview stylesheet"],
            None,
            None,
            30,
        )?;
        git(
            &f.source,
            &[
                "push",
                "--quiet",
                "origin",
                &format!("HEAD:refs/heads/{DEFAULT_BASE}"),
            ],
            None,
            None,
            30,
        )?;
        assert!(
            w.open("site/theme.css", json!({})).is_err(),
            "deleted preview files cannot be silently resurrected"
        );
        assert_eq!(
            w.remote_head(&w.bare()?, "alcordesign/fixture")?.as_deref(),
            Some(head)
        );
        Ok(())
    }
    #[test]
    fn review_branch_deletion_is_not_resurrected_from_preview() -> Result<()> {
        let f = Fixture::new()?;
        let w = f.workspace();
        git(
            &f.source,
            &["switch", "--quiet", "-c", "alcordesign/fixture"],
            None,
            None,
            20,
        )?;
        fs::remove_file(f.source.join("site/page.php"))?;
        git(
            &f.source,
            &["add", "-u", "--", "site/page.php"],
            None,
            None,
            10,
        )?;
        git(
            &f.source,
            &["commit", "--quiet", "-m", "remove page on review"],
            None,
            None,
            30,
        )?;
        git(
            &f.source,
            &[
                "push",
                "--quiet",
                "origin",
                "HEAD:refs/heads/alcordesign/fixture",
            ],
            None,
            None,
            30,
        )?;
        git(
            &f.source,
            &["switch", "--quiet", DEFAULT_BASE],
            None,
            None,
            20,
        )?;
        fs::write(f.source.join("site/theme.css"), "body { color: teal; }\n")?;
        git(&f.source, &["add", "--", "site/theme.css"], None, None, 10)?;
        git(
            &f.source,
            &["commit", "--quiet", "-m", "unrelated preview change"],
            None,
            None,
            30,
        )?;
        git(
            &f.source,
            &[
                "push",
                "--quiet",
                "origin",
                &format!("HEAD:refs/heads/{DEFAULT_BASE}"),
            ],
            None,
            None,
            30,
        )?;
        let rows = w.files("")?["files"].as_array().unwrap().clone();
        assert!(
            !rows.iter().any(|row| row["path"] == "site/page.php"),
            "branch deletion must stay absent"
        );
        assert!(
            w.open("site/page.php", json!({})).is_err(),
            "opening must not resurrect the deleted file"
        );
        // If preview also changes the deleted file, expose an explicit
        // noneditable conflict and leave both histories untouched.
        fs::write(
            f.source.join("site/page.php"),
            "<?php echo 'preview changed';\n",
        )?;
        git(&f.source, &["add", "--", "site/page.php"], None, None, 10)?;
        git(
            &f.source,
            &["commit", "--quiet", "-m", "conflicting preview change"],
            None,
            None,
            30,
        )?;
        git(
            &f.source,
            &[
                "push",
                "--quiet",
                "origin",
                &format!("HEAD:refs/heads/{DEFAULT_BASE}"),
            ],
            None,
            None,
            30,
        )?;
        let rows = w.files("")?["files"].as_array().unwrap().clone();
        let conflict = rows
            .iter()
            .find(|row| row["path"] == "site/page.php")
            .unwrap();
        assert_eq!(conflict["conflict"], true);
        assert_eq!(conflict["editable"], false);
        assert_eq!(
            conflict["source_sha"],
            git_text(&f.source, &["rev-parse", "HEAD"], None, 10)?
        );
        assert_eq!(conflict["editing_ref"], DEFAULT_BASE);
        assert!(
            format!("{:#}", w.open("site/page.php", json!({})).unwrap_err())
                .contains("both the preview base and review branch changed")
        );
        Ok(())
    }
    #[test]
    fn uncertain_push_is_not_retried_or_cleared_when_remote_head_is_unchanged() -> Result<()> {
        let f = Fixture::new()?;
        let w = f.workspace();
        let opened = w.open("site/theme.css", json!({}))?;
        w.save_source(
            "site/theme.css",
            "body { color: orange; }\n",
            opened["version"].as_str().unwrap(),
            "save-orange-1",
        )?;
        let mut state = w.load()?;
        let original = state.files["site/theme.css"].clone();
        let sync_set = draft_set_version(&draft_versions(&state));
        let commit = git_text(&f.source, &["rev-parse", "HEAD"], None, 10)?;
        state.pending_sync = Some(Pending {
            transaction_id: "uncertain-test".into(),
            requested_base: DEFAULT_BASE.into(),
            draft_set_version: sync_set.clone(),
            commit: commit.clone(),
            previous_remote: None,
            changes: vec![Change {
                path: "site/theme.css".into(),
                version: original.version.clone(),
                blob: original.base_blob.clone(),
            }],
            state: "uncertain".into(),
        });
        w.save(&state)?;
        let status = w.status()?;
        assert_eq!(status["pending_sync"]["state"], "uncertain");
        state.sync_reservations.insert(
            "uncertain-test".into(),
            SyncReservation {
                base_branch: DEFAULT_BASE.into(),
                draft_set_version: sync_set.clone(),
                files: BTreeMap::new(),
            },
        );
        w.save(&state)?;
        let replay = w.sync(None, "uncertain-test", &sync_set)?;
        assert_eq!(replay["uncertain"], true);
        assert_eq!(replay["cached_receipt"], true);
        assert!(w.sync(None, "another-sync-1", &sync_set).is_err());
        assert_eq!(w.load()?.files["site/theme.css"].content, original.content);
        // An explicit settled rejection plus independently unchanged branch
        // can safely reopen sync; no push is performed by status.
        let mut state = w.load()?;
        state.pending_sync.as_mut().unwrap().state = "settled_rejected".into();
        w.save(&state)?;
        let status = w.status()?;
        assert!(status["pending_sync"].is_null());
        assert_eq!(status["last_sync"]["state"], "not_pushed");
        assert_eq!(status["dirty_count"], 1);
        Ok(())
    }
    #[test]
    fn successful_original_transaction_reconciles_without_new_push() -> Result<()> {
        let f = Fixture::new()?;
        let w = f.workspace();
        let opened = w.open("site/theme.css", json!({}))?;
        w.save_source(
            "site/theme.css",
            "body { color: purple; }\n",
            opened["version"].as_str().unwrap(),
            "save-purple-1",
        )?;
        let mut state = w.load()?;
        let draft = state.files["site/theme.css"].clone();
        let sync_set = draft_set_version(&draft_versions(&state));
        let head = git_text(&f.source, &["rev-parse", "HEAD"], None, 10)?;
        let bare = w.bare()?;
        let index = f.root.join("test-index");
        git(&bare, &["read-tree", &head], None, Some(&index), 10)?;
        let blob = String::from_utf8(git(
            &bare,
            &["hash-object", "-w", "--stdin"],
            Some(draft.content.as_bytes()),
            None,
            10,
        )?)?
        .trim()
        .to_owned();
        git(
            &bare,
            &[
                "update-index",
                "--add",
                "--cacheinfo",
                &format!("100644,{blob},site/theme.css"),
            ],
            None,
            Some(&index),
            10,
        )?;
        let tree = git_text(&bare, &["write-tree"], Some(&index), 10)?;
        let commit = String::from_utf8(git(
            &bare,
            &[
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@example.com",
                "commit-tree",
                &tree,
                "-p",
                &head,
            ],
            Some(b"Pending transaction\n"),
            None,
            10,
        )?)?
        .trim()
        .to_owned();
        state.pending_sync = Some(Pending {
            transaction_id: "completed-test".into(),
            requested_base: DEFAULT_BASE.into(),
            draft_set_version: sync_set,
            commit: commit.clone(),
            previous_remote: None,
            changes: vec![Change {
                path: "site/theme.css".into(),
                version: draft.version.clone(),
                blob,
            }],
            state: "uncertain".into(),
        });
        w.save(&state)?;
        git(
            &bare,
            &[
                "push",
                "--quiet",
                f.remote.to_str().unwrap(),
                &format!("{commit}:refs/heads/alcordesign/fixture"),
            ],
            None,
            None,
            30,
        )?;
        let status = w.status()?;
        assert!(status["pending_sync"].is_null());
        assert_eq!(status["last_sync"]["pushed"], true);
        assert_eq!(status["last_sync"]["transaction_id"], "completed-test");
        assert_eq!(status["dirty_count"], 0);
        assert_eq!(
            w.remote_head(&w.bare()?, "alcordesign/fixture")?.as_deref(),
            Some(commit.as_str())
        );
        assert_eq!(
            git_text(
                &f.remote,
                &["show", "refs/heads/alcordesign/fixture:site/theme.css"],
                None,
                10
            )?,
            "body { color: purple; }"
        );
        Ok(())
    }
    #[tokio::test]
    async fn cancelled_request_does_not_release_inflight_source_lock() {
        let lock = std::sync::Arc::new(tokio::sync::Mutex::new(()));
        let owned = lock.clone().lock_owned().await;
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let request = tokio::spawn(async move {
            let _ = tokio::task::spawn_blocking(move || {
                let _owned = owned;
                let _ = started_tx.send(());
                let _ = release_rx.recv();
            })
            .await;
        });
        started_rx.await.unwrap();
        request.abort();
        let _ = request.await;
        assert!(
            tokio::time::timeout(Duration::from_millis(100), lock.lock())
                .await
                .is_err()
        );
        release_tx.send(()).unwrap();
        assert!(
            tokio::time::timeout(Duration::from_secs(2), lock.lock())
                .await
                .is_ok()
        );
    }
    #[test]
    fn timeout_does_not_wait_for_descendant_inheriting_pipes() {
        // The owned Python parent launches a short-lived fixture child which
        // inherits stdout/stderr; no other process is inspected or stopped.
        for parent_tail in ["time.sleep(20)", "pass"] {
            let script = format!(
                "import os,subprocess,sys,time; subprocess.Popen([sys.executable,'-c','import time; time.sleep(5)'],stdout=sys.stdout,stderr=sys.stderr,close_fds=False,creationflags=(0x08000000 if os.name=='nt' else 0)); {parent_tail}"
            );
            let mut command = Command::new(if cfg!(windows) { "python" } else { "python3" });
            command
                .args(["-c", &script])
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                command.creation_flags(0x0800_0000);
            }
            let started = Instant::now();
            let result = run_git_command(command, None, 1);
            assert!(result.is_err());
            assert!(
                started.elapsed() < Duration::from_secs(4),
                "pipe reader outlived the timeout"
            );
            assert!(
                !result
                    .unwrap_err()
                    .downcast_ref::<GitFailure>()
                    .unwrap()
                    .definitive_rejection
            );
        }
    }
}
