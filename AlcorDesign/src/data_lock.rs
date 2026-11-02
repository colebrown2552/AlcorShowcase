//! A process-wide exclusive lock for the persistent AlcorDesign data directory.
//!
//! The lock file is intentionally retained: ownership is represented by the OS
//! lock held on its open handle, never by whether a marker file exists.
use anyhow::{Context, Result, anyhow, bail};
use std::{
    fs::{File, OpenOptions},
    path::Path,
};

const LOCK_FILE: &str = ".server.lock";

/// Exclusive OS lock on `.server.lock`, held for the server's whole lifetime.
pub struct ServerDataLock {
    // Keeping this handle alive keeps the OS lock alive.
    _file: File,
}

impl ServerDataLock {
    /// Take the lock, failing immediately if another server holds it.
    ///
    /// # Errors
    /// Fails when the directory cannot be created or another process owns the lock.
    pub fn acquire(data_dir: &Path) -> Result<Self> {
        std::fs::create_dir_all(data_dir).with_context(|| {
            format!(
                "Could not create AlcorDesign data directory {}",
                data_dir.display()
            )
        })?;
        let canonical_data_dir = data_dir.canonicalize().with_context(|| {
            format!(
                "Could not resolve AlcorDesign data directory {}",
                data_dir.display()
            )
        })?;
        let path = canonical_data_dir.join(LOCK_FILE);
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&path)
            .with_context(|| {
                format!("Could not open AlcorDesign server lock {}", path.display())
            })?;
        match file.try_lock() {
            Ok(()) => Ok(Self { _file: file }),
            Err(std::fs::TryLockError::WouldBlock) => bail!(
                "Another AlcorDesign server already holds the data directory lock at {}",
                canonical_data_dir.display()
            ),
            Err(std::fs::TryLockError::Error(error)) => Err(anyhow!(error).context(format!(
                "Could not lock AlcorDesign data directory {}",
                canonical_data_dir.display()
            ))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{BufRead, BufReader, Write},
        process::{Command, Stdio},
        sync::mpsc,
        thread,
        time::{SystemTime, UNIX_EPOCH},
    };

    const CHILD_DATA_ENV: &str = "ALCORDESIGN_TEST_LOCK_CHILD_DATA";

    #[test]
    fn process_lock_excludes_second_process_until_exit() {
        // The test re-enters itself in a child test process so the assertion
        // covers OS-level locking, rather than only same-process handles.
        if let Some(path) = std::env::var_os(CHILD_DATA_ENV) {
            let _lock = ServerDataLock::acquire(Path::new(&path)).unwrap();
            println!("LOCK_HELD");
            std::io::stdout().flush().unwrap();
            let mut release = String::new();
            std::io::stdin().read_line(&mut release).unwrap();
            return;
        }

        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let data =
            std::env::temp_dir().join(format!("alcordesign-lock-{}-{nonce}", std::process::id()));
        let executable = std::env::current_exe().unwrap();
        let mut child = Command::new(executable)
            .args([
                "--exact",
                "data_lock::tests::process_lock_excludes_second_process_until_exit",
                "--nocapture",
            ])
            .env(CHILD_DATA_ENV, &data)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let stdout = child.stdout.take().unwrap();
        let (line_tx, line_rx) = mpsc::channel();
        let reader = thread::spawn(move || {
            let mut output = BufReader::new(stdout);
            let mut line = String::new();
            while output.read_line(&mut line).unwrap_or(0) != 0 {
                if line_tx.send(line.clone()).is_err() {
                    break;
                }
                line.clear();
            }
        });
        let mut ready = false;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while std::time::Instant::now() < deadline {
            let timeout = deadline.saturating_duration_since(std::time::Instant::now());
            match line_rx.recv_timeout(timeout) {
                Ok(line) if line.contains("LOCK_HELD") => {
                    ready = true;
                    break;
                }
                Ok(_) => {}
                Err(_) => break,
            }
        }
        if !ready {
            let _ = child.kill();
            let status = child.wait().unwrap();
            reader.join().unwrap();
            panic!("child did not acquire lock (exit status {status})");
        }
        // A lexical alias must resolve to the same lock identity.
        let second = ServerDataLock::acquire(&data.join("."));
        let excluded = second
            .as_ref()
            .is_err_and(|e| e.to_string().contains("already holds"));
        drop(second);

        // Release and join the child before asserting, so a regression does
        // not leave a test server process behind.
        writeln!(child.stdin.as_mut().unwrap(), "release").unwrap();
        drop(child.stdin.take());
        let status = child.wait().unwrap();
        reader.join().unwrap();
        assert!(status.success(), "child lock process failed");
        assert!(
            excluded,
            "second process acquired the same data directory lock"
        );

        // Process exit releases the kernel lock; the durable lock file remains.
        let restarted = ServerDataLock::acquire(&data.join("."))
            .expect("lock should be available after server exit");
        assert!(data.join(LOCK_FILE).exists());
        drop(restarted);
    }
}
