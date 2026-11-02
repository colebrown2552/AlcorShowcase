//! Offline, non-overwriting copy of one complete AlcorDesign project tree.
//!
//! This is not a live merge. The caller must supply a frozen offline snapshot;
//! the existing server lock excludes a concurrent destination server.
use anyhow::{Context, Result, bail, ensure};
use ring::digest::{Context as Digest, SHA256};
use serde_json::json;
use std::{
    fs::{self, File, OpenOptions},
    io::{BufReader, Read, Write},
    path::{Path, PathBuf},
};
use uuid::Uuid;
use walkdir::WalkDir;

fn safe_metadata(path: &Path) -> Result<std::fs::Metadata> {
    let meta =
        fs::symlink_metadata(path).with_context(|| format!("Cannot inspect {}", path.display()))?;
    ensure!(
        !meta.file_type().is_symlink(),
        "Symlinks are not supported: {}",
        path.display()
    );
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        ensure!(
            meta.file_attributes() & 0x400 == 0,
            "Reparse points are not supported: {}",
            path.display()
        );
    }
    Ok(meta)
}

fn digest_file(path: &Path) -> Result<(u64, String)> {
    let before = safe_metadata(path)?;
    ensure!(before.is_file(), "Not a regular file: {}", path.display());
    let mut f = File::open(path)?;
    let mut ctx = Digest::new(&SHA256);
    let mut buf = [0u8; 65536];
    let mut size = 0u64;
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        ctx.update(&buf[..n]);
        size += n as u64;
    }
    let after = safe_metadata(path)?;
    ensure!(
        before.len() == size && after.len() == size && before.modified()? == after.modified()?,
        "Source changed while being read: {}",
        path.display()
    );
    Ok((
        size,
        ctx.finish()
            .as_ref()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect(),
    ))
}

