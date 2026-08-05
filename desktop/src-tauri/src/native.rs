/* Where the bundled native engines live, on every platform.
 *
 * The app ships its own rendering engines (PDFium today; LibreOffice and others to follow) instead
 * of depending on what the user happens to have installed. This module is the ONLY place that knows
 * how to find them, because the answer differs three ways:
 *
 *   packaged      inside the app's resource dir — macOS `Contents/Resources/`, Windows next to the
 *                 exe, Linux `usr/lib/<app>/` — resolved via Tauri's own path API.
 *   `tauri dev`   the resource dir points into `target/debug`, where Tauri has NOT copied resources;
 *                 fall back to the source tree so `npm run tauri dev` works without a packaged build.
 *   tests         no AppHandle at all — see `resources_root_from`.
 *
 * A packaged app launched from Finder/Dock/Explorer inherits the OS's minimal PATH, so anything
 * resolved from PATH is invisible to it even when installed. That cost us a release: `cwebp` was
 * called as a bare command, worked in dev, and failed in the DMG with a misleading "not found".
 * Bundled engines are resolved by absolute path and never through PATH. `system_tool` exists only
 * for engines that are not bundled yet, and is a documented fallback, not the primary route.
 */

use std::path::{Path, PathBuf};

/// Subdirectory of the resource root that `scripts/fetch-native-deps.mjs` writes into.
const NATIVE_SUBDIR: &str = "resources/native";

/// Platform-conventional file name for a dynamic library, e.g. `pdfium` → `libpdfium.dylib`.
pub fn dylib_name(stem: &str) -> String {
    if cfg!(target_os = "windows") {
        format!("{stem}.dll")
    } else if cfg!(target_os = "macos") {
        format!("lib{stem}.dylib")
    } else {
        format!("lib{stem}.so")
    }
}

/// Platform-conventional executable name, e.g. `soffice` → `soffice.exe` on Windows.
pub fn exe_name(stem: &str) -> String {
    if cfg!(target_os = "windows") {
        format!("{stem}.exe")
    } else {
        stem.to_string()
    }
}

/// The directory holding `resources/native/<engine>/…`, given a candidate resource root.
///
/// Split out from `resources_root` so it can be unit-tested without an AppHandle: the branch that
/// actually matters (packaged layout vs source-tree fallback) is pure path logic.
pub fn native_dir_from(root: &Path, engine: &str) -> PathBuf {
    root.join(NATIVE_SUBDIR).join(engine)
}

/// Candidate resource roots, most-specific first.
///
/// In a packaged build the first entry is correct. Under `tauri dev` it exists but holds no
/// resources, so the CARGO_MANIFEST_DIR fallback (the `src-tauri` source dir) is what answers.
fn resource_roots(app: &tauri::AppHandle) -> Vec<PathBuf> {
    use tauri::Manager;
    let mut roots = Vec::new();
    if let Ok(dir) = app.path().resource_dir() {
        roots.push(dir);
    }
    roots.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")));
    roots
}

/// Absolute path to a bundled dynamic library's CONTAINING DIRECTORY.
///
/// Returns the directory rather than the file because that is what pdfium-render's
/// `bind_to_library`/`pdfium_platform_library_name_at_path` pair expects, and because an engine may
/// ship several sibling libraries that must resolve against each other.
pub fn library_dir(app: &tauri::AppHandle, engine: &str, lib_stem: &str) -> Result<PathBuf, String> {
    let file = dylib_name(lib_stem);
    let tried: Vec<PathBuf> = resource_roots(app)
        .iter()
        .map(|root| native_dir_from(root, engine))
        .collect();

    for dir in &tried {
        if dir.join(&file).is_file() {
            return Ok(dir.clone());
        }
    }
    Err(format!(
        "bundled engine '{engine}' is missing {file}. Run `npm run deps:native`. Looked in: {}",
        tried.iter().map(|p| p.display().to_string()).collect::<Vec<_>>().join(", ")
    ))
}

