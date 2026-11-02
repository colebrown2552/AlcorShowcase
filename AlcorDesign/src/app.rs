//! Application state, tool dispatch and the authenticated localhost HTTP API.
//!
//! Every editor action, whether it comes from the browser UI, the MCP adapter or the
//! one-shot CLI, is a named tool handled by [`App::tool`]. Page edits are revision-checked,
//! re-rendered through the Chromium worker and saved atomically, so the UI, agents and
//! exports all see one consistent project store.
use anyhow::{Context, Result, bail, ensure};
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Path, Request, State},
    http::{HeaderMap, HeaderValue, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    io::Write,
    path::{Path as FsPath, PathBuf},
    sync::{Arc, Mutex},
};
use tokio::io::AsyncWriteExt;
use uuid::Uuid;

/// Base URL for raw HTML imports that do not name one. `.invalid` never resolves,
/// so relative links in a pasted snapshot cannot reach a real host.
const HTML_BASE: &str = "https://alcordesign.invalid/";
fn uid() -> String {
    Uuid::new_v4().simple().to_string()
}
fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
}

/// One rendered page: its capture, layer tree, edit history and comments.
#[derive(Clone, Serialize, Deserialize)]
pub struct Page {
    /// Stable page ID within its project.
    pub id: String,
    /// Document title from the latest capture.
    pub title: String,
    /// Live URL, or the base URL of a raw HTML snapshot.
    pub url: String,
    /// `discovered`, `loading`, `ready` or `error`.
    pub status: String,
    /// Viewport and document size of the latest capture.
    pub viewport: Value,
    /// `/files/...` path of the full-page PNG.
    pub screenshot: String,
    /// Incremented on every saved capture; edits must name the revision they read.
    pub revision: u64,
    /// Rendered layer tree with geometry and computed styles.
    #[serde(default)]
    pub nodes: Vec<Value>,
    /// Capture warnings shown next to the page.
    #[serde(default)]
    pub warnings: Vec<String>,
    /// Sanitised HTML snapshot that later edits are applied to.
    #[serde(default)]
    pub html: String,
    /// Edits applied since the last undo or redo.
    #[serde(default)]
    pub edits: Vec<Value>,
    /// Earlier HTML snapshots for undo, newest last (bounded).
    #[serde(default)]
    pub history: Vec<String>,
    /// Snapshots for redo, newest last.
    #[serde(default)]
    pub future: Vec<String>,
    /// Deployed Git commit reported by the site, when it reports one.
    #[serde(default)]
    pub commit: String,
    /// Pinned comment threads.
    #[serde(default)]
    pub comments: Vec<Value>,
    /// How the page was discovered and its sitemap membership.
    #[serde(default)]
    pub discovery: Value,
    /// Digest established only by a fresh, unedited live URL capture.
    #[serde(default)]
    pub live_baseline: String,
    /// Enables recovery if a refresh completes but its receipt write is interrupted.
    #[serde(default)]
    pub last_live_refresh: Value,
    /// Durable per-page proof of all completed refresh/restore operations.
    #[serde(default)]
    pub live_refresh_history: BTreeMap<String, Value>,
}
impl Page {
    fn pending(url: String, title: String) -> Self {
        Self {
            id: uid(),
            title,
            url,
            status: "discovered".into(),
            viewport: json!({"width":1440,"height":1000}),
            screenshot: String::new(),
            revision: 0,
            nodes: vec![],
            warnings: vec![],
            html: String::new(),
            edits: vec![],
            history: vec![],
            future: vec![],
            commit: String::new(),
            comments: vec![],
            discovery: json!({}),
            live_baseline: String::new(),
            last_live_refresh: Value::Null,
            live_refresh_history: BTreeMap::new(),
        }
    }
    fn view(&self, full: bool) -> Value {
        let mut v = json!({"id":self.id,"title":self.title,"url":self.url,"status":self.status,"viewport":self.viewport,"screenshot":self.screenshot,"revision":self.revision,"node_count":self.nodes.len(),"warnings":self.warnings,"commit":self.commit,"can_undo":!self.history.is_empty(),"can_redo":!self.future.is_empty()});
        if full {
            v["nodes"] = json!(self.nodes);
            v["edits"] = json!(self.edits);
            v["comments"] = json!(self.comments);
            v["live_refresh"] = json!({"known_clean":crate::live_refresh::known_clean(self),"baseline_recorded":!self.live_baseline.is_empty()});
        }
        v
    }
}
/// A design project: where it came from and its pages.
#[derive(Clone, Serialize, Deserialize)]
pub struct Project {
    /// Stable project ID, also its folder name under `projects/`.
    pub id: String,
    /// Display name.
    pub name: String,
    /// Import kind (`site`, `github` or `html`), URL and source provenance.
    pub source: Value,
    /// Pages in discovery order.
    pub pages: Vec<Page>,
    /// Incremented on every saved change to the project.
    pub revision: u64,
    /// Creation time in Unix seconds.
    pub created: u64,
    /// Import or render job currently attached to the project.
    pub job_id: Option<String>,
}
impl Project {
    fn view(&self) -> Value {
        json!({"id":self.id,"name":self.name,"source":self.source,"pages":self.pages.iter().map(|p|p.view(false)).collect::<Vec<_>>(),"revision":self.revision,"created":self.created,"job_id":self.job_id})
    }
    fn summary(&self) -> Value {
        json!({"id":self.id,"name":self.name,"page_count":self.pages.len(),"source":self.source,"revision":self.revision,"created":self.created,"job_id":self.job_id})
    }
}
struct ActiveRefreshWorker {
    active: Arc<Mutex<BTreeSet<String>>>,
    job_id: String,
}
impl Drop for ActiveRefreshWorker {
    fn drop(&mut self) {
        self.active.lock().unwrap().remove(&self.job_id);
    }
}
/// Shared application state behind the HTTP API, MCP adapter and CLI.
pub struct App {
    /// Folder holding `ui/` and `renderer/`.
    pub app_dir: PathBuf,
    /// Git checkout of the configured GitHub repository, when source browsing is on.
    pub repo: Option<PathBuf>,
    /// Data directory for projects, captures, exports and `runtime.json`.
    pub data: PathBuf,
    /// Port the listener is actually bound to.
    pub port: u16,
    /// Flags and environment resolved at start-up.
    pub config: crate::config::Config,
    token: String,
    projects: Mutex<BTreeMap<String, Project>>,
    jobs: Mutex<BTreeMap<String, Value>>,
    active_refresh_workers: Arc<Mutex<BTreeSet<String>>>,
    render_limit: tokio::sync::Semaphore,
    edit_lock: tokio::sync::Mutex<()>,
    source_edit_lock: Arc<tokio::sync::Mutex<()>>,
    source_observations: Mutex<BTreeMap<String, (std::time::Instant, Value)>>,
    collaboration: Mutex<crate::collaboration::Room>,
    /// HEAD of the checkout at start-up, or empty when no checkout is configured.
    pub sha: String,
}
impl App {
    /// Load saved projects and, when GitHub is configured, verify the checkout's origin.
    ///
    /// Pages left mid-import by a crash are marked as errors so they can be re-rendered.
    ///
    /// # Errors
    /// Fails when the data directory cannot be read, or when a GitHub repository is
    /// configured but `repo` is missing or its `origin` remote points elsewhere.
    pub fn new(
        app_dir: PathBuf,
        repo: Option<PathBuf>,
        data: PathBuf,
        port: u16,
        config: crate::config::Config,
    ) -> Result<Self> {
        std::fs::create_dir_all(data.join("projects"))?;
        let mut projects = BTreeMap::new();
        for entry in std::fs::read_dir(data.join("projects"))?.flatten() {
            let file = entry.path().join("project.json");
            let Ok(file) = std::fs::File::open(file) else {
                continue;
            };
            let Ok(mut p) = serde_json::from_reader::<_, Project>(std::io::BufReader::new(file))
            else {
                continue;
            };
            for page in &mut p.pages {
                if page.status == "loading" || page.status == "discovered" {
                    page.status = "error".into();
                    page.warnings
                        .push("Import was interrupted; render this page to resume.".into());
                }
            }
            p.job_id = None;
            projects.insert(p.id.clone(), p);
        }
        let sha = match (&config.github, &repo) {
            (Some(github), Some(checkout)) => {
                let remote = git(checkout, &["remote", "get-url", "origin"])?;
                ensure!(
                    github.matches_remote(&remote),
                    "The checkout's origin is not {}",
                    github.web_url()
                );
                git(checkout, &["rev-parse", "HEAD"])?
            }
            (Some(_), None) => bail!("A GitHub repository is configured but no checkout was given"),
            (None, _) => String::new(),
        };
        Ok(Self {
            app_dir,
            repo,
            data,
            port,
            config,
            token: format!("{}{}", uid(), uid()),
            projects: Mutex::new(projects),
            jobs: Mutex::new(BTreeMap::new()),
            active_refresh_workers: Arc::new(Mutex::new(BTreeSet::new())),
            render_limit: tokio::sync::Semaphore::new(2),
            edit_lock: tokio::sync::Mutex::new(()),
            source_edit_lock: Arc::new(tokio::sync::Mutex::new(())),
            source_observations: Mutex::new(BTreeMap::new()),
            collaboration: Mutex::new(crate::collaboration::Room::default()),
            sha,
        })
    }
    /// Write `runtime.json`, which tells local MCP and CLI clients the port and bearer token.
    ///
    /// # Errors
    /// Fails when the descriptor cannot be written atomically.
    pub fn write_runtime(&self) -> Result<()> {
        save_json(
            &self.data.join("runtime.json"),
            &json!({"port":self.port,"token":self.token,"pid":std::process::id(),"app_dir":self.app_dir,"repo":self.repo,"sha":self.sha,"version":"0.1.0"}),
        )
    }
    /// The checkout used for source browsing, or the configuration error explaining how to add one.
    fn checkout(&self) -> Result<&FsPath> {
        self.config.require_github()?;
        self.repo
            .as_deref()
            .context("No repository checkout is configured")
    }
    fn project(&self, id: &str) -> Result<Project> {
        self.projects
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .context("Project not found")
    }
    fn project_view(&self, id: &str) -> Result<Value> {
        let projects = self.projects.lock().unwrap();
        Ok(projects.get(id).context("Project not found")?.view())
    }
    fn save(&self, p: Project) -> Result<()> {
        save_json(
            &self.data.join("projects").join(&p.id).join("project.json"),
            &p,
        )?;
        self.projects.lock().unwrap().insert(p.id.clone(), p);
        Ok(())
    }
    fn job(&self, id: &str, patch: Value) {
        let mut jobs = self.jobs.lock().unwrap();
        let j = jobs.entry(id.into()).or_insert(json!({"id":id}));
        for (k, v) in patch.as_object().unwrap() {
            j[k] = v.clone();
        }
    }
    fn update_page(&self, id: &str, mut page: Page) -> Result<()> {
        let mut all = self.projects.lock().unwrap();
        let p = all.get_mut(id).context("Project not found")?;
        let index = p
            .pages
            .iter()
            .position(|x| x.id == page.id)
            .context("Page not found")?;
        page.comments = p.pages[index].comments.clone();
        page.discovery = p.pages[index].discovery.clone();
        if page.last_live_refresh["request_id"].is_string() {
            crate::live_refresh::comment_warnings(&mut page);
        }
        let previous_page = std::mem::replace(&mut p.pages[index], page);
        let previous_revision = p.revision;
        p.revision += 1;
        if let Err(error) = save_json(&self.data.join("projects").join(id).join("project.json"), p)
        {
            p.pages[index] = previous_page;
            p.revision = previous_revision;
            return Err(error);
        }
        Ok(())
    }
    async fn worker(&self, request: Value) -> Result<Value> {
        let _permit = self.render_limit.acquire().await?;
        let output = request["output_dir"]
            .as_str()
            .context("Missing output directory")?;
        std::fs::create_dir_all(output)?;
        let mut child = tokio::process::Command::new(
            std::env::var_os("ALCORDESIGN_NODE").unwrap_or_else(|| "node".into()),
        )
        .arg(self.app_dir.join("renderer/worker.mjs"))
        .current_dir(&self.app_dir)
        // The worker refuses to write outside this directory.
        .env("ALCORDESIGN_DATA_DIR", &self.data)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .context("Could not launch Chromium renderer")?;
        child
            .stdin
            .take()
            .unwrap()
            .write_all(serde_json::to_string(&request)?.as_bytes())
            .await?;
        let out = tokio::time::timeout(
            std::time::Duration::from_secs(240),
            child.wait_with_output(),
        )
        .await
        .context("Renderer exceeded 240 seconds")??;
        let v: Value = serde_json::from_slice(&out.stdout).with_context(|| {
            format!(
                "Renderer returned invalid JSON: {}",
                String::from_utf8_lossy(&out.stderr)
                    .chars()
                    .take(1000)
                    .collect::<String>()
            )
        })?;
        ensure!(
            out.status.success() && v["ok"] == true,
            "Renderer: {}",
            v.get("error").unwrap_or(&v)
        );
        Ok(v)
    }
    async fn capture(
        &self,
        project_id: &str,
        old: &Page,
        html: Option<&str>,
        edits: Vec<Value>,
        width: u64,
        height: u64,
    ) -> Result<Page> {
        let from_live = html.is_none()
            && edits.is_empty()
            && old.edits.is_empty()
            && old.history.is_empty()
            && old.future.is_empty();
        ensure!(
            (320..=2560).contains(&width) && (480..=1600).contains(&height),
            "Viewport must be 320–2560 by 480–1600"
        );
        let folder = self.data.join("projects").join(project_id).join(format!(
            "{}-{}",
            old.id,
            old.revision + 1
        ));
        let mut req = json!({"mode":"capture","url":old.url,"base_url":if old.url.is_empty(){HTML_BASE}else{&old.url},"width":width,"height":height,"output_dir":folder,"edits":edits});
        if let Some(h) = html {
            req["html"] = json!(h);
        }
        let result = self.worker(req).await?;
        let file = PathBuf::from(
            result["screenshot"]
                .as_str()
                .context("Renderer omitted screenshot")?,
        );
        let canon = file.canonicalize()?;
        let root = folder.canonicalize()?;
        ensure!(
            canon.starts_with(&root),
            "Renderer screenshot escaped output folder"
        );
        let rel = canon
            .strip_prefix(self.data.canonicalize()?)?
            .to_string_lossy()
            .replace('\\', "/");
        let mut p = old.clone();
        p.status = "ready".into();
        p.revision += 1;
        p.title = result["title"]
            .as_str()
            .filter(|s| !s.is_empty())
            .unwrap_or(&old.title)
            .into();
        p.viewport = json!({"width":result["width"].as_u64().unwrap_or(width),"height":result["height"].as_u64().unwrap_or(height),"document_height":result["document_height"],"device_height":height});
        p.screenshot = format!("/files/{rel}");
        p.nodes = result["nodes"].as_array().cloned().unwrap_or_default();
        p.html = result["html"]
            .as_str()
            .context("Renderer omitted HTML")?
            .into();
        p.warnings = result["warnings"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default();
        p.commit = result["commit"].as_str().unwrap_or(&old.commit).into();
        p.edits.extend(edits);
        if from_live {
            p.live_baseline = crate::live_refresh::baseline(&p);
        }
        Ok(p)
    }
    /// Run one named tool with JSON arguments. This is the single entry point for the UI,
    /// MCP and CLI, so validation and revision checks live here and nowhere else.
    ///
    /// # Errors
    /// Returns an error for unknown tools, invalid arguments, revision conflicts
    /// ([`crate::collaboration::RevisionConflict`]) and failed renders or saves.
    pub async fn tool(self: &Arc<Self>, name: &str, a: Value) -> Result<Value> {
        let text = |key: &str| -> Result<String> {
            a[key]
                .as_str()
                .filter(|s| !s.is_empty())
                .map(String::from)
                .with_context(|| format!("Missing {key}"))
        };
        match name {
            "design_status" => Ok(
                json!({"name":"AlcorDesign","version":"0.1.0","renderer":"Chromium","core":"Rust",
                    "github_repository":self.config.github.as_ref().map(crate::config::GithubRepo::slug),
                    "repo":self.config.github.as_ref().map(crate::config::GithubRepo::web_url),
                    "base_branch":self.config.github.as_ref().map(|_|&self.config.base_branch),"sha":self.sha,"project_count":self.projects.lock().unwrap().len(),"url":format!("http://127.0.0.1:{}",self.port)}),
            ),
            "design_list_projects" => Ok(
                json!({"projects":self.projects.lock().unwrap().values().map(Project::summary).collect::<Vec<_>>()}),
            ),
            "design_get_project" => self.project_view(&text("project_id")?),
            "design_list_pages" => {
                let id = text("project_id")?;
                let projects = self.projects.lock().unwrap();
                let p = projects.get(&id).context("Project not found")?;
                Ok(json!({"pages":p.pages.iter().map(|p|p.view(false)).collect::<Vec<_>>() }))
            }
            "design_get_page" | "design_get_screenshot" => {
                let id = text("project_id")?;
                let page_id = text("page_id")?;
                let projects = self.projects.lock().unwrap();
                let p = projects.get(&id).context("Project not found")?;
                let page = p
                    .pages
                    .iter()
                    .find(|p| p.id == page_id)
                    .context("Page not found")?;
                if name == "design_get_page" {
                    Ok(page.view(true))
                } else {
                    ensure!(!page.screenshot.is_empty(), "Page has no capture yet");
                    Ok(
                        json!({"url":page.screenshot,"width":page.viewport["width"],"height":page.viewport["height"],"mimeType":"image/png"}),
                    )
                }
            }
            "design_get_job" => Ok(self
                .jobs
                .lock()
                .unwrap()
                .get(&text("job_id")?)
                .cloned()
                .context("Job not found (server may have restarted)")?),
            "design_repo_files" => self.repo_files(a["query"].as_str().unwrap_or(""), &a),
            "design_read_source" => self.read_source(&text("path")?, &a),
            "design_source_updates" => {
                let project_id = text("project_id")?;
                self.project(&project_id)?;
                let cached = self
                    .source_observations
                    .lock()
                    .unwrap()
                    .get(&project_id)
                    .cloned();
                if let Some((when, mut value)) = cached.clone() {
                    if when.elapsed().as_secs() < 30 {
                        value["cached"] = json!(true);
                        value["retry_after_ms"] =
                            json!(30_000u128.saturating_sub(when.elapsed().as_millis()));
                        return Ok(value);
                    }
                }
                let Ok(source) = self.source_edit_lock.clone().try_lock_owned() else {
                    return Ok(
                        json!({"state":"busy","project_id":project_id,"retry_after_ms":2000,
                        "snapshot":cached.and_then(|(_, v)|v.get("snapshot").cloned()),"stale":true}),
                    );
                };
                let app = self.clone();
                tokio::task::spawn_blocking(move || {
                    // Retain the lock and cache the outcome even if the HTTP
                    // client disconnects. Pollers cannot queue duplicate fetches.
                    let _source = source;
                    let result = app.with_source_workspace(&project_id, |w| w.files(""));
                    let value = match result {
                        Ok(snapshot) => json!({"state":"ready","project_id":project_id,
                            "snapshot":snapshot,"observed_at":now(),"stale":false,"cached":false,"retry_after_ms":30000}),
                        Err(error) => json!({"state":"error","project_id":project_id,
                            "error":error.to_string(),"observed_at":now(),"stale":true,"retry_after_ms":30000,
                            "snapshot":cached.and_then(|(_, v)|v.get("snapshot").cloned())}),
                    };
                    let mut observations = app.source_observations.lock().unwrap();
                    if observations.len() >= 64 && !observations.contains_key(&project_id) {
                        if let Some(oldest) = observations.iter().min_by_key(|(_, (t, _))| *t).map(|(id, _)|id.clone()) {
                            observations.remove(&oldest);
                        }
                    }
                    observations.insert(project_id, (std::time::Instant::now(), value.clone()));
                    Ok(value)
                }).await?
            }
            "design_source_files" => {
                let source = self.source_edit_lock.clone().lock_owned().await;
                let app = self.clone();
                let project_id = text("project_id")?;
                let query = a["query"].as_str().unwrap_or("").to_owned();
                tokio::task::spawn_blocking(move || {
                    let _source = source;
                    app.with_source_workspace(&project_id, |workspace| workspace.files(&query))
                })
                .await?
            }
            "design_source_draft" => {
                let source = self.source_edit_lock.clone().lock_owned().await;
                let app = self.clone();
                let project_id = text("project_id")?;
                let path = text("path")?;
                tokio::task::spawn_blocking(move || {
                    let _source = source;
                    let provenance = app.source_provenance_metadata(&a)?;
                    app.with_source_workspace(&project_id, |workspace| {
                        workspace.open(&path, provenance)
                    })
                })
                .await?
            }
            "design_save_source" => {
                let source = self.source_edit_lock.clone().lock_owned().await;
                let app = self.clone();
                let project_id = text("project_id")?;
                let path = text("path")?;
                let content = a["content"]
                    .as_str()
                    .context("Missing source content")?
                    .to_owned();
                let expected = text("expected_version")?;
                let request_id = text("request_id")?;
                tokio::task::spawn_blocking(move || {
                    let _source = source;
                    app.with_source_workspace(&project_id, |workspace| {
                        workspace.save_source(&path, &content, &expected, &request_id)
                    })
                })
                .await?
            }
            "design_source_sync_status" => {
                let source = self.source_edit_lock.clone().lock_owned().await;
                let app = self.clone();
                let project_id = text("project_id")?;
                tokio::task::spawn_blocking(move || {
                    let _source = source;
                    app.with_source_workspace(&project_id, |workspace| workspace.status())
                })
                .await?
            }
            "design_sync_sources" => {
                let source = self.source_edit_lock.clone().lock_owned().await;
                let app = self.clone();
                let project_id = text("project_id")?;
                let request_id = text("request_id")?;
                let draft_set_version = text("draft_set_version")?;
                let base = a["base_branch"].as_str().map(str::to_owned);
                tokio::task::spawn_blocking(move || {
                    let _source = source;
                    app.with_source_workspace(&project_id, |workspace| {
                        workspace.sync(base.as_deref(), &request_id, &draft_set_version)
                    })
                })
                .await?
            }
            "design_source_operation_status" => {
                let source = self.source_edit_lock.clone().lock_owned().await;
                let app = self.clone();
                let project_id = text("project_id")?;
                let request_id = text("request_id")?;
                tokio::task::spawn_blocking(move || {
                    let _source = source;
                    app.with_source_workspace(&project_id, |workspace| {
                        workspace.operation_status(&request_id)
                    })
                })
                .await?
            }
            "design_refresh_live_page" => {
                let project_id = text("project_id")?;
                let page_id = text("page_id")?;
                let request_id = text("request_id")?;
                let revision = a["expected_revision"]
                    .as_u64()
                    .context("expected_revision is required")?;
                let keep = a["keep_snapshot"].as_bool().unwrap_or(false);
                let expected = a["expected_commit"].as_str().map(str::to_owned);
                self.refresh_live_page(
                    &project_id,
                    &page_id,
                    revision,
                    keep,
                    expected.as_deref(),
                    &request_id,
                )
                .await
            }
            "design_refresh_live_all" => {
                let project_id = text("project_id")?;
                let request_id = text("request_id")?;
                let keep = a["keep_snapshot"].as_bool().unwrap_or(false);
                let expected = a["expected_commit"].as_str().map(str::to_owned);
                self.start_live_refresh_all(&project_id, keep, expected, &request_id)
                    .await
            }
            "design_refresh_operation_status" => {
                let project_id = text("project_id")?;
                let request_id = text("request_id")?;
                if let Ok(_edit) = self.edit_lock.try_lock() {
                    self.live_refresh_status(&project_id, &request_id)
                } else {
                    crate::live_refresh::operation(&self.data, &project_id, &request_id)
                }
            }
            "design_list_page_snapshots" => {
                let project_id = text("project_id")?;
                let page_id = text("page_id")?;
                self.saved_page(&project_id, &page_id)?;
                crate::live_refresh::snapshots(&self.data, &project_id, &page_id)
            }
            "design_restore_page_snapshot" => {
                let project_id = text("project_id")?;
                let page_id = text("page_id")?;
                let snapshot_id = text("snapshot_id")?;
                let request_id = text("request_id")?;
                let revision = a["expected_revision"]
                    .as_u64()
                    .context("expected_revision is required")?;
                self.restore_live_snapshot(
                    &project_id,
                    &page_id,
                    &snapshot_id,
                    revision,
                    &request_id,
                )
                .await
            }
            "design_index" => {
                let all = self.projects.lock().unwrap();
                crate::design_index::index(
                    all.get(&text("project_id")?).context("Project not found")?,
                    &a,
                    &self.sha,
                    self.repository().as_deref(),
                )
            }
            "design_page_tree" => {
                let all = self.projects.lock().unwrap();
                let project = all.get(&text("project_id")?).context("Project not found")?;
                let page = project
                    .pages
                    .iter()
                    .find(|p| p.id == a["page_id"].as_str().unwrap_or(""))
                    .context("Page not found")?;
                crate::design_index::page_tree(
                    project,
                    page,
                    &a,
                    &self.sha,
                    self.repository().as_deref(),
                )
            }
            "design_page_sources" => {
                let (metadata, page) = {
                    let all = self.projects.lock().unwrap();
                    let p = all.get(&text("project_id")?).context("Project not found")?;
                    let page = p
                        .pages
                        .iter()
                        .find(|page| page.id == a["page_id"].as_str().unwrap_or(""))
                        .context("Page not found")?
                        .clone();
                    (
                        Project {
                            id: p.id.clone(),
                            name: p.name.clone(),
                            source: p.source.clone(),
                            pages: vec![],
                            revision: p.revision,
                            created: p.created,
                            job_id: p.job_id.clone(),
                        },
                        page,
                    )
                };
                self.page_sources(&metadata, &page)
            }
            "design_sync_sitemap" => {
                self.sync_sitemap(
                    &text("project_id")?,
                    a["max_pages"].as_u64().unwrap_or(500).clamp(1, 500) as usize,
                )
                .await
            }
            "design_add_pages" => {
                let urls = a["urls"]
                    .as_array()
                    .context("urls must be a list of page URLs")?;
                self.start_add_pages(
                    &text("project_id")?,
                    urls,
                    a["max_pages"].as_u64().unwrap_or(50).clamp(1, 500) as usize,
                )
                .await
            }
            "design_import_site" | "design_import_github" | "design_import_html" => {
                let kind = if name == "design_import_html" {
                    "html"
                } else if name == "design_import_github" {
                    "github"
                } else {
                    "site"
                };
                let base_url = a["base_url"].as_str().filter(|s| !s.is_empty());
                let url = match kind {
                    "site" => text("url")?,
                    "github" => base_url
                        .or(self.config.site.as_deref())
                        .context("Name the deployed site in base_url, or set ALCORDESIGN_SITE")?
                        .to_string(),
                    _ => base_url.unwrap_or(HTML_BASE).to_string(),
                };
                validate_url(&url)?;
                let mut repository = None;
                if kind == "github" {
                    let github = self.config.require_github()?;
                    let checkout = self.checkout()?;
                    ensure!(
                        github.matches_name(&text("repository")?),
                        "This workspace is connected to {}",
                        github.slug()
                    );
                    repository = Some(github.web_url());
                    if let Some(r) = a["ref"].as_str().filter(|s| !s.is_empty()) {
                        ensure!(!r.starts_with('-') && r.len() < 200, "Invalid Git ref");
                        let requested = git(
                            checkout,
                            &["rev-parse", "--verify", &format!("{r}^{{commit}}")],
                        )?;
                        ensure!(
                            requested == self.sha,
                            "Requested ref differs from the configured checkout. Launch with --repo pointing to that checkout; source is never checked out over working files."
                        );
                    }
                }
                let html = if kind == "html" {
                    let h = text("html")?;
                    ensure!(h.len() <= 4_000_000, "HTML limit is 4 MB");
                    Some(h)
                } else {
                    None
                };
                let max = a["max_pages"].as_u64().unwrap_or(300).clamp(1, 500) as usize;
                let id = uid();
                let job_id = uid();
                let name = a["name"]
                    .as_str()
                    .unwrap_or(if kind == "html" {
                        "HTML design"
                    } else {
                        "Imported site"
                    })
                    .chars()
                    .take(120)
                    .collect::<String>();
                let source = json!({"kind":kind,"url":url,"repository":repository,"sha":if kind=="github"{Some(&self.sha)}else{None}});
                self.save(Project {
                    id: id.clone(),
                    name,
                    source,
                    pages: vec![],
                    revision: 0,
                    created: now(),
                    job_id: Some(job_id.clone()),
                })?;
                self.job(&job_id,json!({"status":"running","project_id":id,"completed":0,"total":0,"message":"Discovering pages"}));
                let app = self.clone();
                let pid = id.clone();
                let jid = job_id.clone();
                tokio::spawn(async move {
                    if let Err(e) = app.import(&pid, &jid, &url, html, max).await {
                        app.job(&jid,json!({"status":"failed","message":e.to_string(),"error":format!("{e:#}")}));
                    }
                });
                Ok(json!({"project_id":id,"job_id":job_id}))
            }
            "design_list_comments"
            | "design_add_comment"
            | "design_reply_comment"
            | "design_resolve_comment"
            | "design_delete_comment" => self.comments(name, &a),
            "design_render_all" => {
                let _edit = self.edit_lock.lock().await;
                let id = text("project_id")?;
                let existing_job = {
                    let projects = self.projects.lock().unwrap();
                    projects
                        .get(&id)
                        .context("Project not found")?
                        .job_id
                        .clone()
                };
                if let Some(job) = existing_job {
                    ensure!(
                        self.jobs
                            .lock()
                            .unwrap()
                            .get(&job)
                            .is_none_or(|v| v["status"] != "running"),
                        "This project already has a running import or render job"
                    );
                }
                let job_id = uid();
                let pages = {
                    let mut projects = self.projects.lock().unwrap();
                    let project = projects.get_mut(&id).context("Project not found")?;
                    let pages = project
                        .pages
                        .iter()
                        .map(|p| (p.id.clone(), p.revision))
                        .collect::<Vec<_>>();
                    let previous_job = project.job_id.replace(job_id.clone());
                    if let Err(error) = save_json(
                        &self.data.join("projects").join(&id).join("project.json"),
                        project,
                    ) {
                        project.job_id = previous_job;
                        return Err(error);
                    }
                    pages
                };
                self.job(&job_id,json!({"status":"running","project_id":id,"completed":0,"total":pages.len(),"message":"Rendering saved design pages"}));
                let app = self.clone();
                let pid = id.clone();
                let jid = job_id.clone();
                tokio::spawn(async move {
                    if let Err(e) = app.render_all(&pid, &jid, pages).await {
                        app.job(&jid,json!({"status":"failed","error":e.to_string(),"message":e.to_string()}));
                    }
                });
                Ok(json!({"project_id":id,"job_id":job_id}))
            }
            "design_update_node" | "design_insert_node" | "design_remove_node"
            | "design_render_page" | "design_undo" | "design_redo" => {
                let _edit = self.edit_lock.lock().await;
                let id = text("project_id")?;
                let page_id = text("page_id")?;
                let (_, old) = self.saved_page(&id, &page_id)?;
                let expected = a["expected_revision"]
                    .as_u64()
                    .context("expected_revision is required; read the page before editing")?;
                if expected != old.revision {
                    return Err(crate::collaboration::RevisionConflict {
                        expected,
                        current: old.revision,
                    }
                    .into());
                }
                let mut previous = old.clone();
                let mut html = old.html.clone();
                let mut edits = vec![];
                match name {
                    "design_update_node" => {
                        ensure!(!html.is_empty(), "Render page first");
                        let selector = text("selector")?;
                        ensure!(
                            old.nodes.iter().any(|n| n["selector"] == selector),
                            "Select an imported layer before editing"
                        );
                        let mut edit = json!({"selector":selector});
                        if let Some(t) = a["text"].as_str() {
                            ensure!(t.len() < 100_000, "Text too long");
                            edit["text"] = json!(t);
                        }
                        if let Some(styles) = a["styles"].as_object() {
                            validate_styles(styles)?;
                            edit["styles"] = json!(styles);
                        }
                        ensure!(
                            edit.get("text").is_some() || edit.get("styles").is_some(),
                            "No edits supplied"
                        );
                        previous.history.push(html.clone());
                        if previous.history.len() > 30 {
                            previous.history.remove(0);
                        }
                        previous.future.clear();
                        edits.push(edit);
                    }
                    "design_insert_node" | "design_remove_node" => {
                        ensure!(!html.is_empty(), "Render page first");
                        let selector = a["selector"].as_str().unwrap_or("body");
                        ensure!(
                            selector == "body" && name == "design_insert_node"
                                || old.nodes.iter().any(|n| n["selector"] == selector),
                            "Select an imported layer first"
                        );
                        let edit = if name == "design_remove_node" {
                            json!({"action":"remove","selector":selector})
                        } else {
                            let kind = text("kind")?;
                            ensure!(
                                kind == "text" || kind == "rectangle",
                                "Kind must be text or rectangle"
                            );
                            json!({"action":"insert","selector":selector,"tag":if kind=="text"{"p"}else{"div"},"text":a["text"].as_str().unwrap_or(if kind=="text"{"New text"}else{""}),"styles":if kind=="text"{json!({"font-size":"32px","color":"#eeeeee","padding":"24px","position":"relative"})}else{json!({"width":"240px","height":"160px","background-color":"#59d8cd","border-radius":"12px","position":"relative"})}})
                        };
                        previous.history.push(html.clone());
                        if previous.history.len() > 30 {
                            previous.history.remove(0);
                        }
                        previous.future.clear();
                        edits.push(edit);
                    }
                    "design_undo" => {
                        html = previous.history.pop().context("Nothing to undo")?;
                        previous.future.push(old.html.clone());
                    }
                    "design_redo" => {
                        html = previous.future.pop().context("Nothing to redo")?;
                        previous.history.push(old.html.clone());
                    }
                    _ => {}
                }
                let width = a["width"]
                    .as_u64()
                    .unwrap_or(old.viewport["width"].as_u64().unwrap_or(1440));
                let height = a["height"]
                    .as_u64()
                    .unwrap_or(old.viewport["device_height"].as_u64().unwrap_or(1000));
                let mut page = self
                    .capture(
                        &id,
                        &previous,
                        if html.is_empty() { None } else { Some(&html) },
                        edits,
                        width,
                        height,
                    )
                    .await?;
                if name == "design_undo" || name == "design_redo" {
                    page.edits = vec![];
                }
                let view = page.view(true);
                self.update_page(&id, page)?;
                Ok(view)
            }
            "design_export" => self.export(&text("project_id")?, &text("format")?),
            _ => bail!("Unknown tool {name}"),
        }
    }
    fn saved_page(&self, project_id: &str, page_id: &str) -> Result<(Value, Page)> {
        let all = self.projects.lock().unwrap();
        let project = all.get(project_id).context("Project not found")?;
        let page = project
            .pages
            .iter()
            .find(|p| p.id == page_id)
            .context("Page not found")?;
        Ok((project.source.clone(), page.clone()))
    }

    fn live_refresh_status(&self, project_id: &str, request_id: &str) -> Result<Value> {
        let record = crate::live_refresh::operation(&self.data, project_id, request_id)?;
        if record["state"] == "pending"
            && matches!(record["action"].as_str(), Some("page" | "restore"))
        {
            if let Some(page_id) = record["input"]["page_id"].as_str() {
                let (_, page) = self.saved_page(project_id, page_id)?;
                if let Some(result) = page.live_refresh_history.get(request_id) {
                    return crate::live_refresh::complete(
                        &self.data,
                        project_id,
                        request_id,
                        "completed",
                        result.clone(),
                    );
                }
                if page.last_live_refresh["request_id"] == request_id {
                    return crate::live_refresh::complete(
                        &self.data,
                        project_id,
                        request_id,
                        "completed",
                        page.last_live_refresh["result"].clone(),
                    );
                }
            }
            // A project save may have taken effect even if the filesystem
            // reported an error. Without durable proof, retain uncertainty.
            if record["result"]["phase"] == "committing" {
                return Ok(record);
            }
            return crate::live_refresh::complete(
                &self.data,
                project_id,
                request_id,
                "failed",
                json!({"code":"interrupted","page_id":record["input"]["page_id"],"message":"The operation stopped before committing a page. Its saved page and any archive remain available; it was not replayed."}),
            );
        }
        if record["state"] == "pending" && record["action"] == "all" {
            let active = record["job_id"]
                .as_str()
                .is_some_and(|id| self.active_refresh_workers.lock().unwrap().contains(id));
            if !active {
                let mut progress = record["result"].clone();
                if !progress.is_object() {
                    progress = json!({});
                }
                progress["job_id"] = record["job_id"].clone();
                progress["code"] = json!("interrupted");
                progress["message"] = json!(
                    "The batch stopped. Recorded progress is preserved; one additional page may have completed before progress was saved. Inspect current pages and snapshots. No work was replayed."
                );
                let finished = crate::live_refresh::complete(
                    &self.data, project_id, request_id, "partial", progress,
                )?;
                if let Some(id) = record["job_id"].as_str() {
                    self.job(id,json!({"status":"partial","message":"Live refresh was interrupted; inspect saved progress."}));
                }
                return Ok(finished);
            }
        }
        Ok(record)
    }

    async fn refresh_live_page(
        self: &Arc<Self>,
        project_id: &str,
        page_id: &str,
        revision: u64,
        keep_snapshot: bool,
        expected_commit: Option<&str>,
        request_id: &str,
    ) -> Result<Value> {
        let _edit = self.edit_lock.lock().await;
        let (source, old) = self.saved_page(project_id, page_id)?;
        let input = json!({"page_id":page_id,"expected_revision":revision,"keep_snapshot":keep_snapshot,"expected_commit":expected_commit});
        let (created, _record) =
            crate::live_refresh::reserve(&self.data, project_id, request_id, "page", &input, None)?;
        if !created {
            return self.live_refresh_status(project_id, request_id);
        }
        let reject = |code: &str, message: String, backup_allowed: bool| {
            crate::live_refresh::complete(
                &self.data,
                project_id,
                request_id,
                "conflict",
                json!({"page_id":page_id,"code":code,"message":message,"backup_allowed":backup_allowed}),
            )
        };
        if let Err(error) = crate::live_refresh::preflight(&source, &old, revision, true) {
            let code = if old.revision != revision {
                "revision_conflict"
            } else {
                "preview_scope_conflict"
            };
            return reject(code, format!("{error:#}"), false);
        }
        if !keep_snapshot && !crate::live_refresh::known_clean(&old) {
            return reject("local_or_legacy_conflict","This page has local edits or an unverified legacy baseline. Back up the existing design before refreshing.".into(),true);
        }
        if let Some(commit) = expected_commit {
            if commit.len() != 40 || !commit.bytes().all(|c| c.is_ascii_hexdigit()) {
                return reject(
                    "invalid_expected_commit",
                    "Expected commit must be a full Git SHA.".into(),
                    false,
                );
            }
        }
        let available = crate::live_refresh::available_physical_memory();
        if let Err(error) = crate::live_refresh::check_render_memory(available) {
            let code = if available.is_some() {
                "insufficient_memory"
            } else {
                "memory_unavailable"
            };
            return crate::live_refresh::complete(
                &self.data,
                project_id,
                request_id,
                "failed",
                json!({"page_id":page_id,"code":code,"message":format!("{error:#}"),"backup_allowed":false}),
            );
        }
        let archived = if keep_snapshot {
            match crate::live_refresh::archive(&self.data, project_id, &old, "before_live_refresh")
            {
                Ok(id) => Some(id),
                Err(error) => {
                    return crate::live_refresh::complete(
                        &self.data,
                        project_id,
                        request_id,
                        "failed",
                        json!({"page_id":page_id,"code":"archive_failed","message":format!("{error:#}"),"backup_allowed":false}),
                    );
                }
            }
        } else {
            None
        };
        // Do not replay old HTML or node IDs into the live page. The complete
        // previous state remains in its snapshot when keep_snapshot is true.
        let mut input_page = old.clone();
        input_page.edits.clear();
        input_page.history.clear();
        input_page.future.clear();
        input_page.commit.clear();
        input_page.live_baseline.clear();
        input_page.last_live_refresh = Value::Null;
        let captured = match self
            .capture(
                project_id,
                &input_page,
                None,
                vec![],
                old.viewport["width"].as_u64().unwrap_or(1440),
                old.viewport["device_height"].as_u64().unwrap_or(1000),
            )
            .await
        {
            Ok(page) => page,
            Err(error) => {
                return crate::live_refresh::complete(
                    &self.data,
                    project_id,
                    request_id,
                    "failed",
                    json!({"page_id":page_id,"code":"capture_failed","message":format!("{error:#}"),"backup_allowed":false,"snapshot_id":archived}),
                );
            }
        };
        let (_, current) = self.saved_page(project_id, page_id)?;
        let mut page = match crate::live_refresh::finish(
            &source,
            &old,
            &current,
            captured,
            revision,
            expected_commit,
            keep_snapshot,
        ) {
            Ok(page) => page,
            Err(error) => {
                let message = format!("{error:#}");
                let code = if current.revision != revision {
                    "revision_conflict"
                } else if message.contains("commit changed") {
                    "preview_commit_changed"
                } else if message.contains("valid deployed commit") {
                    "preview_commit_unavailable"
                } else {
                    "capture_failed"
                };
                return crate::live_refresh::complete(
                    &self.data,
                    project_id,
                    request_id,
                    "conflict",
                    json!({"page_id":page_id,"code":code,"message":message,"backup_allowed":false,"snapshot_id":archived}),
                );
            }
        };
        let result = json!({"page_id":page_id,"revision":page.revision,"commit":page.commit,
            "snapshot_id":archived,"warnings":page.warnings,"comments_preserved":true});
        page.last_live_refresh = json!({"request_id":request_id,"result":result});
        page.live_refresh_history
            .insert(request_id.to_owned(), result.clone());
        crate::live_refresh::progress(
            &self.data,
            project_id,
            request_id,
            json!({"phase":"committing","page_id":page_id}),
        )?;
        self.update_page(project_id, page)?;
        crate::live_refresh::complete(&self.data, project_id, request_id, "completed", result)
    }

    async fn restore_live_snapshot(
        self: &Arc<Self>,
        project_id: &str,
        page_id: &str,
        snapshot_id: &str,
        revision: u64,
        request_id: &str,
    ) -> Result<Value> {
        let _edit = self.edit_lock.lock().await;
        let (_, current) = self.saved_page(project_id, page_id)?;
        let input =
            json!({"page_id":page_id,"snapshot_id":snapshot_id,"expected_revision":revision});
        let (created, _record) = crate::live_refresh::reserve(
            &self.data, project_id, request_id, "restore", &input, None,
        )?;
        if !created {
            return self.live_refresh_status(project_id, request_id);
        }
        if current.revision != revision {
            return crate::live_refresh::complete(
                &self.data,
                project_id,
                request_id,
                "conflict",
                json!({"page_id":page_id,"code":"revision_conflict","message":"The page changed before the snapshot could be restored.","backup_allowed":false}),
            );
        }
        let saved = match crate::live_refresh::snapshot(
            &self.data,
            project_id,
            page_id,
            snapshot_id,
        ) {
            Ok(page) => page,
            Err(error) => {
                return crate::live_refresh::complete(
                    &self.data,
                    project_id,
                    request_id,
                    "failed",
                    json!({"page_id":page_id,"code":"snapshot_not_found","message":format!("{error:#}"),"backup_allowed":false}),
                );
            }
        };
        let mut page = match crate::live_refresh::restored(&saved, &current, revision) {
            Ok(page) => page,
            Err(error) => {
                return crate::live_refresh::complete(
                    &self.data,
                    project_id,
                    request_id,
                    "conflict",
                    json!({"page_id":page_id,"code":"snapshot_conflict","message":format!("{error:#}"),"backup_allowed":false}),
                );
            }
        };
        let archive = match crate::live_refresh::archive(
            &self.data,
            project_id,
            &current,
            "before_snapshot_restore",
        ) {
            Ok(id) => id,
            Err(error) => {
                return crate::live_refresh::complete(
                    &self.data,
                    project_id,
                    request_id,
                    "failed",
                    json!({"page_id":page_id,"code":"archive_failed","message":format!("{error:#}"),"backup_allowed":false}),
                );
            }
        };
        let result = json!({"page_id":page_id,"revision":page.revision,"commit":page.commit,"restored_snapshot_id":snapshot_id,
            "snapshot_id":archive,"warnings":page.warnings,"comments_preserved":true});
        page.last_live_refresh = json!({"request_id":request_id,"result":result});
        page.live_refresh_history
            .insert(request_id.to_owned(), result.clone());
        crate::live_refresh::progress(
            &self.data,
            project_id,
            request_id,
            json!({"phase":"committing","page_id":page_id}),
        )?;
        self.update_page(project_id, page)?;
        crate::live_refresh::complete(&self.data, project_id, request_id, "completed", result)
    }

    async fn start_live_refresh_all(
        self: &Arc<Self>,
        project_id: &str,
        keep_snapshot: bool,
        expected_commit: Option<String>,
        request_id: &str,
    ) -> Result<Value> {
        let _edit = self.edit_lock.lock().await;
        let pages = {
            let all = self.projects.lock().unwrap();
            let project = all.get(project_id).context("Project not found")?;
            project
                .pages
                .iter()
                .map(|p| (p.id.clone(), p.url.clone(), p.revision))
                .collect::<Vec<_>>()
        };
        ensure!(!pages.is_empty(), "This project has no captured pages");
        if let Some(commit) = expected_commit.as_deref() {
            ensure!(
                commit.len() == 40 && commit.bytes().all(|b| b.is_ascii_hexdigit()),
                "Expected commit must be a full Git SHA"
            );
        }
        let job_id = uid();
        let input = json!({"keep_snapshot":keep_snapshot,"expected_commit":expected_commit});
        let (created, record) = crate::live_refresh::reserve(
            &self.data,
            project_id,
            request_id,
            "all",
            &input,
            Some(&job_id),
        )?;
        if !created {
            return self.live_refresh_status(project_id, request_id);
        }
        let busy = self
            .jobs
            .lock()
            .unwrap()
            .values()
            .any(|job| job["project_id"] == project_id && job["status"] == "running");
        if busy {
            return crate::live_refresh::complete(
                &self.data,
                project_id,
                request_id,
                "failed",
                json!({"code":"job_running","message":"A project import or render is already running."}),
            );
        }
        self.job(&job_id,json!({"status":"running","project_id":project_id,"total":pages.len(),"completed":0,"failed_pages":0,"conflicts":0,"results":[],"message":"Refreshing live pages one at a time"}));
        // Mark the existing project job slot so other imports/renders do not
        // start concurrently. Comments are preserved under the project lock.
        {
            let mut all = self.projects.lock().unwrap();
            let p = all.get_mut(project_id).context("Project not found")?;
            let previous = p.job_id.clone();
            p.job_id = Some(job_id.clone());
            if let Err(error) = save_json(
                &self
                    .data
                    .join("projects")
                    .join(project_id)
                    .join("project.json"),
                p,
            ) {
                p.job_id = previous;
                self.job(
                    &job_id,
                    json!({"status":"failed","error":"Could not save job state"}),
                );
                return crate::live_refresh::complete(
                    &self.data,
                    project_id,
                    request_id,
                    "failed",
                    json!({"code":"job_state_failed","message":format!("{error:#}")}),
                );
            }
        }
        self.active_refresh_workers
            .lock()
            .unwrap()
            .insert(job_id.clone());
        let worker = ActiveRefreshWorker {
            active: self.active_refresh_workers.clone(),
            job_id: job_id.clone(),
        };
        let app = self.clone();
        let project_id = project_id.to_string();
        let request_id = request_id.to_string();
        let job = job_id.clone();
        tokio::spawn(async move {
            let _worker = worker;
            if let Err(error) = app
                .run_live_refresh_all(
                    &project_id,
                    &request_id,
                    &job,
                    pages,
                    keep_snapshot,
                    expected_commit,
                )
                .await
            {
                app.job(&job,json!({"status":"failed","error":format!("{error:#}"),"message":"Live refresh stopped; saved pages and archives remain available"}));
                let mut progress =
                    crate::live_refresh::operation(&app.data, &project_id, &request_id)
                        .ok()
                        .map(|record| record["result"].clone())
                        .filter(Value::is_object)
                        .unwrap_or(json!({}));
                progress["job_id"] = json!(job);
                progress["message"] = json!(format!("{error:#}"));
                let _ = crate::live_refresh::complete(
                    &app.data,
                    &project_id,
                    &request_id,
                    "failed",
                    progress,
                );
            }
        });
        Ok(record)
    }

    async fn run_live_refresh_all(
        self: &Arc<Self>,
        project_id: &str,
        request_id: &str,
        job_id: &str,
        pages: Vec<(String, String, u64)>,
        keep_snapshot: bool,
        mut pinned: Option<String>,
    ) -> Result<()> {
        let total = pages.len();
        let mut results = Vec::new();
        let mut failures = 0usize;
        let mut conflicts = 0usize;
        for (page_id, url, revision) in pages {
            let page_request = crate::live_refresh::batch_request_id(job_id, &page_id);
            let outcome = self
                .refresh_live_page(
                    project_id,
                    &page_id,
                    revision,
                    keep_snapshot,
                    pinned.as_deref(),
                    &page_request,
                )
                .await;
            let mut row = match outcome {
                Ok(record) => {
                    let state = record["state"].as_str().unwrap_or("failed");
                    if state == "completed" && pinned.is_none() {
                        pinned = record["result"]["commit"].as_str().map(str::to_owned);
                    }
                    if state == "conflict" {
                        conflicts += 1;
                    } else if state != "completed" {
                        failures += 1;
                    }
                    json!({"page_id":page_id,"url":url,"state":state,"result":record["result"],"request_id":page_request})
                }
                Err(error) => {
                    failures += 1;
                    json!({"page_id":page_id,"url":url,"state":"failed","result":{"code":"operation_failed","message":format!("{error:#}")},"request_id":page_request})
                }
            };
            let stop = crate::live_refresh::batch_should_stop(&row);
            if stop
                && matches!(
                    row["result"]["code"].as_str(),
                    Some("preview_commit_changed" | "preview_commit_unavailable")
                )
            {
                row["result"]["message"] = json!(
                    "The deployed commit changed or could not be verified; remaining pages were not touched."
                );
            }
            results.push(row);
            let progress = json!({"job_id":job_id,"total":total,"completed":results.len(),"failed_pages":failures,"conflicts":conflicts,
                "expected_commit":pinned,"results":results,"message":"Refreshing live pages one at a time"});
            self.job(job_id, progress.clone());
            crate::live_refresh::progress(&self.data, project_id, request_id, progress)?;
            if stop {
                break;
            }
        }
        let status = if failures == 0 && conflicts == 0 && results.len() == total {
            "completed"
        } else {
            "partial"
        };
        let result = json!({"job_id":job_id,"total":total,"completed":results.len(),"failed_pages":failures,"conflicts":conflicts,
            "expected_commit":pinned,"results":results,"message":if status=="completed"{"Live pages refreshed"}else{"Live refresh completed with conflicts or failures"}});
        self.job(job_id,json!({"status":status,"total":total,"completed":results.len(),"failed_pages":failures,"conflicts":conflicts,
            "expected_commit":pinned,"results":results,"message":result["message"]}));
        crate::live_refresh::complete(&self.data, project_id, request_id, status, result)?;
        Ok(())
    }

    fn comments(&self, name: &str, args: &Value) -> Result<Value> {
        let id = args["project_id"].as_str().context("Missing project_id")?;
        let page_id = args["page_id"].as_str().context("Missing page_id")?;
        let mut all = self.projects.lock().unwrap();
        let project = all.get_mut(id).context("Project not found")?;
        let page = project
            .pages
            .iter_mut()
            .find(|p| p.id == page_id)
            .context("Page not found")?;
        if name == "design_list_comments" {
            return Ok(json!({"comments":page.comments}));
        }
        let body = || -> Result<String> {
            let b = args["body"]
                .as_str()
                .context("Comment body is required")?
                .trim();
            ensure!(
                !b.is_empty() && b.len() <= 20_000,
                "Comment must contain 1–20000 bytes"
            );
            Ok(b.into())
        };
        let author = || -> Result<String> {
            let a = args["author"].as_str().unwrap_or("Local agent").trim();
            ensure!(
                !a.is_empty() && a.len() <= 80,
                "Author must contain 1–80 bytes"
            );
            Ok(a.into())
        };
        let mut changed = Value::Null;
        if name == "design_add_comment" {
            let x = args["x"].as_f64().context("Comment x must be a number")?;
            let y = args["y"].as_f64().context("Comment y must be a number")?;
            ensure!(
                x >= 0.0
                    && y >= 0.0
                    && x <= page.viewport["width"].as_f64().unwrap_or(1440.0)
                    && y <= page.viewport["height"].as_f64().unwrap_or(1000.0),
                "Comment pin lies outside this page"
            );
            ensure!(page.comments.len() < 2000, "Page comment limit reached");
            changed = json!({"id":uid(),"x":x,"y":y,"body":body()?,"author":author()?,"created":now(),"resolved":false,"replies":[]});
            page.comments.push(changed.clone());
        } else {
            let comment_id = args["comment_id"].as_str().context("Missing comment_id")?;
            let index = page
                .comments
                .iter()
                .position(|c| c["id"] == comment_id)
                .context("Comment not found")?;
            match name {
                "design_reply_comment" => {
                    let replies = page.comments[index]["replies"]
                        .as_array_mut()
                        .context("Invalid thread")?;
                    ensure!(replies.len() < 500, "Thread reply limit reached");
                    replies.push(
                        json!({"id":uid(),"body":body()?,"author":author()?,"created":now()}),
                    );
                    changed = page.comments[index].clone();
                }
                "design_resolve_comment" => {
                    page.comments[index]["resolved"] = json!(
                        args["resolved"]
                            .as_bool()
                            .context("resolved must be true or false")?
                    );
                    changed = page.comments[index].clone();
                }
                "design_delete_comment" => {
                    page.comments.remove(index);
                }
                _ => bail!("Unknown comment action"),
            }
        }
        let result = json!({"comments":page.comments,"comment":changed});
        project.revision += 1;
        save_json(
            &self.data.join("projects").join(id).join("project.json"),
            project,
        )?;
        Ok(result)
    }
    async fn render_all(
        self: &Arc<Self>,
        id: &str,
        job: &str,
        pages: Vec<(String, u64)>,
    ) -> Result<()> {
        let mut completed = 0;
        let mut failures = 0;
        for (page_id, expected_revision) in pages {
            let (_, old) = self.saved_page(id, &page_id)?;
            if old.revision != expected_revision {
                failures += 1;
            } else {
                let result = self
                    .capture(
                        id,
                        &old,
                        if old.html.is_empty() {
                            None
                        } else {
                            Some(&old.html)
                        },
                        vec![],
                        old.viewport["width"].as_u64().unwrap_or(1440),
                        old.viewport["device_height"].as_u64().unwrap_or(1000),
                    )
                    .await;
                let _edit = self.edit_lock.lock().await;
                let current_revision = {
                    let projects = self.projects.lock().unwrap();
                    let project = projects.get(id).context("Project not found")?;
                    project
                        .pages
                        .iter()
                        .find(|p| p.id == page_id)
                        .context("Page not found")?
                        .revision
                };
                if current_revision != expected_revision {
                    failures += 1;
                } else {
                    match result {
                        Ok(page) => self.update_page(id, page)?,
                        Err(e) => {
                            failures += 1;
                            let mut page = old;
                            page.warnings.push(format!("Rerender failed: {e:#}"));
                            self.update_page(id, page)?;
                        }
                    }
                }
            }
            completed += 1;
            self.job(job,json!({"completed":completed,"failed_pages":failures,"message":format!("Rendered {completed} pages; {failures} need attention")}));
        }
        self.job(job,json!({"status":if failures==0{"completed"}else{"partial"},"message":format!("Rendered {completed} saved pages; {failures} need attention")}));
        Ok(())
    }
    async fn import(
        self: &Arc<Self>,
        id: &str,
        job: &str,
        url: &str,
        html: Option<String>,
        max: usize,
    ) -> Result<()> {
        let discovered = if html.is_none() {
            self.worker(json!({"mode":"discover","url":url,"max_pages":max,"output_dir":self.data.join("projects").join(id).join("discovery")})).await?
        } else {
            json!({"pages":[{"url":url,"title":html_title(html.as_ref().unwrap())}],"complete":true,"warnings":[]})
        };
        let entries = discovered["pages"]
            .as_array()
            .context("Discovery returned no pages")?;
        ensure!(!entries.is_empty(), "No HTML pages discovered");
        let mut project = self.project(id)?;
        project.source["discovery"] = json!({"complete":discovered["complete"],"warnings":discovered["warnings"],"count":entries.len(),"checked_at":now()});
        project.source["sitemaps"] = discovered.get("sitemaps").cloned().unwrap_or(json!([]));
        project.pages = entries
            .iter()
            .take(max)
            .filter_map(|e| {
                let u = e["url"].as_str()?;
                let mut page = Page::pending(u.into(), e["title"].as_str().unwrap_or(u).into());
                page.discovery = discovery_record(e);
                Some(page)
            })
            .collect();
        let pages = project.pages.clone();
        self.save(project)?;
        self.job(
            job,
            json!({"total":pages.len(),"message":"Rendering pages in Chromium"}),
        );
        let mut tasks = tokio::task::JoinSet::new();
        let mut pending = pages.into_iter();
        let mut completed = 0usize;
        let mut failures = 0usize;
        loop {
            while tasks.len() < 2 {
                let Some(page) = pending.next() else { break };
                let app = self.clone();
                let pid = id.to_string();
                let source = html.clone();
                tasks.spawn(async move {
                    let r = app
                        .capture(&pid, &page, source.as_deref(), vec![], 1440, 1000)
                        .await;
                    (page, r)
                });
            }
            let Some(result) = tasks.join_next().await else {
                break;
            };
            let (old, result) = result?;
            let page = match result {
                Ok(p) => p,
                Err(e) => {
                    failures += 1;
                    let mut p = old;
                    p.status = "error".into();
                    p.warnings = vec![format!("{e:#}")];
                    p
                }
            };
            self.update_page(id, page)?;
            completed += 1;
            self.job(job,json!({"completed":completed,"failed_pages":failures,"message":format!("Rendered {completed} pages; {failures} need attention")}));
        }
        self.job(job,json!({"status":if failures==0{"completed"}else{"partial"},"message":format!("Imported {completed} pages; {} rendered, {failures} need attention",completed-failures)}));
        Ok(())
    }
    /// Queue same-origin pages for an existing website project. Saved pages,
    /// edits and comments are never re-rendered or replaced: each new page is
    /// appended only after its own capture succeeds, so a retry adds nothing twice.
    async fn start_add_pages(
        self: &Arc<Self>,
        id: &str,
        urls: &[Value],
        max: usize,
    ) -> Result<Value> {
        let _edit = self.edit_lock.lock().await;
        let (queued, results, existing_job) = {
            let projects = self.projects.lock().unwrap();
            let project = projects.get(id).context("Project not found")?;
            let (queued, results) = plan_added_pages(project, urls, max)?;
            (queued, results, project.job_id.clone())
        };
        let job_id = uid();
        if queued.is_empty() {
            self.job(&job_id,json!({"status":"completed","project_id":id,"total":0,"completed":0,"added":0,"failed_pages":0,
                "results":results,"message":"No new pages; every requested URL is already in the project"}));
            return Ok(json!({"project_id":id,"job_id":job_id,"queued":0,"results":results}));
        }
        {
            let jobs = self.jobs.lock().unwrap();
            ensure!(
                existing_job
                    .and_then(|job| jobs.get(&job))
                    .is_none_or(|v| v["status"] != "running")
                    && !jobs
                        .values()
                        .any(|job| job["project_id"] == id && job["status"] == "running"),
                "This project already has a running import or render job"
            );
        }
        {
            let mut projects = self.projects.lock().unwrap();
            let project = projects.get_mut(id).context("Project not found")?;
            let previous_job = project.job_id.replace(job_id.clone());
            if let Err(error) = save_json(
                &self.data.join("projects").join(id).join("project.json"),
                project,
            ) {
                project.job_id = previous_job;
                return Err(error);
            }
        }
        let response =
            json!({"project_id":id,"job_id":job_id,"queued":queued.len(),"results":results});
        self.job(&job_id,json!({"status":"running","project_id":id,"total":queued.len(),"completed":0,"added":0,"failed_pages":0,
            "results":results,"message":"Rendering new pages in Chromium"}));
        let app = self.clone();
        let pid = id.to_string();
        let jid = job_id.clone();
        tokio::spawn(async move {
            if let Err(e) = app.add_pages(&pid, &jid, queued, results).await {
                app.job(
                    &jid,
                    json!({"status":"failed","message":e.to_string(),"error":format!("{e:#}")}),
                );
            }
        });
        Ok(response)
    }
    async fn add_pages(
        self: &Arc<Self>,
        id: &str,
        job: &str,
        urls: Vec<String>,
        mut results: Vec<Value>,
    ) -> Result<()> {
        let mut tasks = tokio::task::JoinSet::new();
        let mut pending = urls.into_iter();
        let mut completed = 0usize;
        let mut added = 0usize;
        let mut failures = 0usize;
        loop {
            while tasks.len() < 2 {
                let Some(url) = pending.next() else { break };
                let app = self.clone();
                let pid = id.to_string();
                let jid = job.to_string();
                tasks.spawn(async move {
                    // The same pending page, viewport and live capture an import uses for one page.
                    let mut page = Page::pending(url.clone(), url.clone());
                    page.discovery = discovery_record(
                        &json!({"source":"requested","sources":["requested"],"status":null}),
                    );
                    page.discovery["added_by"] = json!({"tool":"design_add_pages","job_id":jid});
                    let r = match crate::live_refresh::check_render_memory(
                        crate::live_refresh::available_physical_memory(),
                    ) {
                        Ok(()) => app.capture(&pid, &page, None, vec![], 1440, 1000).await,
                        Err(e) => Err(e),
                    };
                    (url, r)
                });
            }
            let Some(result) = tasks.join_next().await else {
                break;
            };
            let (url, result) = result?;
            let outcome = match result {
                Ok(page) => {
                    let row = json!({"page_id":page.id,"title":page.title,"revision":page.revision,"commit":page.commit,
                        "node_count":page.nodes.len(),"screenshot":page.screenshot,"warnings":page.warnings,
                        "known_clean":crate::live_refresh::known_clean(&page)});
                    match self.append_page(id, page) {
                        Ok(true) => {
                            added += 1;
                            json!({"state":"added","page":row})
                        }
                        Ok(false) => {
                            json!({"state":"skipped_existing","message":"The URL was added to the project during this job; the existing page was kept"})
                        }
                        Err(e) => {
                            failures += 1;
                            json!({"state":"failed","message":format!("{e:#}")})
                        }
                    }
                }
                Err(e) => {
                    failures += 1;
                    json!({"state":"failed","message":format!("{e:#}")})
                }
            };
            if let Some(row) = results
                .iter_mut()
                .find(|row| row["url"] == url.as_str() && row["state"] == "queued")
            {
                for (k, v) in outcome.as_object().unwrap() {
                    row[k] = v.clone();
                }
            }
            completed += 1;
            self.job(job,json!({"completed":completed,"added":added,"failed_pages":failures,"results":results,
                "message":format!("Added {added} pages; {failures} need attention")}));
        }
        let status = if failures == 0 {
            "completed"
        } else if added > 0 {
            "partial"
        } else {
            "failed"
        };
        self.job(job,json!({"status":status,"message":format!("Added {added} of {completed} new pages; {failures} need attention")}));
        Ok(())
    }
    /// Append one freshly captured page. Saved pages are neither cloned nor
    /// rewritten; a URL that reached the project meanwhile is left untouched.
    fn append_page(&self, id: &str, page: Page) -> Result<bool> {
        let mut all = self.projects.lock().unwrap();
        let p = all.get_mut(id).context("Project not found")?;
        if p.pages.iter().any(|x| x.url == page.url) {
            return Ok(false);
        }
        p.pages.push(page);
        p.revision += 1;
        if let Err(error) = save_json(&self.data.join("projects").join(id).join("project.json"), p)
        {
            p.pages.pop();
            p.revision -= 1;
            return Err(error);
        }
        Ok(true)
    }
    fn with_source_workspace(
        &self,
        project_id: &str,
        action: impl FnOnce(&crate::source_edit::SourceEdits<'_>) -> Result<Value>,
    ) -> Result<Value> {
        ensure!(
            self.projects.lock().unwrap().contains_key(project_id),
            "Project not found"
        );
        let github = self.config.require_github()?;
        let checkout = self.checkout()?;
        let remote = crate::source_edit::repository_origin(checkout, github)?;
        let repository = github.web_url();
        action(&crate::source_edit::SourceEdits {
            repo: checkout,
            data: &self.data,
            project: project_id,
            remote: &remote,
            repository: &repository,
            default_base: &self.config.base_branch,
            source_root: &self.config.source_root,
        })
    }
    fn source_provenance(&self, args: &Value) -> Result<Value> {
        let provenance = self.source_provenance_metadata(args)?;
        self.ensure_source_available(&provenance)?;
        Ok(provenance)
    }
    fn source_provenance_metadata(&self, args: &Value) -> Result<Value> {
        let all = self.projects.lock().unwrap();
        let project = args["project_id"]
            .as_str()
            .map(|id| all.get(id).context("Project not found"))
            .transpose()?;
        let page = if let Some(id) = args["page_id"].as_str() {
            Some(
                project
                    .as_ref()
                    .context("page_id requires project_id")?
                    .pages
                    .iter()
                    .find(|p| p.id == id)
                    .context("Page not found")?,
            )
        } else {
            None
        };
        let provenance =
            crate::design_index::provenance(project, page, &self.sha, self.repository().as_deref());
        drop(all);
        Ok(provenance)
    }
    fn repository(&self) -> Option<String> {
        self.config
            .github
            .as_ref()
            .map(crate::config::GithubRepo::web_url)
    }
    fn ensure_source_available(&self, provenance: &Value) -> Result<()> {
        let checkout = self.checkout()?;
        let sha = provenance["sha"]
            .as_str()
            .context("Source commit missing")?;
        ensure!(
            crate::design_index::sha_shape(sha),
            "Source commit is not a full Git SHA"
        );
        git(checkout,&["cat-file","-e",&format!("{sha}^{{commit}}")]).with_context(||format!("Pinned source commit {sha} is unavailable locally; fetch that exact commit before reading source. A later checkout is never substituted."))?;
        Ok(())
    }
    fn source_inventory(&self, sha: &str) -> Result<Vec<Value>> {
        let tree = git(self.checkout()?, &["ls-tree", "-r", sha])?;
        Ok(tree.lines().filter_map(|line|{
            let(meta,path)=line.split_once('\t')?;let parts=meta.split_whitespace().collect::<Vec<_>>();
            if parts.len()!=3||parts[1]!="blob"||!source_path(path)||!matches!(parts[0],"100644"|"100755"){return None;}
            Some(json!({"path":path,"kind":FsPath::new(path).extension().unwrap_or_default().to_string_lossy(),"blob":parts[2]}))
        }).collect())
    }
    fn repo_files(&self, query: &str, args: &Value) -> Result<Value> {
        let provenance = self.source_provenance(args)?;
        let sha = provenance["sha"].as_str().unwrap();
        let q = query.to_lowercase();
        ensure!(q.len() <= 2000, "Search query is too long");
        let files = self
            .source_inventory(sha)?
            .into_iter()
            .filter(|p| p["path"].as_str().unwrap_or("").to_lowercase().contains(&q))
            .collect::<Vec<_>>();
        let total = files.len();
        Ok(
            json!({"files":files.into_iter().take(2500).collect::<Vec<_>>(),"total":total,"truncated":total>2500,"repo":self.repository(),"sha":sha,"provenance":provenance}),
        )
    }
    fn read_source(&self, path: &str, args: &Value) -> Result<Value> {
        ensure!(
            source_path(path),
            "Only tracked website source files are readable"
        );
        let provenance = self.source_provenance(args)?;
        let sha = provenance["sha"].as_str().unwrap();
        let file = self
            .source_inventory(sha)?
            .into_iter()
            .find(|p| p["path"] == path)
            .context("Not a tracked source file at the pinned commit")?;
        let mut command = std::process::Command::new("git");
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000);
        }
        let out = command
            .arg("-C")
            .arg(self.checkout()?)
            .args(["show", &format!("{sha}:{path}")])
            .output()?;
        ensure!(out.status.success(), "Could not read pinned Git source");
        let content = String::from_utf8(out.stdout)?;
        ensure!(content.len() <= 2_000_000, "Source file exceeds 2 MB");
        Ok(
            json!({"path":path,"content":content,"sha":sha,"blob":file["blob"],"provenance":provenance}),
        )
    }
    fn page_sources(&self, project: &Project, page: &Page) -> Result<Value> {
        let provenance = crate::design_index::provenance(
            Some(project),
            Some(page),
            &self.sha,
            self.repository().as_deref(),
        );
        self.ensure_source_available(&provenance)?;
        let sha = provenance["sha"].as_str().unwrap();
        let inventory = self.source_inventory(sha)?;
        let (mut stylesheets, inline_styles) =
            crate::design_index::stylesheet_links(page, &self.config.source_root)?;
        let mut sources = BTreeMap::<String, Value>::new();
        for sheet in &mut stylesheets {
            sheet["sha"] = json!(sha);
            let path = sheet["repo_path"].as_str().unwrap_or("").to_string();
            if let Some(file) = inventory.iter().find(|f| f["path"] == path) {
                sheet["available"] = json!(true);
                sheet["blob"] = file["blob"].clone();
                sources.insert(path.clone(),json!({"path":path,"kind":file["kind"],"blob":file["blob"],"sha":sha,"relationship":"linked_stylesheet"}));
            } else {
                sheet["available"] = json!(false);
                sheet["unavailable_reason"] = json!(if path.is_empty() {
                    "External stylesheet; not in the connected repository"
                } else {
                    "URL has no matching tracked source at this commit"
                });
            }
        }
        let route = url::Url::parse(&page.url)?
            .path()
            .trim_matches('/')
            .to_string();
        let slug = route
            .split('/')
            .filter(|s| !s.is_empty())
            .next_back()
            .unwrap_or("");
        let mut names = vec![format!("page-{slug}.php")];
        if route.is_empty() {
            names = vec!["front-page.php".into(), "home.php".into()];
        }
        for file in &inventory {
            let path = file["path"].as_str().unwrap_or("");
            let name = FsPath::new(path)
                .file_name()
                .unwrap_or_default()
                .to_string_lossy();
            let direct_html = !route.is_empty()
                && (path.ends_with(&format!("/{route}/index.html"))
                    || path
                        == crate::design_index::web_root_path(&self.config.source_root, &route));
            if names.iter().any(|candidate| candidate == &name) || direct_html {
                sources.insert(path.to_string(),json!({"path":path,"kind":file["kind"],"blob":file["blob"],"sha":sha,"relationship":if direct_html{"url_path_candidate"}else{"route_template_candidate"}}));
            }
        }
        Ok(
            json!({"project_id":project.id,"page_id":page.id,"page_revision":page.revision,"url":page.url,"provenance":provenance,
            "stylesheets":stylesheets,"inline_styles":inline_styles,"source_files":sources.into_values().collect::<Vec<_>>(),
            "discovery":page.discovery,"sitemaps":project.source.get("sitemaps").cloned().unwrap_or(json!([])),
            "note":"Stylesheet associations come from captured HTML. PHP/HTML candidates match route names and are not a claimed runtime template trace. Source files are read-only and local design edits remain in exported snapshots."}),
        )
    }
    async fn sync_sitemap(self: &Arc<Self>, id: &str, max: usize) -> Result<Value> {
        let url = {
            let all = self.projects.lock().unwrap();
            let original = all.get(id).context("Project not found")?;
            ensure!(
                original.source["kind"] != "html",
                "HTML-only projects have no site sitemap to synchronize"
            );
            original.source["url"]
                .as_str()
                .context("Project has no site URL")?
                .to_string()
        };
        validate_url(&url)?;
        let discovered=self.worker(json!({"mode":"discover","sitemap_only":true,"url":url,"max_pages":max,"output_dir":self.data.join("projects").join(id).join("discovery")})).await?;
        let _edit = self.edit_lock.lock().await;
        self.apply_sitemap(id, &discovered)
    }
    fn apply_sitemap(&self, id: &str, discovered: &Value) -> Result<Value> {
        let rows = discovered["pages"]
            .as_array()
            .context("Discovery omitted pages")?;
        // Comments do not take edit_lock, so apply discovery directly to the
        // current project while holding the project lock through persistence.
        let mut all = self.projects.lock().unwrap();
        let project = all.get_mut(id).context("Project not found")?;
        let previous_source = project.source.clone();
        let previous_revision = project.revision;
        let previous_discovery = project
            .pages
            .iter()
            .map(|p| p.discovery.clone())
            .collect::<Vec<_>>();
        let mut matched = 0;
        let mut absent = vec![];
        for page in &mut project.pages {
            if let Some(row) = rows
                .iter()
                .find(|r| r["url"].as_str() == Some(page.url.as_str()))
            {
                if !page.discovery.is_object() {
                    page.discovery = json!({});
                }
                page.discovery["sitemap_urls"] = row["sitemap_urls"].clone();
                page.discovery["sitemap_status"] = json!("listed");
                page.discovery["sitemap_checked_at"] = json!(now());
                matched += 1;
            } else {
                if !page.discovery.is_object() {
                    page.discovery = json!({});
                }
                page.discovery["sitemap_status"] = json!(if discovered["complete"] == true {
                    "not_listed"
                } else {
                    "unknown"
                });
                page.discovery["sitemap_checked_at"] = json!(now());
                absent.push(json!({"page_id":page.id,"url":page.url}));
            }
        }
        let unimported=rows.iter().filter(|row|!project.pages.iter().any(|p|row["url"].as_str()==Some(p.url.as_str()))).map(|r|json!({"url":r["url"],"title":r["title"],"status":r["status"],"sources":r["sources"],"sitemap_urls":r["sitemap_urls"]})).collect::<Vec<_>>();
        let checked = now();
        project.source["sitemaps"] = discovered.get("sitemaps").cloned().unwrap_or(json!([]));
        project.source["sitemap_sync"] = json!({"complete":discovered["complete"],"warnings":discovered["warnings"],"count":rows.len(),"checked_at":checked,"matched_saved_pages":matched,"unimported_count":unimported.len(),"absent_saved_count":absent.len()});
        project.revision += 1;
        let result = json!({"project_id":id,"project_revision":project.revision,"checked_at":checked,"complete":discovered["complete"],"warnings":discovered["warnings"],"sitemaps":project.source["sitemaps"],"matched_saved_pages":matched,"saved_page_count":project.pages.len(),"unimported_pages":unimported,"absent_saved_pages":absent,"captures_preserved":true});
        if let Err(error) = save_json(
            &self.data.join("projects").join(id).join("project.json"),
            project,
        ) {
            project.source = previous_source;
            project.revision = previous_revision;
            for (page, discovery) in project.pages.iter_mut().zip(previous_discovery) {
                page.discovery = discovery;
            }
            return Err(error);
        }
        Ok(result)
    }
    fn export(&self, id: &str, format: &str) -> Result<Value> {
        let projects = self.projects.lock().unwrap();
        let project = projects.get(id).context("Project not found")?;
        let directory = self.data.join("projects").join(id).join("exports");
        std::fs::create_dir_all(&directory)?;
        let name = match format {
            "json" => "alcor-design.json",
            "css" => "alcor-design.css",
            "html" => "alcor-design-html.zip",
            _ => bail!("Export format must be html, json or css"),
        };
        let path = directory.join(name);
        match format {
            "json" => save_json(&path, &project)?,
            "css" => {
                let mut css = String::new();
                for p in &project.pages {
                    css.push_str(&format!(
                        "/* Page {} : {} — selectors belong to exported HTML */\n",
                        p.id,
                        p.url.replace("*/", "")
                    ));
                    for n in &p.nodes {
                        if let Some(style) = n.get("inline_style").and_then(Value::as_str) {
                            css.push_str(&format!(
                                "{} {{ {} }}\n",
                                n["selector"].as_str().unwrap_or(":root"),
                                style
                            ));
                        }
                    }
                    for edit in &p.edits {
                        if let Some(styles) = edit["styles"].as_object() {
                            css.push_str(&format!(
                                "{} {{\n",
                                edit["selector"].as_str().unwrap_or(":root")
                            ));
                            for (k, v) in styles {
                                css.push_str(&format!("  {k}: {};\n", v.as_str().unwrap_or("")));
                            }
                            css.push_str("}\n");
                        }
                    }
                }
                std::fs::write(&path, css)?;
            }
            "html" => {
                let file = std::fs::File::create(&path)?;
                let mut zip = zip::ZipWriter::new(file);
                let opts = zip::write::FileOptions::default()
                    .compression_method(zip::CompressionMethod::Deflated);
                for p in &project.pages {
                    if !p.html.is_empty() {
                        zip.start_file(format!("{}.html", p.id), opts)?;
                        zip.write_all(p.html.as_bytes())?;
                    }
                }
                zip.start_file("manifest.json", opts)?;
                zip.write_all(serde_json::to_string_pretty(&project.view())?.as_bytes())?;
                zip.start_file("README.txt", opts)?;
                zip.write_all(b"AlcorDesign edited HTML snapshots. Assets retain original absolute URLs and require the source site's network access. Scripts, forms, and embedded frames are removed. JSON source metadata records the repository SHA. These are design exports, not automatic PHP source patches.")?;
                zip.finish()?;
            }
            _ => unreachable!(),
        }
        Ok(
            json!({"url":format!("/files/projects/{id}/exports/{name}"),"name":name,"bytes":std::fs::metadata(path)?.len()}),
        )
    }
}

