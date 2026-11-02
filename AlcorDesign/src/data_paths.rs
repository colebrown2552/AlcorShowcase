//! Data directory discovery shared by the server and the local MCP client, so both find
//! the same `runtime.json` without extra configuration.
use anyhow::{Context, Result, ensure};
use std::path::PathBuf;

fn absolute_env(name: &str) -> Option<PathBuf> {
    std::env::var_os(name)
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
}

/// `ALCORDESIGN_DATA_DIR`, else the platform data folder (`LOCALAPPDATA` on Windows,
/// `XDG_DATA_HOME` or `~/.local/share` elsewhere) plus `AlcorDesign`.
///
/// # Errors
/// Fails when no absolute base directory can be determined.
pub fn default_data_dir() -> Result<PathBuf> {
    if let Some(value) = std::env::var_os("ALCORDESIGN_DATA_DIR") {
        let path = PathBuf::from(value);
        ensure!(
            path.is_absolute(),
            "ALCORDESIGN_DATA_DIR must be an absolute path"
        );
        return Ok(path);
    }
    if let Some(base) = absolute_env("LOCALAPPDATA") {
        return Ok(base.join("AlcorDesign"));
    }
    if cfg!(windows) {
        anyhow::bail!(
            "LOCALAPPDATA is missing or invalid; set ALCORDESIGN_DATA_DIR to an absolute path"
        );
    }
    let base = match absolute_env("XDG_DATA_HOME") {
        Some(path) => path,
        None => absolute_env("HOME")
            .context(
                "No persistent data directory; set XDG_DATA_HOME, HOME, or ALCORDESIGN_DATA_DIR",
            )?
            .join(".local")
            .join("share"),
    };
    Ok(base.join("AlcorDesign"))
}
