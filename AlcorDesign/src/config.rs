//! Runtime configuration read from command-line flags and environment variables.
//!
//! Nothing about a particular website, repository or machine is compiled in. The server
//! resolves one [`Config`] at start-up and hands it to the application state; the optional
//! GitHub integration stays off until a repository is named.
use anyhow::{Context, Result, bail, ensure};

/// Default branch that source drafts are based on when none is configured.
pub const DEFAULT_BASE_BRANCH: &str = "main";

/// A GitHub repository named as `owner/repo`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GithubRepo {
    /// Account or organisation that owns the repository.
    pub owner: String,
    /// Repository name without a `.git` suffix.
    pub name: String,
}

impl GithubRepo {
    /// Parse `owner/repo`, rejecting anything that is not two plain path segments.
    ///
    /// # Errors
    /// Returns an error when the value is not of the form `owner/repo`.
    pub fn parse(value: &str) -> Result<Self> {
        let trimmed = value.trim().trim_end_matches(".git");
        let (owner, name) = trimmed
            .split_once('/')
            .context("GitHub repository must be written as owner/repo")?;
        let segment = |s: &str| {
            !s.is_empty()
                && s.len() <= 100
                && !s.starts_with('.')
                && s.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
        };
        ensure!(
            segment(owner) && segment(name),
            "GitHub repository must be written as owner/repo"
        );
        Ok(Self {
            owner: owner.to_owned(),
            name: name.to_owned(),
        })
    }

    /// `owner/repo`, as shown to users and tools.
    pub fn slug(&self) -> String {
        format!("{}/{}", self.owner, self.name)
    }

    /// The repository's web address, used for branch, compare and commit links.
    pub fn web_url(&self) -> String {
        format!("https://github.com/{}", self.slug())
    }

    /// True when a Git remote URL points at this repository.
    ///
    /// Accepts `https://github.com/owner/repo(.git)` and the scp-like
    /// scp-like form (a user name, then `github.com:owner/repo(.git)`), compared case-insensitively.
    pub fn matches_remote(&self, remote: &str) -> bool {
        let remote = remote.trim().trim_end_matches('/').trim_end_matches(".git");
        let path = if let Some(rest) = remote.strip_prefix("https://github.com/") {
            rest
        } else if let Some((_, host_path)) = remote.split_once('@') {
            match host_path.strip_prefix("github.com:") {
                Some(rest) => rest,
                None => return false,
            }
        } else {
            return false;
        };
        path.eq_ignore_ascii_case(&self.slug())
    }

    /// True when `value` names this repository either as `owner/repo` or as its web URL.
    pub fn matches_name(&self, value: &str) -> bool {
        let value = value.trim().trim_end_matches('/').trim_end_matches(".git");
        let value = value.strip_prefix("https://github.com/").unwrap_or(value);
        value.eq_ignore_ascii_case(&self.slug())
    }
}

/// Settings shared by the server, its tools and the source workspace.
#[derive(Clone, Debug, Default)]
pub struct Config {
    /// Repository for GitHub source browsing and drafts; `None` turns the feature off.
    pub github: Option<GithubRepo>,
    /// Branch that review branches are based on.
    pub base_branch: String,
    /// Repository folder that holds the deployed web root, without slashes (may be empty).
    pub source_root: String,
    /// Deployed site used when a GitHub import does not name `base_url`.
    pub site: Option<String>,
}

impl Config {
    /// Build the configuration from environment variables, with an optional `--github` override.
    ///
    /// Reads `ALCORDESIGN_GITHUB_REPO`, `ALCORDESIGN_GITHUB_BASE`, `ALCORDESIGN_SOURCE_ROOT`
    /// and `ALCORDESIGN_SITE`. Empty values count as unset.
    ///
    /// # Errors
    /// Returns an error when a configured value is malformed.
    pub fn from_env(github_flag: Option<&str>) -> Result<Self> {
        let var = |name: &str| std::env::var(name).ok().filter(|v| !v.trim().is_empty());
        let github = match github_flag
            .map(str::to_owned)
            .or_else(|| var("ALCORDESIGN_GITHUB_REPO"))
        {
            Some(value) => Some(GithubRepo::parse(&value)?),
            None => None,
        };
        let base_branch =
            var("ALCORDESIGN_GITHUB_BASE").unwrap_or_else(|| DEFAULT_BASE_BRANCH.into());
        let source_root = var("ALCORDESIGN_SOURCE_ROOT")
            .unwrap_or_default()
            .trim_matches('/')
            .to_owned();
        ensure!(
            !source_root.contains("..") && !source_root.contains('\\'),
            "ALCORDESIGN_SOURCE_ROOT must be a plain repository folder"
        );
        let site = var("ALCORDESIGN_SITE");
        if let Some(site) = &site {
            crate::app::validate_url(site)
                .context("ALCORDESIGN_SITE is not an importable HTTPS site")?;
        }
        Ok(Self {
            github,
            base_branch,
            source_root,
            site,
        })
    }

    /// The configured repository, or a clear error saying how to turn the feature on.
    ///
    /// # Errors
    /// Returns an error when no GitHub repository is configured.
    pub fn require_github(&self) -> Result<&GithubRepo> {
        match &self.github {
            Some(repo) => Ok(repo),
            None => bail!(
                "GitHub source is not configured. Set ALCORDESIGN_GITHUB_REPO to owner/repo (or pass --github owner/repo) and start with --repo pointing at a checkout of it."
            ),
        }
    }
}

/// Listen port from `ALCORDESIGN_PORT`, or 0 so the operating system picks a free one.
///
/// # Errors
/// Returns an error when the variable is set but is not a valid port number.
pub fn port_from_env() -> Result<u16> {
    match std::env::var("ALCORDESIGN_PORT") {
        Ok(value) if !value.trim().is_empty() => value
            .trim()
            .parse()
            .context("ALCORDESIGN_PORT must be a number from 0 to 65535"),
        _ => Ok(0),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repository_names_and_remotes() {
        let repo = GithubRepo::parse("owner/repo").unwrap();
        assert_eq!(repo.web_url(), "https://github.com/owner/repo");
        assert!(repo.matches_remote("https://github.com/owner/repo.git"));
        assert!(repo.matches_remote(&format!("{}@github.com:Owner/Repo.git", "git")));
        assert!(!repo.matches_remote("https://github.com/owner/other"));
        assert!(!repo.matches_remote("https://example.com/owner/repo"));
        assert!(repo.matches_name("https://github.com/owner/repo/"));
        for bad in [
            "owner",
            "owner/",
            "/repo",
            "owner/repo/extra",
            "../repo",
            "own er/repo",
        ] {
            assert!(GithubRepo::parse(bad).is_err(), "accepted {bad}");
        }
    }

    #[test]
    fn missing_repository_explains_how_to_enable_it() {
        let config = Config::default();
        let message = config.require_github().unwrap_err().to_string();
        assert!(message.contains("ALCORDESIGN_GITHUB_REPO"));
    }
}
