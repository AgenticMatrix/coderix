use tauri::WebviewWindow;

#[tauri::command]
pub fn set_window_title(window: WebviewWindow, title: String) {
    let _ = window.set_title(&title);
}

#[tauri::command]
pub fn get_platform() -> String {
    std::env::consts::OS.to_string()
}
