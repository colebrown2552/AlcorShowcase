//! Command-line entry point for AlcorDesign.
//!
//! `serve` runs the local HTTP application, `mcp` speaks MCP over stdio to a running
//! server, `call` sends one tool request, and `copy-project` imports a frozen project
//! snapshot. Arguments are parsed strictly so a typo never starts a server by accident.
mod app;
mod collaboration;
mod config;
mod data_lock;
mod data_paths;
mod design_index;
mod live_refresh;
mod mcp;
mod project_copy;
mod source_edit;
use anyhow::{Context, Result, bail, ensure};
use std::{path::PathBuf, sync::Arc};

const HELP: &str = "AlcorDesign 0.1
  alcor-design serve [--port N] [--data PATH] [--github OWNER/REPO --repo PATH]
  alcor-design mcp
  alcor-design call TOOL [JSON]
  alcor-design copy-project --source-snapshot PATH --data PATH
Environment: ALCORDESIGN_PORT (default: a free port), ALCORDESIGN_DATA_DIR,
ALCORDESIGN_GITHUB_REPO (owner/repo), ALCORDESIGN_GITHUB_BASE, ALCORDESIGN_SOURCE_ROOT,
ALCORDESIGN_SITE, ALCORDESIGN_APP_DIR, ALCORDESIGN_PLAYWRIGHT, ALCORDESIGN_CHROME.";

#[derive(Debug, PartialEq, Eq)]
enum Action {
    Help,
    Mcp,
    Call { tool: String, arguments: String },
    CopyProject { source: String, data: String },
    Serve(ServeOptions),
}

/// Options accepted by `serve`; unset values fall back to the environment.
#[derive(Debug, Default, PartialEq, Eq)]
struct ServeOptions {
    port: Option<u16>,
    repo: Option<String>,
    data: Option<String>,
    github: Option<String>,
}

fn parse_args(args: &[String]) -> Result<Action> {
    let first = args.first().map(String::as_str);
    match first {
        Some("--help" | "-h" | "help") => {
            ensure!(args.len() == 1, "Help does not accept additional arguments");
            return Ok(Action::Help);
        }
        Some("mcp") => {
            ensure!(args.len() == 1, "mcp does not accept additional arguments");
            return Ok(Action::Mcp);
        }
        Some("call") => {
            ensure!(
                (2..=3).contains(&args.len()),
                "Usage: alcor-design call TOOL [JSON]"
            );
            ensure!(!args[1].is_empty(), "Tool name must not be empty");
            return Ok(Action::Call {
                tool: args[1].clone(),
                arguments: args.get(2).cloned().unwrap_or_else(|| "{}".into()),
            });
        }
        Some("copy-project") => {
            ensure!(
                args.len() == 5 && args[1] == "--source-snapshot" && args[3] == "--data",
                "Usage: alcor-design copy-project --source-snapshot PATH --data PATH"
            );
            ensure!(
                !args[2].is_empty() && !args[4].is_empty(),
                "Paths must not be empty"
            );
            return Ok(Action::CopyProject {
                source: args[2].clone(),
                data: args[4].clone(),
            });
        }
        Some("serve") if args.get(1).is_some_and(|x| x == "--help" || x == "-h") => {
            ensure!(
                args.len() == 2,
                "serve help does not accept additional arguments"
            );
            return Ok(Action::Help);
        }
        // A bare option list is the server form, as is no argument at all.
        Some("serve") | None => {}
        Some(value) if value.starts_with("--") => {}
        Some(_) => bail!("Unknown command. Use --help for usage"),
    }
    let options = if first == Some("serve") {
        &args[1..]
    } else {
        args
    };
    let mut serve = ServeOptions::default();
    let mut i = 0;
    while i < options.len() {
        let key = options[i].as_str();
        ensure!(
            matches!(key, "--port" | "--repo" | "--data" | "--github"),
            "Unknown server option: {key}"
        );
        let value = options
            .get(i + 1)
            .context("Server option requires a value")?;
        ensure!(
            !value.is_empty() && !value.starts_with("--"),
            "Server option requires a value: {key}"
        );
        let slot = match key {
            "--port" => {
                ensure!(serve.port.is_none(), "Duplicate --port option");
                serve.port = Some(
                    value
                        .parse()
                        .context("--port must be between 0 and 65535")?,
                );
                i += 2;
                continue;
            }
            "--repo" => &mut serve.repo,
            "--data" => &mut serve.data,
            "--github" => &mut serve.github,
            _ => unreachable!(),
        };
        ensure!(slot.is_none(), "Duplicate {key} option");
        *slot = Some(value.clone());
        i += 2;
    }
    Ok(Action::Serve(serve))
}

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let options = match parse_args(&args)? {
        Action::Help => {
            println!("{HELP}");
            return Ok(());
        }
        Action::Mcp => return mcp::run().await,
        Action::Call { tool, arguments } => return mcp::call_once(&tool, &arguments).await,
        Action::CopyProject { source, data } => return project_copy::copy_project(&source, &data),
        Action::Serve(options) => options,
    };
    let config = config::Config::from_env(options.github.as_deref())?;
    let app_dir = std::env::var_os("ALCORDESIGN_APP_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")));
    // A checkout is only needed for GitHub source browsing; without one the
    // editor still imports, renders, edits and exports pages.
    let repo = match (&config.github, options.repo) {
        (Some(_), Some(path)) => Some(PathBuf::from(path)),
        (Some(_), None) => Some(std::env::current_dir()?),
        (None, Some(_)) => bail!(
            "--repo needs a GitHub repository: set ALCORDESIGN_GITHUB_REPO to owner/repo or pass --github"
        ),
        (None, None) => None,
    };
    let repo = repo
        .map(|path| {
            path.canonicalize()
                .context("Repository folder does not exist")
        })
        .transpose()?;
    let data = match options.data {
        Some(path) => PathBuf::from(path),
        None => data_paths::default_data_dir()?,
    };
    let port = match options.port {
        Some(port) => port,
        None => config::port_from_env()?,
    };
    // Hold the OS lock for the entire server lifetime. Acquire it before App::new
    // reloads and repairs persisted projects, or writes runtime.json.
    let _data_lock = data_lock::ServerDataLock::acquire(&data)?;
    // Bind before building the app so the Host check and runtime descriptor use
    // the port the operating system actually assigned when 0 was requested.
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port))
        .await
        .context("AlcorDesign port is in use")?;
    let port = listener.local_addr()?.port();
    let state = Arc::new(app::App::new(app_dir, repo, data, port, config)?);
    state.write_runtime()?;
    eprintln!("AlcorDesign listening at http://127.0.0.1:{port}");
    axum::serve(listener, app::router(state))
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}

