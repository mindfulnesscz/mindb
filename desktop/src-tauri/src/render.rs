/* Thumbnail rendering — in-process, no external binaries.
 *
 * Replaces two shelled-out tools with libraries compiled into the app:
 *
 *   cwebp     → the `webp` crate (libwebp built from vendored C, statically linked)
 *   pdftoppm  → PDFium via `pdfium-render`, bound to the bundled dynamic library
 *
 * Both were invisible to a packaged app because it inherits the OS's minimal PATH; see `native`.
 * PDFium also replaces poppler for a second reason: it renders every page of a document, which
 * per-page previews need, and it was measured to preserve formatting poppler-rendered output kept
 * (text highlights on a real deck) at ~28ms/page.
 *
 * LibreOffice is still resolved from the host here — it is bundled in a later step. Its job is
 * narrow: convert an Office document to PDF, after which the PDFium path above does the rendering.
 *
 * WIDTH/HEIGHT CONTRACT. Callers pass a target width; height always follows the source aspect
 * ratio. This mirrors `cwebp -resize <width> 0` exactly, so thumbnails do not change size or
 * proportion as a result of this swap.
 */

use std::path::{Path, PathBuf};
use std::process::Command;

use image::imageops::FilterType;
use pdfium_render::prelude::*;

use crate::native;

/// Engine directory name under `resources/native/`, and the library stem inside it.
const PDFIUM_ENGINE: &str = "pdfium";
const PDFIUM_LIB_STEM: &str = "pdfium";

/// Lanczos3 matches `cwebp -resize`'s quality class; nearest/triangle visibly softens text at
/// thumbnail sizes, which is most of what a deck thumbnail contains.
const RESIZE_FILTER: FilterType = FilterType::Lanczos3;

/* ── WebP encoding ──────────────────────────────────────────────────────── */

/// Resize to `width` (aspect preserved) and write a lossy WebP at `quality`.
///
/// Already-correct widths skip the resample entirely. PDFium rasterises straight to the target
/// width, so re-filtering its output would soften text for nothing — and text is most of what a
/// deck thumbnail contains.
fn write_webp(img: &image::DynamicImage, dest: &Path, width: u32, quality: u32) -> Result<(), String> {
    // u32::MAX as the height bound makes `resize` fit-to-width, preserving aspect ratio.
    let scaled = if img.width() == width {
        img.to_rgba8()
    } else {
        img.resize(width, u32::MAX, RESIZE_FILTER).to_rgba8()
    };
    let encoded = webp::Encoder::from_rgba(&scaled, scaled.width(), scaled.height())
        .encode(quality as f32);

    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    }
    std::fs::write(dest, &*encoded).map_err(|e| format!("write {}: {e}", dest.display()))
}

/// Encode a raster image file (png/jpeg/gif/tiff/webp/…) to a WebP thumbnail.
pub fn image_to_thumb(src: &str, dest: &str, width: u32, quality: u32) -> Result<(), String> {
    let img = image::open(src).map_err(|e| format!("decode {src}: {e}"))?;
    write_webp(&img, Path::new(dest), width, quality)
}

/* ── PDF rasterisation ──────────────────────────────────────────────────── */

/// The one PDFium instance this process will ever have.
///
/// PDFium is NOT thread-safe and its init/teardown is process-GLOBAL (`FPDF_InitLibrary` /
/// `FPDF_DestroyLibrary`). Binding per call therefore destroys the library out from under any
/// concurrent user: with the pipeline's 8-way concurrency that is a segfault, and even serially the
/// second bind in a process fails. Both were observed before this existed — a parallel test run
/// crashed with SIGSEGV and a serial one failed on whichever render ran second.
///
/// So: bind once, keep it forever, and let the crate's `thread_safe` feature serialise calls. The
/// instance is never dropped, which is correct — teardown exists only for process exit.
static PDFIUM: std::sync::OnceLock<Result<Pdfium, String>> = std::sync::OnceLock::new();

