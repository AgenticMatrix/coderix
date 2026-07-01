mod commands;
mod sidecar;

use commands::{window, dialog};
use sidecar::manager::SidecarManager;
use std::sync::Mutex;
use tauri::Manager;

/// Application state shared between commands
pub struct AppState {
    pub sidecar: Mutex<SidecarManager>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let sidecar_manager = SidecarManager::new();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(AppState {
            sidecar: Mutex::new(sidecar_manager),
        })
        .setup(|app| {
            // Start the coderix backend sidecar
            let handle = app.handle().clone();
            let state = app.state::<AppState>();
            let mut sidecar = state.sidecar.lock().unwrap();

            let app_handle = handle.clone();
            sidecar.start(move |ready| {
                // Emit event to frontend when sidecar is ready
                let _ = app_handle.emit("sidecar-ready", serde_json::json!({
                    "port": ready.port,
                }));
            });

            // Set up window
            let window = app.get_webview_window("main").unwrap();

            // On close, kill sidecar
            let state_for_close = app.state::<AppState>();
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::Destroyed = event {
                    let mut sc = state_for_close.sidecar.lock().unwrap();
                    sc.stop();
                }
            });

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
