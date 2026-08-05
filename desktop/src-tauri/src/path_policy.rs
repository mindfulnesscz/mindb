//! Filesystem boundary for native commands.
//!
//! The webview may name paths, but it does not get to expand the native command surface. A path is
//! accepted only when it belongs to Tauri's filesystem scope: app-local data, a folder approved by
//! the user through the folder picker, or one of those approved folders restored from the app's
//! persisted machine-local configuration at startup.

use std::path::{Component, Path, PathBuf};

use serde_json::Value;
use tauri::Manager;
use tauri_plugin_fs::FsExt;

const CONFIG_FILES: &[&str] = &["client-local.json", "settings.json"];
const WORKING_DIR_FIELDS: &[&str] = &[
    "sourceFolder",
    "source_folder",
    "targetFolder",
    "target_folder",
    "vaultFolder",
    "vault_folder",
    "lastCreationFolder",
];

/// Restore folder-picker grants that must survive an app restart.
///
/// Tauri automatically adds newly selected folders to this scope. The persisted paths are read by
/// Rust, rather than accepted from an IPC argument, so a command caller cannot grant itself a new
/// directory merely by naming one.
pub fn restore_persisted_scope(app: &tauri::AppHandle) -> Result<(), String> {
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    allow_directory(app, &app_data)?;

    for name in CONFIG_FILES {
        let path = app_data.join(name);
        let Ok(bytes) = std::fs::read(&path) else {
            continue;
        };
        let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
            continue;
        };
        let mut dirs = Vec::new();
        collect_working_directories(&value, &mut dirs);
        for dir in dirs {
            if dir.is_dir() {
                allow_directory(app, &dir)?;
            }
        }
    }
    Ok(())
}

fn allow_directory(app: &tauri::AppHandle, path: &Path) -> Result<(), String> {
    let scope = app.fs_scope();
    scope
        .allow_directory(path, true)
        .map_err(|e| format!("allow working directory {}: {e}", path.display()))?;
    if let Ok(canonical) = path.canonicalize() {
        scope
            .allow_directory(&canonical, true)
            .map_err(|e| format!("allow working directory {}: {e}", canonical.display()))?;
    }
    Ok(())
}

fn collect_working_directories(value: &Value, out: &mut Vec<PathBuf>) {
    match value {
        Value::Object(map) => {
            for field in WORKING_DIR_FIELDS {
                if let Some(path) = map.get(*field).and_then(Value::as_str).filter(|p| !p.trim().is_empty()) {
                    out.push(PathBuf::from(path));
                }
            }
            if map.get("type").and_then(Value::as_str) == Some("local") {
                if let Some(path) = map.get("path").and_then(Value::as_str).filter(|p| !p.trim().is_empty()) {
                    out.push(PathBuf::from(path));
                }
            }
            for nested in map.values() {
                collect_working_directories(nested, out);
            }
        }
        Value::Array(values) => {
            for nested in values {
                collect_working_directories(nested, out);
            }
        }
        _ => {}
    }
}

pub fn require_allowed_file(
    app: &tauri::AppHandle,
    raw: impl AsRef<Path>,
    label: &str,
) -> Result<PathBuf, String> {
    let raw = raw.as_ref();
    let resolved = resolve_candidate(raw)?;
    if !resolved.is_file() {
        return Err(format!("{label} is not a file: {}", raw.display()));
    }
    require_in_scope(app, raw, &resolved, label)?;
    Ok(resolved)
}

pub fn require_allowed_directory(
    app: &tauri::AppHandle,
    raw: impl AsRef<Path>,
    label: &str,
) -> Result<PathBuf, String> {
    let raw = raw.as_ref();
    let resolved = resolve_candidate(raw)?;
    if !resolved.is_dir() {
        return Err(format!("{label} is not a directory: {}", raw.display()));
    }
    require_in_scope(app, raw, &resolved, label)?;
    Ok(resolved)
}

/// Validate a file or directory that may not exist yet, resolving every existing ancestor first.
/// This is what prevents an allowed lexical path from escaping through an intermediate symlink.
pub fn require_allowed_output(
    app: &tauri::AppHandle,
    raw: impl AsRef<Path>,
    label: &str,
) -> Result<PathBuf, String> {
    let raw = raw.as_ref();
    let resolved = resolve_candidate(raw)?;
    require_in_scope(app, raw, &resolved, label)?;
    Ok(resolved)
}

