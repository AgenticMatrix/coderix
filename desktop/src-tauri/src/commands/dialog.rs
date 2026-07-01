use tauri_plugin_dialog::DialogExt;

#[tauri::command]
pub async fn open_file_dialog(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let file = app
        .dialog()
        .file()
        .blocking_pick_file();
    Ok(file.map(|f| f.path.to_string_lossy().to_string()))
}

#[tauri::command]
pub async fn save_file_dialog(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let file = app
        .dialog()
        .file()
        .blocking_save_file();
    Ok(file.map(|f| f.path.to_string_lossy().to_string()))
}