/// Absolute path to a bundled executable, if the engine ships one.
#[allow(dead_code)] // used once LibreOffice is bundled (phase 2)
pub fn tool_path(app: &tauri::AppHandle, engine: &str, rel: &str) -> Option<PathBuf> {
    resource_roots(app)
        .iter()
        .map(|root| native_dir_from(root, engine).join(rel))
        .find(|p| p.is_file())
}

/// Locate a NOT-YET-BUNDLED helper executable on the host.
///
/// PATH first (so a dev shell wins), then the well-known install prefixes a GUI app cannot see
/// because launchd/Explorer hand it a minimal PATH. Every engine here is scheduled for bundling;
/// until then this keeps the feature working for whoever has the tool installed.
pub fn system_tool(stem: &str) -> Option<PathBuf> {
    let file = exe_name(stem);

    let from_path = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect::<Vec<_>>())
        .unwrap_or_default();

    from_path
        .iter()
        .map(|dir| dir.join(&file))
        .chain(EXTRA_BIN_DIRS.iter().map(|dir| Path::new(dir).join(&file)))
        .find(|candidate| candidate.is_file())
}

/// Install prefixes outside the minimal PATH a packaged app inherits.
#[cfg(target_os = "macos")]
const EXTRA_BIN_DIRS: &[&str] = &[
    "/opt/homebrew/bin", // Homebrew, Apple silicon
    "/usr/local/bin",    // Homebrew, Intel — and manual installs
    "/opt/local/bin",    // MacPorts
];

#[cfg(target_os = "linux")]
const EXTRA_BIN_DIRS: &[&str] = &["/usr/bin", "/usr/local/bin", "/snap/bin"];

#[cfg(target_os = "windows")]
const EXTRA_BIN_DIRS: &[&str] = &[
    r"C:\Program Files\LibreOffice\program",
    r"C:\Program Files (x86)\LibreOffice\program",
];

/// Human-readable "you are missing X" message that names what was searched.
pub fn missing_tool(stem: &str, install_hint: &str) -> String {
    format!(
        "{stem} not found on PATH or in {} — install: {install_hint}",
        EXTRA_BIN_DIRS.join(", ")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dylib_and_exe_names_follow_the_platform() {
        let lib = dylib_name("pdfium");
        let exe = exe_name("soffice");
        if cfg!(target_os = "windows") {
            assert_eq!(lib, "pdfium.dll");
            assert_eq!(exe, "soffice.exe");
        } else if cfg!(target_os = "macos") {
            assert_eq!(lib, "libpdfium.dylib");
            assert_eq!(exe, "soffice");
        } else {
            assert_eq!(lib, "libpdfium.so");
            assert_eq!(exe, "soffice");
        }
    }

    #[test]
    fn native_dir_is_engine_scoped_under_the_resource_root() {
        let dir = native_dir_from(Path::new("/app/Contents/Resources"), "pdfium");
        assert!(dir.ends_with("resources/native/pdfium"), "got {}", dir.display());
    }

    /* The regression that motivated this module: a GUI app gets a minimal PATH, so a tool that IS
       installed under a Homebrew-style prefix must still be found. Uses a directory we create, so
       the test does not depend on what the host has installed. */
    #[test]
    fn system_tool_searches_path_entries() {
        let tmp = std::env::temp_dir().join(format!("sotto-native-test-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let stem = "sotto-fake-tool";
        let file = tmp.join(exe_name(stem));
        std::fs::write(&file, b"#!/bin/sh\n").unwrap();

        let prev = std::env::var_os("PATH");
        std::env::set_var("PATH", &tmp);
        let found = system_tool(stem);
        match prev {
            Some(p) => std::env::set_var("PATH", p),
            None => std::env::remove_var("PATH"),
        }
        std::fs::remove_dir_all(&tmp).ok();

        assert_eq!(found.as_deref(), Some(file.as_path()));
    }

    #[test]
    fn system_tool_returns_none_for_a_tool_that_is_not_there() {
        assert!(system_tool("sotto-definitely-not-installed-anywhere").is_none());
    }
}