/// Copy one frozen project snapshot into `data` without overwriting, verifying hashes first.
///
/// # Errors
/// Fails on conflicting IDs, links, unsupported files, a changed snapshot or a busy server lock.
pub fn copy_project(source: &str, data: &str) -> Result<()> {
    let source = Path::new(source);
    let data = Path::new(data);
    ensure!(
        source.is_absolute() && data.is_absolute(),
        "Both paths must be absolute"
    );
    ensure!(safe_metadata(source)?.is_dir(), "Source is not a directory");
    ensure!(
        safe_metadata(data)?.is_dir(),
        "Data root is not an existing directory"
    );
    let source = source.canonicalize()?;
    let data = data.canonicalize()?;
    ensure!(
        !source.starts_with(&data) && !data.starts_with(&source),
        "Source and destination must be separate trees"
    );
    let _lock = crate::data_lock::ServerDataLock::acquire(&data)?;
    let projects = data.join("projects");
    ensure!(
        safe_metadata(&projects)?.is_dir(),
        "Destination projects directory is missing"
    );
    let project_file = source.join("project.json");
    ensure!(
        safe_metadata(&project_file)?.is_file(),
        "Source project.json is missing"
    );
    let initial_project_digest = digest_file(&project_file)?;
    let project: crate::app::Project =
        serde_json::from_reader(BufReader::new(File::open(&project_file)?))
            .context("Source project.json is invalid")?;
    ensure!(
        digest_file(&project_file)? == initial_project_digest,
        "Project changed during validation"
    );
    let id = project.id;
    ensure!(
        id.len() == 32
            && id
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
        "Invalid project ID"
    );
    let target = projects.join(&id);
    for entry in fs::read_dir(&projects)? {
        let entry = entry?;
        let meta = safe_metadata(&entry.path())?;
        ensure!(meta.is_dir(), "Unexpected destination project entry");
        let existing = entry.path().join("project.json");
        if existing.exists() {
            ensure!(
                safe_metadata(&existing)?.is_file(),
                "Invalid destination project file"
            );
            let p: crate::app::Project =
                serde_json::from_reader(BufReader::new(File::open(existing)?))
                    .context("Cannot inspect destination project")?;
            ensure!(
                p.id != id || entry.path() == target,
                "Project ID already exists in a different destination path"
            );
        }
    }
    let mut directories = Vec::<PathBuf>::new();
    let mut files = Vec::<(PathBuf, u64, String)>::new();
    let mut total = 0u64;
    for entry in WalkDir::new(&source).follow_links(false).min_depth(1) {
        let entry = entry?;
        let path = entry.path();
        let meta = safe_metadata(path)?;
        let rel = path.strip_prefix(&source)?.to_path_buf();
        ensure!(
            rel.components()
                .all(|c| matches!(c, std::path::Component::Normal(_))),
            "Invalid relative path"
        );
        if meta.is_dir() {
            directories.push(rel);
        } else if meta.is_file() {
            let (size, hash) = digest_file(path)?;
            total = total.checked_add(size).context("Project is too large")?;
            files.push((rel, size, hash));
        } else {
            bail!("Unsupported source file type");
        }
        ensure!(
            directories.len() + files.len() <= 20000 && total <= 10 * 1024 * 1024 * 1024,
            "Project exceeds copy limit"
        );
    }
    files.sort_by(|a, b| a.0.cmp(&b.0));
    directories.sort();
    ensure!(
        files
            .iter()
            .any(|(path, size, hash)| path == Path::new("project.json")
                && (*size, hash.clone()) == initial_project_digest),
        "Project changed during inventory"
    );
    let manifest = serde_json::to_vec(
        &json!({"schema":"alcordesign.copy-manifest.v1", "id":id, "directories":directories, "files":files}),
    )?;
    let staging_root = data.join(".project-copy");
    if !staging_root.exists() {
        fs::create_dir(&staging_root)?;
    }
    ensure!(
        safe_metadata(&staging_root)?.is_dir(),
        "Invalid copy staging directory"
    );
    let stage = staging_root.join(&id);
    let manifest_path = stage.join("manifest.json");
    let mut new_stage = false;
    if target.exists() {
        ensure!(
            safe_metadata(&target)?.is_dir()
                && stage.exists()
                && safe_metadata(&stage)?.is_dir()
                && manifest_path.exists(),
            "Existing project lacks a matching copy manifest"
        );
    } else if !stage.exists() {
        fs::create_dir(&stage).context("Could not create copy staging directory")?;
        new_stage = true;
    }
    ensure!(
        safe_metadata(&stage)?.is_dir(),
        "Invalid project staging directory"
    );
    if manifest_path.exists() {
        ensure!(
            safe_metadata(&manifest_path)?.is_file() && fs::read(&manifest_path)? == manifest,
            "Copy manifest does not match snapshot"
        );
    } else {
        ensure!(
            !target.exists() && new_stage,
            "Existing staging directory lacks a copy manifest; reconcile before retrying"
        );
        let temp_manifest = stage.join(format!("manifest-{}.pending", Uuid::new_v4().simple()));
        let mut f = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp_manifest)?;
        f.write_all(&manifest)?;
        f.sync_all()?;
        fs::hard_link(&temp_manifest, &manifest_path).context("Cannot publish copy manifest")?;
    }
    if !target.exists() {
        fs::create_dir(&target).context("Could not exclusively create destination project")?;
    }
    let mut existing_dirs = Vec::<PathBuf>::new();
    let mut existing_files = Vec::<PathBuf>::new();
    for entry in WalkDir::new(&target).follow_links(false).min_depth(1) {
        let entry = entry?;
        let path = entry.path();
        let meta = safe_metadata(path)?;
        let rel = path.strip_prefix(&target)?.to_path_buf();
        if meta.is_dir() {
            existing_dirs.push(rel);
        } else if meta.is_file() {
            existing_files.push(rel);
        } else {
            bail!("Unsupported destination file type");
        }
    }
    ensure!(
        existing_dirs.iter().all(|p| directories.contains(p))
            && existing_files
                .iter()
                .all(|p| files.iter().any(|(rel, _, _)| rel == p)),
        "Destination contains unknown entries"
    );
    for rel in &existing_files {
        let (_, size, hash) = files
            .iter()
            .find(|(path, _, _)| path == rel)
            .context("Unexpected destination file")?;
        ensure!(
            digest_file(&target.join(rel))? == (*size, hash.clone()),
            "Existing destination file differs from snapshot"
        );
    }
    let already_complete = target.join("project.json").exists();
    ensure!(
        !already_complete
            || (existing_dirs.len() == directories.len() && existing_files.len() == files.len()),
        "Published project is incomplete; refusing to modify it"
    );
    for dir in &directories {
        fs::create_dir_all(target.join(dir))?;
    }
    for (rel, size, hash) in &files {
        if rel == Path::new("project.json") || target.join(rel).exists() {
            continue;
        }
        let src = source.join(rel);
        let dst = stage.join(format!("file-{}.pending", Uuid::new_v4().simple()));
        let mut input = File::open(&src)?;
        let mut output = OpenOptions::new().write(true).create_new(true).open(&dst)?;
        std::io::copy(&mut input, &mut output)?;
        output.flush()?;
        output.sync_all()?;
        ensure!(
            digest_file(&src)? == (*size, hash.clone())
                && digest_file(&dst)? == (*size, hash.clone()),
            "File changed during copy or digest mismatch"
        );
        fs::hard_link(&dst, target.join(rel)).context("Cannot publish copied file")?;
    }
    let mut final_dirs = Vec::<PathBuf>::new();
    let mut final_files = Vec::<(PathBuf, u64, String)>::new();
    for entry in WalkDir::new(&source).follow_links(false).min_depth(1) {
        let entry = entry?;
        let path = entry.path();
        let meta = safe_metadata(path)?;
        let rel = path.strip_prefix(&source)?.to_path_buf();
        if meta.is_dir() {
            final_dirs.push(rel);
        } else if meta.is_file() {
            let (size, hash) = digest_file(path)?;
            final_files.push((rel, size, hash));
        } else {
            bail!("Unsupported source file type");
        }
        ensure!(
            final_dirs.len() + final_files.len() <= 20000,
            "Source grew beyond copy limit"
        );
    }
    final_dirs.sort();
    final_files.sort_by(|a, b| a.0.cmp(&b.0));
    ensure!(
        final_dirs == directories && final_files == files,
        "Source tree changed before publication"
    );
    // Publish only after every file has been copied and verified. hard_link is
    // exclusive and never replaces an existing project.json.
    if !already_complete {
        let pending = stage.join(format!("project-{}.pending", Uuid::new_v4().simple()));
        let mut input = File::open(&project_file)?;
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&pending)?;
        std::io::copy(&mut input, &mut output)?;
        output.flush()?;
        output.sync_all()?;
        ensure!(
            digest_file(&pending)? == initial_project_digest
                && digest_file(&project_file)? == initial_project_digest,
            "Project changed before publication"
        );
        fs::hard_link(&pending, target.join("project.json"))?;
    }
    // Publication has happened (or was already present); any failure below
    // must be reconciled as a potentially completed operation, never replayed
    // blindly. Re-read the destination rather than trusting the earlier scan.
    let verify_published = || -> Result<()> {
        let mut dirs = Vec::<PathBuf>::new();
        let mut rows = Vec::<(PathBuf, u64, String)>::new();
        for entry in WalkDir::new(&target).follow_links(false).min_depth(1) {
            let entry = entry?;
            let path = entry.path();
            let meta = safe_metadata(path)?;
            let rel = path.strip_prefix(&target)?.to_path_buf();
            if meta.is_dir() {
                dirs.push(rel);
            } else if meta.is_file() {
                let (size, hash) = digest_file(path)?;
                rows.push((rel, size, hash));
            } else {
                bail!("Unsupported destination file type");
            }
            ensure!(
                dirs.len() + rows.len() <= 20000,
                "Destination exceeds entry limit"
            );
        }
        dirs.sort();
        rows.sort_by(|a, b| a.0.cmp(&b.0));
        ensure!(
            dirs == directories && rows == files,
            "Published project differs from snapshot"
        );
        Ok(())
    };
    verify_published().context("Project may already be published; reconcile before retrying")?;
    println!(
        "{}",
        json!({"schema":"alcordesign.project-copy.v1","project_id":id,"files":files.len(),"directories":directories.len(),"bytes":total,"page_count":project.pages.len(),"source_verified_before_publication":true,"already_complete":already_complete})
    );
    Ok(())
}