/// Bind to (or reuse) the PDFium dynamic library in `lib_dir`.
///
/// Takes a directory rather than an `AppHandle` so the rendering path is reachable from tests
/// without a running Tauri app — the AppHandle-shaped wrappers below only resolve the directory.
///
/// `lib_dir` is honoured on the FIRST call only; later calls reuse the loaded library regardless of
/// the path passed. There is exactly one PDFium per install, so this is a non-issue in the app, and
/// tests all resolve the same directory.
fn pdfium_in(lib_dir: &Path) -> Result<&'static Pdfium, String> {
    PDFIUM
        .get_or_init(|| {
            Pdfium::bind_to_library(Pdfium::pdfium_platform_library_name_at_path(lib_dir))
                .map(Pdfium::new)
                .map_err(|e| format!("load PDFium from {}: {e}", lib_dir.display()))
        })
        .as_ref()
        .map_err(|e| e.clone())
}

/// Where this app's PDFium lives.
fn pdfium_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    native::library_dir(app, PDFIUM_ENGINE, PDFIUM_LIB_STEM)
}

/// Render page 1 of a PDF to a WebP thumbnail.
pub fn pdf_to_thumb(
    app: &tauri::AppHandle,
    src: &str,
    dest: &str,
    width: u32,
    quality: u32,
) -> Result<(), String> {
    pdf_to_thumb_in(&pdfium_dir(app)?, src, dest, width, quality)
}

/// `pdf_to_thumb` with the PDFium location supplied — the testable core.
fn pdf_to_thumb_in(
    lib_dir: &Path,
    src: &str,
    dest: &str,
    width: u32,
    quality: u32,
) -> Result<(), String> {
    let pdfium = pdfium_in(lib_dir)?;
    let doc = pdfium.load_pdf_from_file(src, None).map_err(|e| format!("open {src}: {e}"))?;
    let page = doc.pages().first().map_err(|e| format!("{src} has no first page: {e}"))?;

    // Render at the final width directly — PDFium rasterises at the requested size rather than
    // producing a full-resolution bitmap we would then downscale.
    let cfg = PdfRenderConfig::new().set_target_width(width as i32);
    let img = page
        .render_with_config(&cfg)
        .map_err(|e| format!("render {src} page 1: {e}"))?
        .as_image()
        .map_err(|e| format!("convert {src} page 1: {e}"))?;

    write_webp(&img, Path::new(dest), width, quality)
}

/* ── Office documents ───────────────────────────────────────────────────── */

/// Locate LibreOffice: bundled engine first, then the host.
///
/// The macOS app-bundle path is checked explicitly because a GUI app's PATH does not include
/// Homebrew's prefix and LibreOffice's own installer does not add itself to PATH at all.
fn soffice(app: &tauri::AppHandle) -> Option<PathBuf> {
    if let Some(bundled) = native::tool_path(app, "libreoffice", &libreoffice_rel()) {
        return Some(bundled);
    }
    if let Some(found) = native::system_tool("soffice") {
        return Some(found);
    }
    #[cfg(target_os = "macos")]
    {
        let app_bundle = Path::new("/Applications/LibreOffice.app/Contents/MacOS/soffice");
        if app_bundle.is_file() {
            return Some(app_bundle.to_path_buf());
        }
    }
    None
}

/// Path of the LibreOffice executable *within* its bundled engine directory.
fn libreoffice_rel() -> String {
    if cfg!(target_os = "macos") {
        "LibreOffice.app/Contents/MacOS/soffice".to_string()
    } else if cfg!(target_os = "windows") {
        r"program\soffice.exe".to_string()
    } else {
        "program/soffice".to_string()
    }
}