/// Decide, in request order, which requested URLs are new to a website project.
/// Any URL outside the project's own origin rejects the whole request.
fn plan_added_pages(
    project: &Project,
    urls: &[Value],
    max: usize,
) -> Result<(Vec<String>, Vec<Value>)> {
    ensure!(
        matches!(project.source["kind"].as_str(), Some("site" | "github")),
        "Pages can be added only to an imported website project"
    );
    let site = url::Url::parse(
        project.source["url"]
            .as_str()
            .context("Project has no site URL")?,
    )
    .context("Project site URL is invalid")?;
    ensure!(
        !urls.is_empty() && urls.len() <= 500,
        "Provide 1–500 page URLs"
    );
    let mut seen = BTreeSet::new();
    let mut queued = Vec::new();
    let mut results = Vec::new();
    for (index, raw) in urls.iter().enumerate() {
        let raw = raw
            .as_str()
            .with_context(|| format!("urls[{index}] must be a string"))?;
        let url =
            added_page_url(raw, &site).with_context(|| format!("urls[{index}] cannot be added"))?;
        let row = if let Some(page) = project.pages.iter().find(|p| p.url == url) {
            json!({"url":url,"state":"skipped_existing","page_id":page.id})
        } else if !seen.insert(url.clone()) {
            json!({"url":url,"state":"duplicate"})
        } else if queued.len() >= max {
            json!({"url":url,"state":"over_limit","message":format!("max_pages {max} reached; request it again later")})
        } else {
            queued.push(url.clone());
            json!({"url":url,"state":"queued"})
        };
        results.push(row);
    }
    Ok((queued, results))
}
/// Normalize one requested page URL against the project's site origin with the
/// renderer's discovery rules: no fragment, query, feed, asset or private route.
fn added_page_url(raw: &str, site: &url::Url) -> Result<String> {
    validate_url(raw)?;
    let mut url = url::Url::parse(raw)?;
    ensure!(
        url.origin() == site.origin(),
        "URL is not on this project's site {}",
        site.origin().ascii_serialization()
    );
    ensure!(
        url.query().is_none(),
        "Query strings are not importable; pass the page URL itself"
    );
    url.set_fragment(None);
    ensure!(
        importable_path(url.path()),
        "Authentication, administration, transaction, feed and asset routes are not importable"
    );
    Ok(url.to_string())
}
fn importable_path(path: &str) -> bool {
    const BLOCKED: &[&str] = &[
        "wp-admin",
        "wp-login.php",
        "wp-cron.php",
        "xmlrpc.php",
        "logout",
        "log-out",
        "sign-out",
        "checkout",
        "cart",
        "wp-json",
        "feed",
    ];
    const ASSETS: &[&str] = &[
        "png", "jpg", "jpeg", "gif", "webp", "avif", "svg", "ico", "css", "js", "mjs", "map",
        "json", "xml", "txt", "md", "csv", "woff", "woff2", "ttf", "otf", "mp4", "webm", "mp3",
        "wav", "zip", "pdf",
    ];
    let lower = path.to_ascii_lowercase();
    let last = lower.rsplit('/').next().unwrap_or("");
    !lower.split('/').any(|segment| BLOCKED.contains(&segment))
        && !last
            .rsplit_once('.')
            .is_some_and(|(_, ext)| ASSETS.contains(&ext))
}

