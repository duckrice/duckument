use std::{
    fs,
    path::{Path, PathBuf},
};

use percent_encoding::percent_decode_str;
use tauri::ipc::{InvokeBody, Request, Response};

/// The PDF the app was launched with ("Open with" or a double-click), if any.
#[tauri::command]
fn startup_file() -> Option<String> {
    std::env::args_os()
        .skip(1)
        .map(PathBuf::from)
        .find(|path| path.is_file())
        .and_then(|path| std::path::absolute(path).ok())
        .map(|path| path.to_string_lossy().into_owned())
}

#[tauri::command]
fn read_file(path: String) -> Result<Response, String> {
    fs::read(&path)
        .map(Response::new)
        .map_err(|err| format!("Could not read {path}: {err}"))
}

/// Reads a font from the Windows Fonts folder so it can be embedded in a saved
/// PDF. Only a bare file name is accepted; this is not a way to read other files.
#[tauri::command]
fn read_system_font(file: String) -> Result<Response, String> {
    if file.is_empty() || file.contains(['/', '\\', ':']) || file.contains("..") {
        return Err(format!("Not a font file name: {file}"));
    }
    let windows = std::env::var_os("WINDIR").unwrap_or_else(|| "C:\\Windows".into());
    fs::read(PathBuf::from(windows).join("Fonts").join(&file))
        .map(Response::new)
        .map_err(|err| format!("Could not read font {file}: {err}"))
}

/// Saves the request body to the path given in the `x-path` header (percent-encoded,
/// since header values must be ASCII). The bytes travel as a raw body so large
/// PDFs aren't serialised as JSON.
#[tauri::command]
fn write_file(request: Request<'_>) -> Result<(), String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("write_file expects a binary body".into());
    };
    let encoded = request
        .headers()
        .get("x-path")
        .and_then(|value| value.to_str().ok())
        .ok_or("write_file is missing the x-path header")?;
    let path = PathBuf::from(
        percent_decode_str(encoded)
            .decode_utf8()
            .map_err(|err| err.to_string())?
            .into_owned(),
    );
    write_atomically(&path, bytes).map_err(|err| format!("Could not save {}: {err}", path.display()))
}

/// Writes next to the target and renames over it, so a failed save can't leave
/// a half-written PDF behind.
fn write_atomically(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(format!(".{}.tmp", std::process::id()));
    let tmp = path.with_file_name(name);
    fs::write(&tmp, bytes)?;
    fs::rename(&tmp, path).inspect_err(|_| {
        let _ = fs::remove_file(&tmp);
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            startup_file,
            read_file,
            read_system_font,
            write_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