/// Convert an Office document to a PDF inside `work_dir`, returning the PDF's path.
///
/// `-env:UserInstallation` is NOT optional. LibreOffice keeps a single user profile and locks it, so
/// concurrent conversions sharing one profile either serialise or fail outright. The pipeline runs
/// eight of these at a time, so each conversion gets a private throwaway profile.
fn office_to_pdf(app: &tauri::AppHandle, src: &str, work_dir: &Path) -> Result<PathBuf, String> {
    let soffice = soffice(app).ok_or_else(|| {
        native::missing_tool("soffice", "LibreOffice (bundled in a later release)")
    })?;

    let profile = work_dir.join("profile");
    let out = Command::new(&soffice)
        .args([
            "--headless",
            "--norestore",
            &format!("-env:UserInstallation=file://{}", profile.display()),
            "--convert-to",
            "pdf",
            "--outdir",
            &work_dir.to_string_lossy(),
            src,
        ])
        .output()
        .map_err(|e| format!("launch {}: {e}", soffice.display()))?;

    // LibreOffice names the output after the input stem, in --outdir.
    let stem = Path::new(src)
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or_else(|| format!("unusable file name: {src}"))?;
    let pdf = work_dir.join(format!("{stem}.pdf"));

    if !pdf.is_file() {
        return Err(format!(
            "LibreOffice produced no PDF for {src} (exit {:?}): {}",
            out.status.code(),
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(pdf)
}

/// Render page 1 of an Office document (Word/PowerPoint/Excel) to a WebP thumbnail.
pub fn office_to_thumb(
    app: &tauri::AppHandle,
    src: &str,
    dest: &str,
    width: u32,
    quality: u32,
) -> Result<(), String> {
    let work = TempDir::new("dchub-office")?;
    let pdf = office_to_pdf(app, src, work.path())?;
    pdf_to_thumb(app, &pdf.to_string_lossy(), dest, width, quality)
}

/* ── Temp dir with cleanup on every exit path ───────────────────────────── */

/// A working directory removed on drop.
///
/// The previous code removed its temp dir at each `return` by hand and leaked it on the paths that
/// returned early. Tying removal to the value's lifetime makes that class of leak impossible —
/// which matters here because LibreOffice profiles are not small.
pub struct TempDir(PathBuf);

impl TempDir {
    fn new(prefix: &str) -> Result<Self, String> {
        // Process id + a per-call counter: two concurrent conversions in one process must not share
        // a directory, or one's cleanup would delete the other's input.
        use std::sync::atomic::{AtomicU64, Ordering};
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let n = SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("{prefix}-{}-{n}", std::process::id()));
        std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
        Ok(Self(dir))
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn temp_dirs_are_unique_and_removed_on_drop() {
        let (a, b) = (TempDir::new("dchub-test").unwrap(), TempDir::new("dchub-test").unwrap());
        assert_ne!(a.path(), b.path(), "concurrent conversions must not share a temp dir");
        let path = a.path().to_path_buf();
        assert!(path.is_dir());
        drop(a);
        assert!(!path.exists(), "temp dir must not outlive its guard");
    }

    /* A minimal one-page PDF, written by hand so the rendering tests need no binary fixture and no
       network. 200x100pt page with a filled black rectangle, which is enough to prove PDFium
       rasterised real content rather than handing back a blank buffer. */
    fn minimal_pdf() -> Vec<u8> {
        let objects: [&str; 4] = [
            "<< /Type /Catalog /Pages 2 0 R >>",
            "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R >>",
            "<< /Length 44 >>\nstream\n0 0 0 rg 20 20 160 60 re f\nendstream",
        ];
        let mut pdf = String::from("%PDF-1.4\n");
        let mut offsets = Vec::new();
        for (i, body) in objects.iter().enumerate() {
            offsets.push(pdf.len());
            pdf.push_str(&format!("{} 0 obj\n{body}\nendobj\n", i + 1));
        }
        let xref_at = pdf.len();
        pdf.push_str(&format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1));
        for off in &offsets {
            pdf.push_str(&format!("{off:010} 00000 n \n"));
        }
        pdf.push_str(&format!(
            "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref_at}\n%%EOF\n",
            objects.len() + 1
        ));
        pdf.into_bytes()
    }

    /// The bundled PDFium, or None when `npm run deps:native` has not been run.
    fn pdfium_lib_dir() -> Option<PathBuf> {
        let dir = native::native_dir_from(Path::new(env!("CARGO_MANIFEST_DIR")), PDFIUM_ENGINE);
        dir.join(native::dylib_name(PDFIUM_LIB_STEM)).is_file().then_some(dir)
    }

    /* The whole point of the swap: a PDF page becomes a WebP thumbnail with no external binary.
       Skips (rather than fails) when the engine is absent, so a fresh clone without
       `npm run deps:native` still has a green test run. CI runs the fetch, so CI does execute it. */
    #[test]
    fn renders_a_pdf_page_to_a_webp_at_the_requested_width() {
        let Some(lib_dir) = pdfium_lib_dir() else {
            eprintln!("skipping: no bundled PDFium — run `npm run deps:native`");
            return;
        };
        let work = TempDir::new("dchub-render-test").unwrap();
        let src = work.path().join("in.pdf");
        let dest = work.path().join("out.webp");
        std::fs::write(&src, minimal_pdf()).unwrap();

        pdf_to_thumb_in(&lib_dir, &src.to_string_lossy(), &dest.to_string_lossy(), 320, 70)
            .expect("render should succeed");

        let bytes = std::fs::read(&dest).unwrap();
        assert!(bytes.len() > 32, "thumbnail is suspiciously small: {} bytes", bytes.len());
        assert_eq!(&bytes[0..4], b"RIFF", "not a WebP container");
        assert_eq!(&bytes[8..12], b"WEBP", "not a WebP container");

        // Aspect ratio must follow the source (200x100 → 320x160), matching `cwebp -resize W 0`.
        let decoded = image::load_from_memory(&bytes).expect("decoded");
        assert_eq!((decoded.width(), decoded.height()), (320, 160));
    }

    /* Regression guard for the crash this module's PDFIUM singleton exists to prevent.
       The pipeline renders 8 thumbnails concurrently; binding PDFium per call segfaulted under
       exactly that load. Eight threads is the real concurrency, not an arbitrary number. */
    #[test]
    fn concurrent_renders_do_not_crash_or_corrupt_each_other() {
        let Some(lib_dir) = pdfium_lib_dir() else { return };
        let work = TempDir::new("dchub-render-concurrent").unwrap();
        let src = work.path().join("in.pdf");
        std::fs::write(&src, minimal_pdf()).unwrap();
        let src = src.to_string_lossy().into_owned();

        let handles: Vec<_> = (0..8)
            .map(|i| {
                let (lib_dir, src) = (lib_dir.clone(), src.clone());
                let dest = work.path().join(format!("out-{i}.webp"));
                std::thread::spawn(move || {
                    pdf_to_thumb_in(&lib_dir, &src, &dest.to_string_lossy(), 320, 70)
                        .map(|_| std::fs::read(&dest).unwrap())
                })
            })
            .collect();

        let outputs: Vec<Vec<u8>> = handles
            .into_iter()
            .map(|h| h.join().expect("thread must not panic").expect("render must succeed"))
            .collect();

        // Identical input under concurrency must give identical output — proves no cross-talk
        // between threads sharing the one PDFium instance.
        assert!(
            outputs.windows(2).all(|w| w[0] == w[1]),
            "concurrent renders of one input produced differing bytes"
        );
    }

    /// A corrupt PDF must surface an error, never a zero-byte thumbnail the pipeline would cache.
    #[test]
    fn a_corrupt_pdf_errors_instead_of_writing_a_broken_thumbnail() {
        let Some(lib_dir) = pdfium_lib_dir() else { return };
        let work = TempDir::new("dchub-render-bad").unwrap();
        let src = work.path().join("bad.pdf");
        let dest = work.path().join("bad.webp");
        std::fs::write(&src, b"%PDF-1.4\nthis is not a pdf").unwrap();

        let result = pdf_to_thumb_in(&lib_dir, &src.to_string_lossy(), &dest.to_string_lossy(), 320, 70);
        assert!(result.is_err(), "corrupt input must error");
        assert!(!dest.exists(), "no thumbnail should be left behind");
    }

    #[test]
    fn libreoffice_relative_path_matches_the_platform_layout() {
        let rel = libreoffice_rel();
        if cfg!(target_os = "macos") {
            assert!(rel.ends_with("MacOS/soffice"));
        } else if cfg!(target_os = "windows") {
            assert!(rel.ends_with("soffice.exe"));
        } else {
            assert!(rel.ends_with("program/soffice"));
        }
    }
}
