use std::process::{Child, Command};

const DEFAULT_PORT: u16 = 9755;

/// Tracks a running sidecar process
pub struct SidecarProcess {
    child: Child,
    pub port: u16,
}

/// Manages the coderix backend sidecar lifecycle
pub struct SidecarManager {
    process: Option<SidecarProcess>,
}

impl SidecarManager {
    pub fn new() -> Self {
        Self { process: None }
    }

    /// Start the coderix backend as a sidecar process.
    ///
    /// Uses `npx tsx` for development or a bundled binary for production.
    /// Passes `--desktop --desktop-port PORT` to start the WebSocket gateway.
    pub fn start<F>(&mut self, on_ready: F)
    where
        F: FnOnce(SidecarReadyInfo) + Send + 'static,
    {
        let port = DEFAULT_PORT;

        // For development: run via tsx directly from the project
        let child = Command::new("npx")
            .args([
                "tsx",
                "../src/cli/main.tsx",
                "--desktop",
                "--desktop-port",
                &port.to_string(),
            ])
            .current_dir("..") // Run from coderix root
            .spawn();

        match child {
            Ok(child) => {
                let proc = SidecarProcess {
                    child,
                    port,
                };
                self.process = Some(proc);

                // Give the sidecar a moment to start, then fire callback
                let info = SidecarReadyInfo { port };
                std::thread::spawn(move || {
                    // Brief delay to let the WebSocket server start
                    std::thread::sleep(std::time::Duration::from_millis(1500));
                    on_ready(info);
                });
            }
            Err(e) => {
                eprintln!("[coderix-desktop] Failed to start sidecar: {}", e);
            }
        }
    }

    /// Stop the sidecar process
    pub fn stop(&mut self) {
        if let Some(mut proc) = self.process.take() {
            let _ = proc.child.kill();
            let _ = proc.child.wait();
        }
    }

    /// Check if the sidecar process is still running
    pub fn is_running(&mut self) -> bool {
        if let Some(ref mut proc) = self.process {
            match proc.child.try_wait() {
                Ok(Some(_)) => false, // Exited
                Ok(None) => true,      // Still running
                Err(_) => false,
            }
        } else {
            false
        }
    }

    /// Get the sidecar port
    pub fn port(&self) -> Option<u16> {
        self.process.as_ref().map(|p| p.port)
    }
}

/// Information about a started sidecar
#[derive(serde::Serialize, Clone)]
pub struct SidecarReadyInfo {
    pub port: u16,
}
