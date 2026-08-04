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
/// Engine directory name for the bundled LibreOffice.
const LIBREOFFICE_ENGINE: &str = "libreoffice";

/// Lanczos3 matches `cwebp -resize`'s quality class; nearest/triangle visibly softens text at
/// thumbnail sizes, which is most of what a deck thumbnail contains.
const RESIZE_FILTER: FilterType = FilterType::Lanczos3;

/// Above this source:target ratio, box-average most of the way down before the final filter.
///
/// Running Lanczos3 across a huge reduction is the single most expensive thing in the image path and
/// buys nothing: on a real 8000x4500 asset, direct Lanczos3 took 280ms versus 62ms for prescale +
/// Lanczos3, and the outputs were visually indistinguishable at 320px (14418 B vs 14082 B, against
/// `cwebp`'s 13900 B). Below the threshold the reduction is small enough that box averaging would
/// show, and Lanczos3 is cheap anyway.
const PRESCALE_RATIO: u32 = 4;

/* ── WebP encoding ──────────────────────────────────────────────────────── */

/// Resize to `width` (aspect preserved) and write a lossy WebP at `quality`.
///
/// Already-correct widths skip the resample entirely. PDFium rasterises straight to the target
/// width, so re-filtering its output would soften text for nothing — and text is most of what a
/// deck thumbnail contains.
fn write_webp(img: &image::DynamicImage, dest: &Path, width: u32, quality: u32) -> Result<(), String> {
    let scaled = downscale(img, width);
    let encoded = webp::Encoder::from_rgba(&scaled, scaled.width(), scaled.height())
        .encode(quality as f32);

    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    }
    std::fs::write(dest, &*encoded).map_err(|e| format!("write {}: {e}", dest.display()))
}

/// Scale to `width`, preserving aspect ratio.
///
/// `u32::MAX` as the height bound makes `resize` fit-to-width. Sources already at the target width
/// are passed through untouched — PDFium rasterises straight to the target, and re-filtering its
/// output would soften text for nothing. Never upscales: a source narrower than the target keeps its
/// own size rather than being blown up, matching `cwebp -resize <width> 0`.
fn downscale(img: &image::DynamicImage, width: u32) -> image::RgbaImage {
    if img.width() <= width {
        return img.to_rgba8();
    }
    if img.width() >= width.saturating_mul(PRESCALE_RATIO) {
        // Box-average down to 2x the target, then one good filter for the last hop.
        return img
            .thumbnail(width.saturating_mul(2), u32::MAX)
            .resize(width, u32::MAX, RESIZE_FILTER)
            .to_rgba8();
    }
    img.resize(width, u32::MAX, RESIZE_FILTER).to_rgba8()
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

/* ── Worker processes: the only way to render PDFs in parallel ───────────── */

/// Hidden argv flag that turns this executable into a one-shot render worker.
pub const WORKER_FLAG: &str = "--dchub-render-worker";

/// Render page 1 of a PDF to a WebP thumbnail, in a short-lived WORKER PROCESS.
///
/// PDFium cannot be used concurrently. Not "is slower when threaded" — it FAILS: with the crate's
/// `thread_safe` feature enabled and eight threads rendering eight DIFFERENT documents, all 160
/// renders returned `FormatError`; at four threads, 76 of 80 failed. Its state is process-global, so
/// the unit of isolation has to be a process.
///
/// This is not a regression in shape. The code this replaced spawned `pdftoppm` AND `cwebp` per
/// file, eight at a time — two processes and a PNG intermediate. One worker per file is cheaper, and
/// measured 86 pages/s at 8-way for single-page documents against ~35 pages/s for a correct
/// single-threaded in-process implementation.
///
/// Concurrency stays where it already is: the pipeline's own 8-at-a-time batching. Nothing here
/// spawns more than the one worker it needs.
pub fn pdf_to_thumb(
    app: &tauri::AppHandle,
    src: &str,
    dest: &str,
    width: u32,
    quality: u32,
) -> Result<(), String> {
    let lib_dir = pdfium_dir(app)?;
    let exe = std::env::current_exe().map_err(|e| format!("locate own executable: {e}"))?;

    let out = Command::new(&exe)
        .arg(WORKER_FLAG)
        .arg(&lib_dir)
        .arg(src)
        .arg(dest)
        .arg(width.to_string())
        .arg(quality.to_string())
        .output()
        .map_err(|e| format!("spawn render worker: {e}"))?;

    if out.status.success() {
        return Ok(());
    }
    // The worker prints a single diagnostic line; surface it rather than an exit code.
    let msg = String::from_utf8_lossy(&out.stderr).trim().to_string();
    Err(if msg.is_empty() {
        format!("render worker failed (exit {:?}) for {src}", out.status.code())
    } else {
        msg
    })
}

/// Worker entry point. Returns the process exit code; `run()` calls this before Tauri starts.
///
/// Kept deliberately dumb: arguments in, file out, one line of diagnostics on stderr. No IPC, no
/// serialisation format, nothing to keep in sync with the parent beyond this argument order.
pub fn worker_main(args: &[String]) -> i32 {
    // WORKER_FLAG, lib_dir, src, dest, width, quality
    if args.len() < 6 {
        eprintln!("render worker: expected 5 arguments, got {}", args.len().saturating_sub(1));
        return 2;
    }
    let (lib_dir, src, dest) = (Path::new(&args[1]), args[2].as_str(), args[3].as_str());
    let width = args[4].parse::<u32>().unwrap_or(320);
    let quality = args[5].parse::<u32>().unwrap_or(70);

    match pdf_to_thumb_in(lib_dir, src, dest, width, quality) {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("{e}");
            1
        }
    }
}

