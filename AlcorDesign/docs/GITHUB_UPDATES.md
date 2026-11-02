# GitHub source and incoming updates

Source browsing and editing are optional. They turn on when the server starts with a
repository and a checkout of it:

```sh
export ALCORDESIGN_GITHUB_REPO="owner/repo"
alcor-design serve --repo /path/to/checkout
```

The checkout's `origin` must point at `https://github.com/owner/repo` (HTTPS or scp-style Git URL);
anything else is refused at start-up. `ALCORDESIGN_GITHUB_BASE` names the branch that review
branches start from (default `main`), and `ALCORDESIGN_SOURCE_ROOT` names the repository
folder that holds the deployed web root, if it is not the repository root. Without a
repository the Stylesheet and Files tabs say the feature is not configured; every other
editor feature still works.

## Watching for upstream changes

Site and GitHub projects check for upstream changes while the browser tab is visible.
HTML-only projects check only on **Check now**. **Live GitHub updates** pauses automatic
checks without discarding source edits.

The server shares a 30-second observation cache across clients, bounded to 64 projects.
A source operation already in progress returns `busy` instead of queuing more fetches. A
disconnected browser does not cancel the server's bounded Git operation or lose its cached
result. Errors stay errors, with any previous snapshot marked stale. Browser retries back
off, pause while hidden, and never replay saves or pushes.

`design_source_updates({project_id})` returns `state` (`ready`, `busy`, `error`),
`retry_after_ms` and, when available, `snapshot`. The snapshot reports the exact base,
review and merge-base heads and the CSS/PHP inventory. File records include blob, mode and
source commit. Saved drafts whose source disappeared stay present with `deleted: true`.
`upstream_changed` compares the current blob and mode with the draft's original baseline;
it is not a merge-conflict claim. Branch conflicts are reported separately. The inventory
is bounded to 2,500 files; every saved dirty draft is still included.

Clean repository views and clean source editors refresh automatically. Local typing, saved
drafts, unresolved operations and branch conflicts keep the current text. Editor state and
project identity are checked again after each read. An unrelated upstream commit does not
invalidate a file whose blob is unchanged. Page captures, canvas edits and comments are not
refreshed by the source watcher; live refresh updates captures.

## Drafts and review branches

Drafts are saved in the data directory. **Sync to GitHub** commits them in an app-private
bare Git cache and pushes to `alcordesign/<project_id>`, never to the base branch, never with
force, and never through the configured checkout's index or worktree. Pushing uses the Git
credentials already available to the server's user. A pushed review branch is not a
deployment: merging and deploying stay with the site's own process. Canvas edits are not
translated into PHP or CSS source automatically.