#[cfg(test)]
mod cli_tests {
    use super::*;

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn help_is_never_a_server_action() {
        for values in [
            &["--help"][..],
            &["-h"],
            &["help"],
            &["serve", "--help"],
            &["serve", "-h"],
        ] {
            assert_eq!(parse_args(&args(values)).unwrap(), Action::Help);
        }
    }

    #[test]
    fn invalid_arguments_fail_before_server_action() {
        for values in [
            &["server"][..],
            &["serve", "--help", "extra"],
            &["serve", "--repo"],
            &["serve", "--repo", "--data", "elsewhere"],
            &["serve", "--port", "65536"],
            &["serve", "--port", "1", "--port", "2"],
            &["serve", "--github", "a/b", "--github", "c/d"],
            &["serve", "--typo", "x"],
            &["unknown-command"],
            &["mcp", "unexpected"],
            &["call"],
            &["call", "tool", "{}", "extra"],
        ] {
            assert!(parse_args(&args(values)).is_err(), "accepted {values:?}");
        }
    }

    #[test]
    fn server_options_parse_in_any_order() {
        let expected = Action::Serve(ServeOptions {
            port: Some(8080),
            repo: Some("a repo".into()),
            data: Some("data".into()),
            github: Some("owner/repo".into()),
        });
        let ordered = [
            "serve",
            "--repo",
            "a repo",
            "--port",
            "8080",
            "--data",
            "data",
            "--github",
            "owner/repo",
        ];
        assert_eq!(parse_args(&args(&ordered)).unwrap(), expected);
        let bare = [
            "--github",
            "owner/repo",
            "--port",
            "8080",
            "--repo",
            "a repo",
            "--data",
            "data",
        ];
        assert_eq!(parse_args(&args(&bare)).unwrap(), expected);
        assert_eq!(
            parse_args(&args(&[])).unwrap(),
            Action::Serve(ServeOptions::default())
        );
        assert_eq!(
            parse_args(&args(&["serve", "--port", "0"])).unwrap(),
            Action::Serve(ServeOptions {
                port: Some(0),
                ..ServeOptions::default()
            })
        );
        assert_eq!(parse_args(&args(&["mcp"])).unwrap(), Action::Mcp);
        assert_eq!(
            parse_args(&args(&["call", "design_status"])).unwrap(),
            Action::Call {
                tool: "design_status".into(),
                arguments: "{}".into()
            }
        );
    }
}