/// `pdf_to_thumb` without the process hop — what the worker itself runs.
///
/// Never call this from the app process for pipeline work: it is only safe when the caller can
/// guarantee no other PDFium use is in flight, which in practice means "inside a worker" or "inside
/// a single-threaded test".
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
    soffice_from(
        native::tool_path(app, LIBREOFFICE_ENGINE, &libreoffice_rel()),
        native::system_tool("soffice"),
        host_install(),
    )
}

/// Precedence: BUNDLED beats anything installed on the host.
///
/// Order is the whole point, so it lives in a function that can be tested without an AppHandle.
/// Bundled must win: the shipped copy is the version whose deck rendering was reviewed, and a
/// host install of some other version would silently change how client decks look. The host
/// fallbacks exist for `tauri dev` on a machine that has not run `npm run deps:native`, and for
/// Linux, where LibreOffice is a declared package dependency rather than a bundled engine.
fn soffice_from(
    bundled: Option<PathBuf>,
    on_path: Option<PathBuf>,
    host: Option<PathBuf>,
) -> Option<PathBuf> {
    bundled.or(on_path).or(host)
}

/// Well-known install location that the vendor's own installer does not add to `PATH`.
fn host_install() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    let candidate = Path::new("/Applications/LibreOffice.app/Contents/MacOS/soffice");
    #[cfg(target_os = "windows")]
    let candidate = Path::new(r"C:\Program Files\LibreOffice\program\soffice.exe");
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    let candidate = Path::new("/usr/lib/libreoffice/program/soffice");

    candidate.is_file().then(|| candidate.to_path_buf())
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

    fn solid(w: u32, h: u32) -> image::DynamicImage {
        image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(w, h, image::Rgba([10, 20, 30, 255])))
    }

    /* The scaling contract, which `cwebp -resize <width> 0` set and callers still rely on: fit to
       width, preserve aspect ratio, never upscale. */
    #[test]
    fn downscale_fits_width_and_preserves_aspect_ratio() {
        // Big ratio (16x) — takes the prescale path.
        let out = downscale(&solid(5120, 2880), 320);
        assert_eq!((out.width(), out.height()), (320, 180));

        // Small ratio (under PRESCALE_RATIO) — direct filter, same contract.
        let out = downscale(&solid(640, 480), 320);
        assert_eq!((out.width(), out.height()), (320, 240));
    }

    #[test]
    fn downscale_never_upscales_a_small_source() {
        let out = downscale(&solid(120, 90), 320);
        assert_eq!((out.width(), out.height()), (120, 90), "a narrow source must keep its own size");
    }

    #[test]
    fn downscale_passes_through_an_exact_width_match() {
        // PDFium rasterises to the target width; re-filtering would soften text for nothing.
        let out = downscale(&solid(320, 180), 320);
        assert_eq!((out.width(), out.height()), (320, 180));
    }


    /* Precedence is the load-bearing part of engine resolution: the BUNDLED LibreOffice is the
       version whose deck rendering was reviewed and accepted, so a different one installed on the
       host must never take priority. */
    #[test]
    fn bundled_libreoffice_wins_over_anything_on_the_host() {
        let bundled = PathBuf::from("/app/Resources/resources/native/libreoffice/soffice");
        let on_path = PathBuf::from("/opt/homebrew/bin/soffice");
        let host = PathBuf::from("/Applications/LibreOffice.app/Contents/MacOS/soffice");

        assert_eq!(
            soffice_from(Some(bundled.clone()), Some(on_path.clone()), Some(host.clone())),
            Some(bundled),
            "a bundled engine must beat both host locations",
        );
        assert_eq!(
            soffice_from(None, Some(on_path.clone()), Some(host.clone())),
            Some(on_path),
            "with no bundle, PATH comes before the vendor install dir",
        );
        assert_eq!(soffice_from(None, None, Some(host.clone())), Some(host));
        assert_eq!(soffice_from(None, None, None), None, "nothing found must be None, not a guess");
    }

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
        let _serial = PDFIUM_TEST_LOCK.lock().unwrap();
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

    /* There is deliberately NO test that renders concurrently in-process.
       One was written, and it segfaulted the whole test binary — which is precisely the finding:
       PDFium cannot be used concurrently in one process. With 8 threads on 8 DISTINCT documents,
       160/160 renders failed with FormatError (76/80 at 4 threads) before crashing. An earlier,
       weaker version of that test used ONE shared file from 8 threads and PASSED while the code was
       broken, which is why the shared-file variant must not be reintroduced as reassurance.

       The guarantee is structural instead: `pdf_to_thumb` spawns a worker process per render, and
       `worker_main` below is tested directly. Serialising these tests via PDFIUM_TEST_LOCK is what
       lets them share one process at all. */

    /* Every PDFium-touching test holds this. cargo runs tests on parallel threads by default, and
       two of them entering PDFium at once is the crash described above — a flaky, confusing failure
       that has nothing to do with what either test is checking. */
    static PDFIUM_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /* The actual guarantee: one render, one worker process. Pins the argument order the parent and
       `worker_main` have to agree on — the only coupling between them. */
    #[test]
    fn worker_main_renders_a_pdf_and_reports_failure_by_exit_code() {
        let _serial = PDFIUM_TEST_LOCK.lock().unwrap();
        let Some(lib_dir) = pdfium_lib_dir() else { return };
        let work = TempDir::new("dchub-worker").unwrap();
        let good = work.path().join("good.pdf");
        let bad = work.path().join("bad.pdf");
        std::fs::write(&good, minimal_pdf()).unwrap();
        std::fs::write(&bad, b"not a pdf at all").unwrap();

        let argv = |src: &Path, dest: &Path| {
            vec![
                WORKER_FLAG.to_string(),
                lib_dir.to_string_lossy().into_owned(),
                src.to_string_lossy().into_owned(),
                dest.to_string_lossy().into_owned(),
                "320".to_string(),
                "70".to_string(),
            ]
        };

        let out_good = work.path().join("good.webp");
        assert_eq!(worker_main(&argv(&good, &out_good)), 0, "valid PDF must exit 0");
        assert!(out_good.is_file(), "worker must have written the thumbnail");

        let out_bad = work.path().join("bad.webp");
        assert_eq!(worker_main(&argv(&bad, &out_bad)), 1, "invalid PDF must exit non-zero");
        assert!(!out_bad.exists(), "failed render must leave no file behind");

        assert_eq!(worker_main(&[WORKER_FLAG.to_string()]), 2, "missing arguments must exit 2");
    }

    /// A corrupt PDF must surface an error, never a zero-byte thumbnail the pipeline would cache.
    #[test]
    fn a_corrupt_pdf_errors_instead_of_writing_a_broken_thumbnail() {
        let _serial = PDFIUM_TEST_LOCK.lock().unwrap();
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
