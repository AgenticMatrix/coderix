mod commands;
mod sidecar;

use commands::{window, dialog};
use sidecar::manager::SidecarManager;
use std::sync::Mutex;
use tauri::{Emitter, Manager};

pub struct AppState {
    pub sidecar: Mutex<SidecarManager>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let sidecar_manager = SidecarManager::new();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        // .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(AppState {
            sidecar: Mutex::new(sidecar_manager),
        })
        .setup(|app| {
            let handle = app.handle().clone();

            // Start sidecar via managed state
            let state = app.state::<AppState>();
            let mut sidecar = state.sidecar.lock().unwrap();
            sidecar.start(move |ready| {
                let _ = handle.emit("sidecar-ready", serde_json::json!({
                    "port": ready.port,
                }));
            });
            drop(sidecar);

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            window::set_window_title,
            window::get_platform,
            dialog::open_file_dialog,
            dialog::save_file_dialog,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Coderix desktop");
}