fn require_in_scope(
    app: &tauri::AppHandle,
    raw: &Path,
    resolved: &Path,
    label: &str,
) -> Result<(), String> {
    let scope = app.fs_scope();
    if scope_allows_both(raw, resolved, |path| scope.is_allowed(path)) {
        Ok(())
    } else {
        Err(format!(
            "Refusing {label} outside Sotto's approved working directories: {}",
            raw.display()
        ))
    }
}

fn scope_allows_both(
    raw: &Path,
    resolved: &Path,
    mut is_allowed: impl FnMut(&Path) -> bool,
) -> bool {
    is_allowed(raw) && is_allowed(resolved)
}

fn resolve_candidate(raw: &Path) -> Result<PathBuf, String> {
    if !raw.is_absolute() {
        return Err(format!("Path must be absolute: {}", raw.display()));
    }

    let mut normalized = PathBuf::new();
    for component in raw.components() {
        match component {
            Component::ParentDir => {
                return Err(format!("Parent traversal is not allowed: {}", raw.display()));
            }
            Component::CurDir => {}
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(component.as_os_str()),
            Component::Normal(part) => normalized.push(part),
        }
    }

    let mut cursor = normalized.as_path();
    let mut missing = Vec::new();
    while !cursor.exists() {
        let name = cursor
            .file_name()
            .ok_or_else(|| format!("Cannot resolve path: {}", raw.display()))?;
        missing.push(name.to_os_string());
        cursor = cursor
            .parent()
            .ok_or_else(|| format!("Cannot resolve path: {}", raw.display()))?;
    }

    let mut resolved = cursor
        .canonicalize()
        .map_err(|e| format!("Resolve {}: {e}", raw.display()))?;
    for part in missing.iter().rev() {
        resolved.push(part);
    }
    Ok(resolved)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn persisted_config_collects_only_working_directory_fields_and_local_destinations() {
        let value = serde_json::json!({
            "entries": {
                "client": {
                    "sourceFolder": "/work/source",
                    "cloudDestinations": [
                        { "config": { "type": "local", "path": "/work/delivery" } },
                        { "config": { "type": "dropbox", "path": "/not/a/local/path" } }
                    ]
                }
            },
            "unrelated": "/ignored"
        });
        let mut found = Vec::new();
        collect_working_directories(&value, &mut found);
        assert_eq!(found, vec![PathBuf::from("/work/source"), PathBuf::from("/work/delivery")]);
    }

    #[test]
    fn candidate_rejects_relative_and_parent_traversal() {
        assert!(resolve_candidate(Path::new("relative/file")).is_err());
        assert!(resolve_candidate(Path::new("/approved/../outside")).is_err());
    }

    #[test]
    fn scope_requires_both_the_requested_and_symlink_resolved_paths() {
        let approved = Path::new("/approved");
        let in_scope = |path: &Path| path.starts_with(approved);

        assert!(scope_allows_both(
            Path::new("/approved/source.pdf"),
            Path::new("/approved/source.pdf"),
            in_scope,
        ));
        assert!(!scope_allows_both(
            Path::new("/approved/escape/secret.pdf"),
            Path::new("/outside/secret.pdf"),
            in_scope,
        ));
    }

    #[cfg(unix)]
    #[test]
    fn candidate_resolves_an_intermediate_symlink_before_scope_checks() {
        use std::os::unix::fs::symlink;
        use std::time::{SystemTime, UNIX_EPOCH};

        let suffix = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let root = std::env::temp_dir().join(format!("sotto-path-policy-{}-{suffix}", std::process::id()));
        let approved = root.join("approved");
        let outside = root.join("outside");
        std::fs::create_dir_all(&approved).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        symlink(&outside, approved.join("escape")).unwrap();

        let resolved = resolve_candidate(&approved.join("escape/new.webp")).unwrap();
        assert_eq!(resolved, outside.canonicalize().unwrap().join("new.webp"));

        std::fs::remove_dir_all(&root).unwrap();
    }
}