fn discovery_record(row: &Value) -> Value {
    json!({"source":row["source"],"sources":row.get("sources").cloned().unwrap_or(json!([])),"sitemap_urls":row.get("sitemap_urls").cloned().unwrap_or(json!([])),"http_status":row["status"],"checked_at":now()})
}

fn git(repo: &FsPath, args: &[&str]) -> Result<String> {
    let mut command = std::process::Command::new("git");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let out = command.arg("-C").arg(repo).args(args).output()?;
    ensure!(
        out.status.success(),
        "Git query failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    Ok(String::from_utf8(out.stdout)?.trim().into())
}
/// The source boundary: only tracked web source files are readable. Hidden folders
/// (such as `.git` or `.github`) and dependency trees never are, whatever the extension.
fn source_path(path: &str) -> bool {
    !path.is_empty()
        && !path.contains('\\')
        && path.split('/').all(|segment| {
            !segment.is_empty()
                && segment != ".."
                && !segment.starts_with('.')
                && segment != "node_modules"
                && segment != "vendor"
        })
        && matches!(
            FsPath::new(path).extension().and_then(|e| e.to_str()),
            Some("html" | "php" | "css" | "js" | "mjs" | "svg")
        )
}
/// Check that an import URL names a public HTTPS site: a domain name (not an IP
/// literal or localhost), the default port and no embedded credentials. The
/// renderer additionally refuses names that resolve to private addresses.
///
/// # Errors
/// Returns an error describing the rule the URL breaks.
pub fn validate_url(raw: &str) -> Result<()> {
    let u = url::Url::parse(raw).context("Import URL is not a valid URL")?;
    let host = match u.host() {
        Some(url::Host::Domain(host)) => host.to_ascii_lowercase(),
        Some(_) => bail!("Import a site by its domain name, not an IP address"),
        None => bail!("Import URL has no host"),
    };
    ensure!(
        u.scheme() == "https"
            && host.contains('.')
            && host != "localhost"
            && !host.ends_with(".localhost")
            && u.port().is_none()
            && u.username().is_empty()
            && u.password().is_none(),
        "Imports need an HTTPS site on its default port without embedded credentials"
    );
    Ok(())
}
fn html_title(html: &str) -> String {
    let doc = scraper::Html::parse_document(html);
    let s = scraper::Selector::parse("title").unwrap();
    doc.select(&s)
        .next()
        .map(|e| e.text().collect::<String>())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "Imported HTML".into())
}
fn validate_styles(styles: &serde_json::Map<String, Value>) -> Result<()> {
    const ALLOWED: &[&str] = &[
        "color",
        "background",
        "background-color",
        "font-size",
        "font-family",
        "font-weight",
        "line-height",
        "letter-spacing",
        "text-align",
        "width",
        "height",
        "min-width",
        "min-height",
        "max-width",
        "max-height",
        "padding",
        "padding-top",
        "padding-right",
        "padding-bottom",
        "padding-left",
        "margin",
        "margin-top",
        "margin-right",
        "margin-bottom",
        "margin-left",
        "border",
        "border-color",
        "border-width",
        "border-radius",
        "box-shadow",
        "opacity",
        "display",
        "gap",
        "row-gap",
        "column-gap",
        "align-items",
        "justify-content",
        "flex-direction",
        "flex-wrap",
        "flex-grow",
        "flex-shrink",
        "flex-basis",
        "order",
        "align-content",
        "align-self",
        "justify-items",
        "justify-self",
        "grid-template-columns",
        "grid-template-rows",
        "grid-auto-flow",
        "grid-column",
        "grid-row",
        "transform",
        "translate",
        "position",
        "top",
        "left",
        "right",
        "bottom",
        "z-index",
        "overflow",
        "text-decoration",
        "visibility",
    ];
    ensure!(styles.len() <= 40, "Too many style properties");
    for (k, v) in styles {
        ensure!(ALLOWED.contains(&k.as_str()), "Unsupported style {k}");
        let val = v.as_str().context("CSS values must be strings")?;
        let lower = val.to_lowercase();
        ensure!(
            val.len() < 2000
                && !lower.contains("url(")
                && !lower.contains("expression")
                && !val.contains(['{', '}', ';', '<', '>']),
            "Unsafe CSS value"
        );
    }
    Ok(())
}
fn save_json(path: &FsPath, value: &impl Serialize) -> Result<()> {
    let parent = path.parent().context("Save path has no parent")?;
    std::fs::create_dir_all(parent)?;
    let tmp = parent.join(format!(".alcordesign-{}.tmp", uid()));
    let result = (|| -> Result<()> {
        let file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)?;
        let mut writer = std::io::BufWriter::with_capacity(64 * 1024, file);
        serde_json::to_writer(&mut writer, value)?;
        writer.flush()?;
        writer.get_ref().sync_all()?;
        drop(writer);
        std::fs::rename(&tmp, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

type AppState = Arc<App>;
fn api_error(e: anyhow::Error) -> Response {
    if let Some(conflict) = e.downcast_ref::<crate::collaboration::RevisionConflict>() {
        return (StatusCode::CONFLICT, Json(json!({"error":conflict.to_string(),"code":"revision_conflict","expected_revision":conflict.expected,"current_revision":conflict.current}))).into_response();
    }
    (
        StatusCode::BAD_REQUEST,
        Json(json!({"error":format!("{e:#}")})),
    )
        .into_response()
}
/// Build the HTTP router: static UI files, the JSON API and saved captures and exports.
/// Every request passes through `guard`, which enforces the Host, Origin and token checks.
pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/", get(index))
        .route("/app.js", get(js))
        .route("/inspectors.js", get(inspectors))
        .route("/collaboration.js", get(collaboration_js))
        .route("/design-insights.js", get(design_insights_js))
        .route("/design-insights.css", get(design_insights_css))
        .route("/api/collaboration/{id}", post(collaboration))
        .route("/style.css", get(css))
        .route("/api/projects", get(projects))
        .route("/api/project/{id}", get(project))
        .route("/api/page/{id}/{page}", get(page))
        .route("/api/jobs/{id}", get(job))
        .route("/api/tools", post(tool))
        .route("/files/{*path}", get(file))
        .layer(DefaultBodyLimit::max(5_000_000))
        .layer(middleware::from_fn_with_state(state.clone(), guard))
        .with_state(state)
}
/// Refuse requests that could come from another site or another local user.
///
/// The Host header must name the loopback listener on its bound port (this defeats DNS
/// rebinding), any Origin must be this app, and `/api/` and `/files/` need the per-run
/// token as a bearer header or the HttpOnly cookie set by the index page.
async fn guard(State(app): State<AppState>, req: Request, next: Next) -> Response {
    let expected = format!("127.0.0.1:{}", app.port);
    let localhost = format!("localhost:{}", app.port);
    let host = req
        .headers()
        .get("host")
        .and_then(|h| h.to_str().ok())
        .unwrap_or("");
    if host != expected && host != localhost {
        return (StatusCode::FORBIDDEN, "Invalid host").into_response();
    }
    if let Some(origin) = req.headers().get("origin").and_then(|h| h.to_str().ok()) {
        if origin != format!("http://{expected}") && origin != format!("http://{localhost}") {
            return (StatusCode::FORBIDDEN, "Cross-origin access refused").into_response();
        }
    }
    let needs_auth =
        req.uri().path().starts_with("/api/") || req.uri().path().starts_with("/files/");
    let bearer = req
        .headers()
        .get("authorization")
        .and_then(|h| h.to_str().ok())
        .is_some_and(|s| s == format!("Bearer {}", app.token));
    let cookie = req
        .headers()
        .get("cookie")
        .and_then(|h| h.to_str().ok())
        .is_some_and(|s| {
            s.split(';')
                .any(|p| p.trim() == format!("alcor_design={}", app.token))
        });
    if needs_auth && !bearer && !cookie {
        return (StatusCode::UNAUTHORIZED, "Local session required").into_response();
    }
    let mut response = next.run(req).await;
    let h = response.headers_mut();
    h.insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    h.insert("x-frame-options", HeaderValue::from_static("DENY"));
    h.insert("cache-control", HeaderValue::from_static("no-store"));
    h.insert("referrer-policy", HeaderValue::from_static("no-referrer"));
    response
}
async fn index(State(app): State<AppState>) -> Response {
    let result = std::fs::read(app.app_dir.join("ui/index.html"));
    match result {
        Ok(bytes) => {
            let mut headers = HeaderMap::new();
            headers.insert(
                "content-type",
                HeaderValue::from_static("text/html; charset=utf-8"),
            );
            headers.insert(
                "set-cookie",
                HeaderValue::from_str(&format!(
                    "alcor_design={}; HttpOnly; SameSite=Strict; Path=/",
                    app.token
                ))
                .unwrap(),
            );
            headers.insert("content-security-policy",HeaderValue::from_static("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"));
            (headers, bytes).into_response()
        }
        Err(e) => api_error(e.into()),
    }
}
async fn inspectors(State(a): State<AppState>) -> Response {
    static_file(
        a.app_dir.join("ui/inspectors.js"),
        "text/javascript; charset=utf-8",
    )
}
async fn collaboration_js(State(a): State<AppState>) -> Response {
    static_file(
        a.app_dir.join("ui/collaboration.js"),
        "text/javascript; charset=utf-8",
    )
}
async fn design_insights_js(State(a): State<AppState>) -> Response {
    static_file(
        a.app_dir.join("ui/design-insights.js"),
        "text/javascript; charset=utf-8",
    )
}
async fn design_insights_css(State(a): State<AppState>) -> Response {
    static_file(
        a.app_dir.join("ui/design-insights.css"),
        "text/css; charset=utf-8",
    )
}
async fn collaboration(
    State(a): State<AppState>,
    Path(id): Path<String>,
    Json(input): Json<crate::collaboration::Heartbeat>,
) -> Response {
    let result = (|| -> Result<Value> {
        // Small version inventory only. Full page contents use the existing read API.
        let projects = a.projects.lock().unwrap();
        let project = projects.get(&id).context("Project not found")?;
        if let Some(page_id) = &input.page_id {
            ensure!(
                project.pages.iter().any(|p| &p.id == page_id),
                "Page not found"
            );
        } else {
            ensure!(
                input.selector.is_none() && input.cursor.is_none(),
                "A cursor or selection requires a page"
            );
        }
        let sessions = a.collaboration.lock().unwrap().heartbeat(&id, input)?;
        Ok(
            json!({"project_id":id,"revision":project.revision,"sessions":sessions,"expires_after_ms":15000}),
        )
    })();
    match result {
        Ok(v) => Json(v).into_response(),
        Err(e) => api_error(e),
    }
}
async fn js(State(a): State<AppState>) -> Response {
    static_file(
        a.app_dir.join("ui/app.js"),
        "text/javascript; charset=utf-8",
    )
}
async fn css(State(a): State<AppState>) -> Response {
    static_file(a.app_dir.join("ui/style.css"), "text/css; charset=utf-8")
}
fn static_file(p: PathBuf, mime: &str) -> Response {
    match std::fs::read(p) {
        Ok(b) => ([("content-type", mime)], b).into_response(),
        Err(_) => (StatusCode::NOT_FOUND, "Not found").into_response(),
    }
}
async fn projects(State(a): State<AppState>) -> Response {
    match a.tool("design_list_projects", json!({})).await {
        Ok(v) => Json(v).into_response(),
        Err(e) => api_error(e),
    }
}
async fn project(State(a): State<AppState>, Path(id): Path<String>) -> Response {
    match a.project_view(&id) {
        Ok(view) => Json(view).into_response(),
        Err(e) => api_error(e),
    }
}
async fn page(State(a): State<AppState>, Path((id, p)): Path<(String, String)>) -> Response {
    match a
        .tool("design_get_page", json!({"project_id":id,"page_id":p}))
        .await
    {
        Ok(v) => Json(v).into_response(),
        Err(e) => api_error(e),
    }
}
async fn job(State(a): State<AppState>, Path(id): Path<String>) -> Response {
    match a.tool("design_get_job", json!({"job_id":id})).await {
        Ok(v) => Json(v).into_response(),
        Err(e) => api_error(e),
    }
}
async fn tool(State(a): State<AppState>, Json(v): Json<Value>) -> Response {
    match a
        .tool(
            v["name"].as_str().unwrap_or(""),
            v.get("arguments").cloned().unwrap_or(json!({})),
        )
        .await
    {
        Ok(v) => Json(v).into_response(),
        Err(e) => api_error(e),
    }
}
async fn file(State(a): State<AppState>, Path(path): Path<String>) -> Response {
    if !path.starts_with("projects/")
        || path
            .split('/')
            .any(|s| s == ".." || s.contains('\\') || s.contains(':'))
    {
        return (StatusCode::FORBIDDEN, "Invalid file").into_response();
    }
    let p = a.data.join(&path);
    let ext = p.extension().and_then(|s| s.to_str()).unwrap_or("");
    let export = path.contains("/exports/");
    if ext != "png" && !(export && matches!(ext, "zip" | "json" | "css")) {
        return (StatusCode::FORBIDDEN, "Not an export").into_response();
    }
    let Ok(real) = p.canonicalize() else {
        return (StatusCode::NOT_FOUND, "Not found").into_response();
    };
    if !real.starts_with(a.data.canonicalize().unwrap()) {
        return (StatusCode::FORBIDDEN, "Invalid file").into_response();
    }
    let mime = match ext {
        "png" => "image/png",
        "json" => "application/json",
        "css" => "text/css",
        _ => "application/zip",
    };
    let mut r = static_file(real, mime);
    if export {
        r.headers_mut().insert(
            "content-disposition",
            HeaderValue::from_str(&format!(
                "attachment; filename=\"{}\"",
                p.file_name().unwrap().to_string_lossy()
            ))
            .unwrap(),
        );
    }
    r
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{Config, GithubRepo};

    const SITE: &str = "https://www.example.com";

    #[test]
    fn streamed_json_save_is_atomic_on_serialization_failure() {
        use serde::ser::{Error as _, SerializeSeq};
        struct Broken;
        impl Serialize for Broken {
            fn serialize<S: serde::Serializer>(
                &self,
                serializer: S,
            ) -> std::result::Result<S::Ok, S::Error> {
                let mut seq = serializer.serialize_seq(Some(2))?;
                seq.serialize_element("partial")?;
                Err(S::Error::custom("intentional serialization failure"))
            }
        }
        let directory = std::env::temp_dir().join(format!("alcordesign-save-test-{}", uid()));
        std::fs::create_dir(&directory).unwrap();
        let path = directory.join("project.json");
        let first = json!({"pages":[{"html":"before","comments":["retained"]}]});
        save_json(&path, &first).unwrap();
        assert!(save_json(&path, &Broken).is_err());
        assert_eq!(
            serde_json::from_reader::<_, Value>(std::fs::File::open(&path).unwrap()).unwrap(),
            first
        );
        assert_eq!(std::fs::read_dir(&directory).unwrap().count(), 1);
        let second = json!({"pages":[{"html":"after","comments":["retained"]}]});
        save_json(&path, &second).unwrap();
        assert_eq!(
            serde_json::from_reader::<_, Value>(std::fs::File::open(&path).unwrap()).unwrap(),
            second
        );
        std::fs::remove_file(path).unwrap();
        std::fs::remove_dir(directory).unwrap();
    }
    #[test]
    fn import_origins() {
        assert!(validate_url(SITE).is_ok());
        assert!(validate_url(HTML_BASE).is_ok());
        for u in [
            "http://www.example.com",
            "https://127.0.0.1",
            "https://[::1]/",
            "https://localhost/",
            "https://app.localhost/",
            "https://user@example.com",
            "https://www.example.com:8443/",
            "https://intranet/",
            "file:///etc/passwd",
        ] {
            assert!(validate_url(u).is_err(), "accepted {u}");
        }
    }
    #[test]
    fn css_safety() {
        assert!(
            validate_styles(
                json!({"color":"#fff","font-size":"32px"})
                    .as_object()
                    .unwrap()
            )
            .is_ok()
        );
        for v in [
            json!({"background":"url(https://bad.test)"}),
            json!({"color":"red; display:none"}),
            json!({"behavior":"evil"}),
        ] {
            assert!(validate_styles(v.as_object().unwrap()).is_err());
        }
    }
    #[test]
    fn source_boundary() {
        assert!(source_path("site/wp-content/themes/a/index.php"));
        assert!(source_path("public/styles/main.css"));
        for p in [
            "../secret.php",
            "site/../secret.php",
            ".env",
            "site/config.json",
            "src/main.rs",
            ".github/workflows/site.js",
            "site/node_modules/pkg/index.js",
            "site\\index.php",
        ] {
            assert!(!source_path(p), "accepted {p}");
        }
    }
    fn site_project(pages: Vec<Page>) -> Project {
        Project {
            id: "fixture".into(),
            name: "Site fixture".into(),
            source: json!({"kind":"github","url":SITE}),
            pages,
            revision: 3,
            created: 1,
            job_id: None,
        }
    }
    #[test]
    fn added_pages_are_same_origin_new_and_bounded() {
        let saved = Page::pending(format!("{SITE}/about/"), "About".into());
        let project = site_project(vec![saved.clone()]);
        let urls = [
            format!("{SITE}/about/"),
            format!("{SITE}/map/#top"),
            format!("{SITE}/map/"),
            format!("{SITE}/pricing/"),
            format!("{SITE}/blog/"),
        ]
        .map(|u| json!(u));
        let (queued, results) = plan_added_pages(&project, &urls, 2).unwrap();
        assert_eq!(queued, [format!("{SITE}/map/"), format!("{SITE}/pricing/")]);
        let states = results
            .iter()
            .map(|r| r["state"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            states,
            [
                "skipped_existing",
                "queued",
                "duplicate",
                "queued",
                "over_limit"
            ]
        );
        assert_eq!(results[0]["page_id"], saved.id);
        for bad in [
            "https://example.com/about/",
            "http://www.example.com/about/",
            "https://www.example.com.evil.example/",
            "https://user@example.com/about/",
            "https://www.example.com:8443/about/",
            "https://www.example.com/?s=about",
            "https://www.example.com/wp-admin/",
            "https://www.example.com/feed/",
            "https://www.example.com/logo.png",
            "/map/",
        ] {
            assert!(
                plan_added_pages(&project, &[json!(bad)], 5).is_err(),
                "accepted {bad}"
            );
        }
        assert!(plan_added_pages(&project, &[json!(7)], 5).is_err());
        assert!(plan_added_pages(&project, &[], 5).is_err());
        let mut html = project.clone();
        html.source = json!({"kind":"html","url":SITE});
        assert!(plan_added_pages(&html, &[json!(format!("{SITE}/pricing/"))], 5).is_err());
    }

    /// A disposable folder under the system temp directory, removed by the caller.
    fn scratch(label: &str) -> Result<PathBuf> {
        let root = std::env::temp_dir().join(format!("alcordesign-{label}-{}", uid()));
        std::fs::create_dir_all(&root)?;
        Ok(root)
    }
    fn commit(repo: &FsPath, message: &str, allow_empty: bool) -> Result<()> {
        let mut args = vec![
            "-c",
            "user.name=AlcorDesign test",
            "-c",
            "user.email=local@example.com",
            "commit",
            "-m",
            message,
        ];
        if allow_empty {
            args.push("--allow-empty");
        }
        git(repo, &args)?;
        Ok(())
    }
    fn github_config() -> Config {
        Config {
            github: Some(GithubRepo::parse("owner/repo").unwrap()),
            base_branch: crate::config::DEFAULT_BASE_BRANCH.into(),
            source_root: "site".into(),
            site: Some(SITE.into()),
        }
    }

    #[test]
    fn app_runs_without_github_and_explains_how_to_enable_it() -> Result<()> {
        let root = scratch("no-github")?;
        let app = Arc::new(App::new(
            root.clone(),
            None,
            root.join("data"),
            1,
            Config::default(),
        )?);
        assert!(app.sha.is_empty());
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?;
        let status = runtime.block_on(app.tool("design_status", json!({})))?;
        assert!(status["github_repository"].is_null());
        let error = runtime
            .block_on(app.tool("design_repo_files", json!({})))
            .unwrap_err()
            .to_string();
        assert!(error.contains("ALCORDESIGN_GITHUB_REPO"), "{error}");
        drop(app);
        std::fs::remove_dir_all(root)?;
        Ok(())
    }

    #[test]
    fn checkout_with_another_origin_is_refused() -> Result<()> {
        let root = scratch("wrong-origin")?;
        let repo = root.join("repo");
        std::fs::create_dir_all(&repo)?;
        git(&repo, &["init"])?;
        git(
            &repo,
            &["remote", "add", "origin", "https://github.com/owner/other"],
        )?;
        commit(&repo, "Fixture", true)?;
        let result = App::new(
            root.clone(),
            Some(repo.canonicalize()?),
            root.join("data"),
            1,
            github_config(),
        );
        assert!(result.is_err());
        std::fs::remove_dir_all(root)?;
        Ok(())
    }

    #[test]
    fn appended_page_leaves_saved_pages_and_comments_unchanged() -> Result<()> {
        let root = scratch("add-pages")?;
        let app = App::new(root.clone(), None, root.join("data"), 1, Config::default())?;
        let mut owner = Page::pending(format!("{SITE}/about/"), "About".into());
        owner.comments.push(
            json!({"id":"thread","x":12.5,"y":40,"body":"owner note","replies":[{"body":"reply"}]}),
        );
        owner.edits.push(json!({"selector":"h1","text":"edited"}));
        let project = site_project(vec![
            owner,
            Page::pending(format!("{SITE}/platform/"), "Platform".into()),
        ]);
        app.save(project.clone())?;
        let file = root.join("data/projects/fixture/project.json");
        let before = serde_json::to_vec(&project.pages)?;
        let added = Page::pending(format!("{SITE}/map/"), "Map".into());
        assert!(app.append_page("fixture", added.clone())?);
        let saved: Project = serde_json::from_slice(&std::fs::read(&file)?)?;
        assert_eq!(serde_json::to_vec(&saved.pages[..2])?, before);
        assert_eq!(
            (
                saved.pages.len(),
                saved.revision,
                saved.pages[2].id.as_str()
            ),
            (3, project.revision + 1, added.id.as_str())
        );
        let bytes = std::fs::read(&file)?;
        assert!(!app.append_page(
            "fixture",
            Page::pending(format!("{SITE}/map/"), "Again".into())
        )?);
        assert_eq!(std::fs::read(&file)?, bytes);
        drop(app);
        std::fs::remove_dir_all(root)?;
        Ok(())
    }
    #[test]
    fn parses_html() {
        assert_eq!(
            html_title("<html><title>Design &amp; build</title></html>"),
            "Design & build"
        );
    }

    #[test]
    fn captured_source_uses_old_commit_even_when_current_file_is_deleted() -> Result<()> {
        let root = scratch("source-index")?;
        let repo = root.join("repo");
        std::fs::create_dir_all(&repo)?;
        git(&repo, &["init"])?;
        git(
            &repo,
            &[
                "remote",
                "add",
                "origin",
                "https://github.com/owner/repo.git",
            ],
        )?;
        let path = "site/wp-content/themes/example/assets/css/about.css";
        let file = repo.join(path);
        std::fs::create_dir_all(file.parent().unwrap())?;
        std::fs::write(&file, "body { color: red; }\n")?;
        git(&repo, &["add", "."])?;
        commit(&repo, "Captured source fixture", false)?;
        let captured = git(&repo, &["rev-parse", "HEAD"])?;
        std::fs::remove_file(&file)?;
        std::fs::write(repo.join("README.md"), "newer checkout")?;
        git(&repo, &["add", "-A"])?;
        commit(&repo, "Newer source fixture", false)?;
        let app = App::new(
            root.clone(),
            Some(repo.canonicalize()?),
            root.join("data"),
            1,
            github_config(),
        )?;
        assert_ne!(app.sha, captured);
        let mut page = Page::pending(format!("{SITE}/about/"), "About".into());
        page.commit = captured.clone();
        page.html = "<link rel='stylesheet' href='/wp-content/themes/example/assets/css/about.css?ver=1'><style>h1{color:gold}</style>".into();
        let mut project = Project {
            id: "fixture".into(),
            name: "Source fixture".into(),
            source: json!({"kind":"site","url":SITE}),
            pages: vec![page],
            revision: 1,
            created: now(),
            job_id: None,
        };
        app.save(project.clone())?;
        let args = json!({"project_id":project.id,"page_id":project.pages[0].id});
        let source = app.read_source(path, &args)?;
        assert_eq!(source["content"], "body { color: red; }\n");
        assert_eq!(source["sha"], captured);
        assert_eq!(source["provenance"]["basis"], "page_capture_commit");
        assert_eq!(
            source["provenance"]["repository"],
            "https://github.com/owner/repo"
        );
        let links = app.page_sources(&project, &project.pages[0])?;
        assert_eq!(links["stylesheets"][0]["available"], true);
        assert_eq!(links["stylesheets"][0]["sha"], captured);
        assert_eq!(links["inline_styles"][0]["content"], "h1{color:gold}");
        project.pages[0].commit = "ffffffffffffffffffffffffffffffffffffffff".into();
        app.save(project)?;
        // Source editing may use the current branch even when an old capture
        // object is unavailable; its capture SHA is retained as metadata only.
        assert_eq!(
            app.source_provenance_metadata(&args)?["sha"],
            "ffffffffffffffffffffffffffffffffffffffff"
        );
        assert!(
            format!("{:#}", app.read_source(path, &args).unwrap_err())
                .contains("A later checkout is never substituted")
        );
        // Simulate a crash after the page commit but before its operation
        // receipt was finalized. A later action must not erase its proof.
        let request = "refresh-crash-test-1";
        let page_id = args["page_id"].as_str().unwrap();
        let input = json!({"page_id":page_id,"expected_revision":0,"keep_snapshot":false,"expected_commit":null});
        crate::live_refresh::reserve(&app.data, "fixture", request, "page", &input, None)?;
        let mut saved = app.saved_page("fixture", page_id)?.1;
        let result = json!({"page_id":page_id,"revision":1,"commit":captured});
        saved.revision = 1;
        saved
            .live_refresh_history
            .insert(request.into(), result.clone());
        saved.last_live_refresh = json!({"request_id":request,"result":result});
        app.update_page("fixture", saved)?;
        let mut later = app.saved_page("fixture", page_id)?.1;
        later.revision = 2;
        later.last_live_refresh = json!({"request_id":"later-refresh","result":{}});
        app.update_page("fixture", later)?;
        let recovered = app.live_refresh_status("fixture", request)?;
        assert_eq!(recovered["state"], "completed");
        assert_eq!(recovered["result"]["revision"], 1);
        let abandoned = "refresh-abandoned-test";
        crate::live_refresh::reserve(&app.data, "fixture", abandoned, "page", &input, None)?;
        assert_eq!(
            app.live_refresh_status("fixture", abandoned)?["result"]["code"],
            "interrupted"
        );
        let uncertain = "refresh-save-uncertain";
        crate::live_refresh::reserve(&app.data, "fixture", uncertain, "page", &input, None)?;
        crate::live_refresh::progress(
            &app.data,
            "fixture",
            uncertain,
            json!({"phase":"committing"}),
        )?;
        assert_eq!(
            app.live_refresh_status("fixture", uncertain)?["state"],
            "pending"
        );
        let batch = "refresh-batch-interrupted";
        let job = "batch-test-job";
        crate::live_refresh::reserve(&app.data, "fixture", batch, "all", &json!({}), Some(job))?;
        crate::live_refresh::progress(
            &app.data,
            "fixture",
            batch,
            json!({"completed":1,"results":[{"state":"completed"}]}),
        )?;
        app.active_refresh_workers
            .lock()
            .unwrap()
            .insert(job.into());
        let worker = ActiveRefreshWorker {
            active: app.active_refresh_workers.clone(),
            job_id: job.into(),
        };
        assert_eq!(
            app.live_refresh_status("fixture", batch)?["state"],
            "pending"
        );
        drop(worker);
        let partial = app.live_refresh_status("fixture", batch)?;
        assert_eq!(partial["state"], "partial");
        assert_eq!(partial["result"]["completed"], 1);
        assert_eq!(partial["result"]["code"], "interrupted");
        // Sitemap sync must preserve comments already added to the current page.
        {
            let mut all = app.projects.lock().unwrap();
            all.get_mut("fixture").unwrap().pages[0]
                .comments
                .push(json!({"id":"comment-after-discovery","body":"keep"}));
        }
        app.apply_sitemap(
            "fixture",
            &json!({"pages":[{"url":format!("{SITE}/about/"),"sitemap_urls":[]}],"complete":true,"warnings":[]}),
        )?;
        assert_eq!(
            app.saved_page("fixture", page_id)?.1.comments[0]["id"],
            "comment-after-discovery"
        );
        drop(app);
        std::fs::remove_dir_all(root)?;
        Ok(())
    }
}
