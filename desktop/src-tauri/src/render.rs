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

/// Decode budget for one image, raised from the `image` crate's 512 MiB default.
///
/// A real asset needed more: `falling-up@600x.tif`, 9922x14104 RGB, failed with "Memory limit
/// exceeded" — 512 MiB is not even enough for its final RGBA buffer (534 MiB), and TIFF decoding
/// allocates beyond that for strips. Measured against that file: 1024 MiB still failed, 1536 MiB
/// succeeded in ~100ms. 2 GiB is that floor plus headroom, and covers roughly a 500-megapixel RGBA
/// image.
///
/// Deliberately NOT unlimited. A limit is what turns a pathological file into one reported asset
/// instead of a killed application, and the ceiling has to stay a number someone can reason about.
const MAX_DECODE_ALLOC: u64 = 2 * 1024 * 1024 * 1024;

/* Compile-time guards, so lowering the budget fails the build rather than a test. Clippy rejects a
   runtime `assert!` on constants, and it is right to — this is the form that actually checks. */
const _: () = assert!(
    MAX_DECODE_ALLOC > 512 * 1024 * 1024,
    "must exceed the image crate's 512 MiB default, which failed on a real asset",
);
const _: () = assert!(
    MAX_DECODE_ALLOC >= 1536 * 1024 * 1024,
    "must clear the measured floor for a 9922x14104 TIFF (1024 MiB failed, 1536 succeeded)",
);
const _: () = assert!(
    MAX_DECODE_ALLOC <= 4 * 1024 * 1024 * 1024,
    "eight concurrent decodes make this a peak, not a per-file allowance — keep it bounded",
);

/// Above this on-disk size, a decode takes the single-file gate below.
///
/// A cheap proxy for "this one might be huge": compressed size does not tell you pixel count, but it
/// separates a 431 MiB TIFF from a 50 KB icon well enough, and a stat is free next to a decode.
const LARGE_FILE_BYTES: u64 = 32 * 1024 * 1024;

/// Serialises decodes of LARGE images so peak memory stays predictable.
///
/// This is the half that a raised limit alone gets wrong. The pipeline runs eight thumbnails
/// concurrently in ONE process, so a 2 GiB per-image budget is really a 16 GiB peak — enough to kill
/// the app on a 16 GB machine, and the failure would look like a crash rather than a memory limit.
/// Big files are rare, so letting one at a time through costs almost nothing in throughput and caps
/// the peak at roughly one budget plus seven small decodes.
static LARGE_DECODE_GATE: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Whether a file of this on-disk size decodes under the single-file gate.
fn needs_large_gate(len: u64) -> bool {
    len >= LARGE_FILE_BYTES
}

/// Encode a raster image file (png/jpeg/gif/tiff/webp/…) to a WebP thumbnail.
pub fn image_to_thumb(src: &str, dest: &str, width: u32, quality: u32) -> Result<(), String> {
    let big = std::fs::metadata(src).map(|m| needs_large_gate(m.len())).unwrap_or(false);
    // Held for the whole decode; dropped before the (small) resize and encode.
    let _gate = if big {
        // Poison-tolerant: a previous panic must not wedge every later thumbnail.
        Some(LARGE_DECODE_GATE.lock().unwrap_or_else(|e| e.into_inner()))
    } else {
        None
    };

    let mut reader = image::ImageReader::open(src).map_err(|e| format!("open {src}: {e}"))?;
    let mut limits = image::Limits::default();
    limits.max_alloc = Some(MAX_DECODE_ALLOC);
    reader.limits(limits);

    let img = reader
        .with_guessed_format()
        .map_err(|e| format!("read {src}: {e}"))?
        .decode()
        .map_err(|e| format!("decode {src}: {e}"))?;
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
pub const WORKER_FLAG: &str = "--sotto-render-worker";

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
/// One unit of rendering work, handed to a worker process as a single JSON argv item.
///
/// JSON rather than positional arguments because the job grew past what positions carry readably,
/// and because the next engine (3D) will add fields. Adding an `Option` field here is backwards
/// compatible; adding a seventh positional argument was not.
#[derive(serde::Serialize, serde::Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RenderJob {
    /// Directory holding the PDFium dynamic library.
    pub lib_dir: String,
    /// The PDF to render. Office documents are converted to one of these first.
    pub src: String,
    /// Where page 1 goes — the thumbnail the pipeline and R2 already know about.
    pub thumb: String,
    /// Where per-page previews go, or None for thumbnail-only work.
    pub pages_dir: Option<String>,
    pub width: u32,
    pub quality: u32,
    /// Maximum pages to render. Ignored when `pages_dir` is None.
    pub limit: u32,
}

/// What a worker reports back on stdout.
#[derive(serde::Serialize, serde::Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct RenderOutcome {
    /// Pages the document actually has — may exceed `rendered`, which is what the portal needs in
    /// order to say "download the asset to see the rest".
    pub total: u32,
    /// Pages written to `pages_dir`.
    pub rendered: u32,
}

/// Render a PDF in a short-lived WORKER PROCESS: page 1 to `thumb`, and optionally N pages.
///
/// PDFium cannot be used concurrently. Not "is slower when threaded" — it FAILS: with the crate's
/// `thread_safe` feature enabled and eight threads rendering eight DIFFERENT documents, all 160
/// renders returned `FormatError`; at four threads, 76 of 80 failed. Its state is process-global, so
/// the unit of isolation has to be a process.
///
/// ONE WORKER PER DOCUMENT, not per page. Spawn plus PDFium init is ~12ms, which would double the
/// cost of a 28ms page; amortised across a document's pages it disappears. Measured at 8-way:
/// 86 pages/s for single-page documents, 233 pages/s for multi-page ones.
///
/// Concurrency stays where it already is — the pipeline's 8-at-a-time batching.
fn run_worker(job: &RenderJob) -> Result<RenderOutcome, String> {
    let exe = std::env::current_exe().map_err(|e| format!("locate own executable: {e}"))?;
    let payload = serde_json::to_string(job).map_err(|e| format!("encode render job: {e}"))?;

    let out = Command::new(&exe)
        .arg(WORKER_FLAG)
        .arg(&payload)
        .output()
        .map_err(|e| format!("spawn render worker: {e}"))?;

    if !out.status.success() {
        // The worker prints one diagnostic line; surface it rather than an exit code.
        let msg = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if msg.is_empty() {
            format!("render worker failed (exit {:?}) for {}", out.status.code(), job.src)
        } else {
            msg
        });
    }
    serde_json::from_slice(&out.stdout)
        .map_err(|e| format!("render worker returned unreadable output for {}: {e}", job.src))
}

/// Render page 1 of a PDF to a WebP thumbnail.
pub fn pdf_to_thumb(
    app: &tauri::AppHandle,
    src: &str,
    dest: &str,
    width: u32,
    quality: u32,
) -> Result<(), String> {
    run_worker(&RenderJob {
        lib_dir: pdfium_dir(app)?.to_string_lossy().into_owned(),
        src: src.to_string(),
        thumb: dest.to_string(),
        pages_dir: None,
        width,
        quality,
        limit: 0,
    })
    .map(|_| ())
}

/// Worker entry point. Returns the process exit code; `run()` calls this before Tauri starts.
///
/// Deliberately dumb: one JSON job in, files out, one JSON outcome on stdout and one diagnostic line
/// on stderr. The job struct is the entire contract with the parent.
pub fn worker_main(args: &[String]) -> i32 {
    let Some(payload) = args.get(1) else {
        eprintln!("render worker: missing job payload");
        return 2;
    };
    let job: RenderJob = match serde_json::from_str(payload) {
        Ok(j) => j,
        Err(e) => {
            eprintln!("render worker: unreadable job: {e}");
            return 2;
        }
    };

    match render_pdf(&job) {
        Ok(outcome) => {
            match serde_json::to_string(&outcome) {
                Ok(s) => println!("{s}"),
                Err(e) => {
                    eprintln!("render worker: could not encode outcome: {e}");
                    return 1;
                }
            }
            0
        }
        Err(e) => {
            eprintln!("{e}");
            1
        }
    }
}

/// Execute a job without the process hop — what the worker itself runs.
///
/// Never call this from the app process for pipeline work: it is only safe when the caller can
/// guarantee no other PDFium use is in flight, which in practice means "inside a worker" or "inside
/// a single-threaded test".
///
/// Page 1 is rendered ONCE and written to `thumb`; when `pages_dir` is set the same bitmap is reused
/// as `001.webp` rather than rasterised again.
fn render_pdf(job: &RenderJob) -> Result<RenderOutcome, String> {
    let pdfium = pdfium_in(Path::new(&job.lib_dir))?;
    let doc = pdfium
        .load_pdf_from_file(&job.src, None)
        .map_err(|e| format!("open {}: {e}", job.src))?;

    let total = doc.pages().len() as u32;
    if total == 0 {
        return Err(format!("{} has no pages", job.src));
    }

    // Render straight to the target width — PDFium rasterises at the requested size rather than
    // producing a full-resolution bitmap we would then downscale.
    let cfg = PdfRenderConfig::new().set_target_width(job.width as i32);
    let render_one = |index: u32| -> Result<image::DynamicImage, String> {
        doc.pages()
            .get(index as i32)
            .map_err(|e| format!("{} page {}: {e}", job.src, index + 1))?
            .render_with_config(&cfg)
            .map_err(|e| format!("render {} page {}: {e}", job.src, index + 1))?
            .as_image()
            .map_err(|e| format!("convert {} page {}: {e}", job.src, index + 1))
    };

    let first = render_one(0)?;
    write_webp(&first, Path::new(&job.thumb), job.width, job.quality)?;

    let Some(pages_dir) = job.pages_dir.as_deref() else {
        return Ok(RenderOutcome { total, rendered: 0 });
    };

    let dir = Path::new(pages_dir);
    /* Clear the directory first. A shrinking page count (an edited deck, or a lowered limit) would
       otherwise leave orphaned pages behind, and those get uploaded and shown — the portal trusts
       the manifest's count, so stale files past it are invisible here and visible there. */
    if dir.exists() {
        std::fs::remove_dir_all(dir).map_err(|e| format!("clear {}: {e}", dir.display()))?;
    }
    std::fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;

    let wanted = total.min(job.limit);
    if wanted == 0 {
        // Nothing to render. Page 1 must NOT be written here: `rendered` is what the manifest
        // promises and what the portal reads, so a file past that count is an orphan by definition.
        return Ok(RenderOutcome { total, rendered: 0 });
    }
    // Page 1 is already rasterised for the thumbnail — reuse the bitmap rather than render twice.
    write_webp(&first, &page_path(dir, 1), job.width, job.quality)?;
    for index in 1..wanted {
        let img = render_one(index)?;
        write_webp(&img, &page_path(dir, index + 1), job.width, job.quality)?;
    }

    Ok(RenderOutcome { total, rendered: wanted })
}

/// `001.webp`, `002.webp`, … — zero-padded so lexical order is page order everywhere (shell, R2
/// listings, the portal). `page` is 1-based.
fn page_path(dir: &Path, page: u32) -> PathBuf {
    dir.join(format!("{page:03}.webp"))
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
    office_previews(app, src, dest, None, width, quality, 0).map(|_| ())
}

/// Thumbnail **and** per-page previews for an Office document, from ONE conversion.
///
/// The conversion is the expensive half — ~6.4s per deck against ~28ms per rasterised page — so
/// doing it once for the thumbnail and again for the pages would roughly double the cost of every
/// document in the library. The temporary PDF is shared and dropped with `work`.
pub fn office_previews(
    app: &tauri::AppHandle,
    src: &str,
    thumb: &str,
    pages_dir: Option<&str>,
    width: u32,
    quality: u32,
    limit: u32,
) -> Result<RenderOutcome, String> {
    let work = TempDir::new("sotto-office")?;
    let pdf = office_to_pdf(app, src, work.path())?;
    run_worker(&RenderJob {
        lib_dir: pdfium_dir(app)?.to_string_lossy().into_owned(),
        src: pdf.to_string_lossy().into_owned(),
        thumb: thumb.to_string(),
        pages_dir: pages_dir.map(str::to_string),
        width,
        quality,
        limit,
    })
}

/// Thumbnail **and** per-page previews for a PDF.
pub fn pdf_previews(
    app: &tauri::AppHandle,
    src: &str,
    thumb: &str,
    pages_dir: Option<&str>,
    width: u32,
    quality: u32,
    limit: u32,
) -> Result<RenderOutcome, String> {
    run_worker(&RenderJob {
        lib_dir: pdfium_dir(app)?.to_string_lossy().into_owned(),
        src: src.to_string(),
        thumb: thumb.to_string(),
        pages_dir: pages_dir.map(str::to_string),
        width,
        quality,
        limit,
    })
}

/// How many pages a document type is worth previewing.
///
/// Spreadsheets are capped at 1 deliberately. A print-to-PDF of one wide sheet can paginate into
/// dozens of near-empty slices, so a 50-page allowance would spend real time producing 50 useless
/// images and then show them to a client. Presentations and text documents paginate meaningfully.
pub fn page_budget(ext: &str, limit: u32) -> u32 {
    match ext {
        "xlsx" | "xlsm" | "xls" => 1,
        _ => limit,
    }
}

/* ── The pages manifest ─────────────────────────────────────────────────── */

/// `pages.json`, written beside the rendered pages.
///
/// Existence alone cannot decide whether previews are current, which is how the plain `-thumb.webp`
/// check works. Three things invalidate them and none are visible from a directory listing: the
/// source document changed, an administrator changed the page limit, or the configured width/quality
/// changed. So the inputs are recorded and compared.
///
/// The source is fingerprinted by **mtime + size, not a content hash**. Hashing would mean reading
/// every document in the library on every run — these reach 20MB+ — for a check that exists to make
/// re-runs cheap. This matches how `r2Cache` already decides whether an upload can be skipped.
#[derive(serde::Serialize, serde::Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PagesManifest {
    /// Bumped when the fields or the page-naming scheme change, so old manifests re-render.
    pub version: u32,
    pub src_mtime_ms: i64,
    pub src_size: u64,
    /// Pages the document has, which may exceed `rendered`.
    pub total: u32,
    pub rendered: u32,
    pub limit: u32,
    pub width: u32,
    pub quality: u32,
}

/// Current manifest format. Bump to force regeneration across the library.
pub const PAGES_MANIFEST_VERSION: u32 = 1;

pub fn manifest_path(pages_dir: &Path) -> PathBuf {
    pages_dir.join("pages.json")
}

/// mtime (ms since epoch) and size of a file — the cheap fingerprint.
pub(crate) fn fingerprint(src: &Path) -> Result<(i64, u64), String> {
    let meta = std::fs::metadata(src).map_err(|e| format!("stat {}: {e}", src.display()))?;
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(-1);
    Ok((mtime_ms, meta.len()))
}

/* ── Single-thumbnail manifest ───────────────────────────────────────────── */

/// Source fingerprint and output settings for a plain `<stem>-thumb.webp`.
///
/// Existence used to be the entire cache key, so replacing/restoring a source file never refreshed
/// its thumbnail. This mirrors the document-preview manifest's size+mtime decision while keeping
/// the generated sidecar beside the thumbnail (and therefore covered by every `-thumb` exclusion).
#[derive(serde::Serialize, serde::Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ThumbnailManifest {
    pub version: u32,
    pub src_mtime_ms: i64,
    pub src_size: u64,
    pub width: u32,
    pub quality: u32,
}

pub const THUMBNAIL_MANIFEST_VERSION: u32 = 1;

pub fn thumbnail_manifest_path(dest: &Path) -> PathBuf {
    PathBuf::from(format!("{}.json", dest.display()))
}

pub fn thumbnail_current(
    src: &Path,
    dest: &Path,
    width: u32,
    quality: u32,
) -> bool {
    if !dest.is_file() { return false; }
    let manifest: ThumbnailManifest = match std::fs::read(thumbnail_manifest_path(dest))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
    {
        Some(manifest) => manifest,
        None => return false,
    };
    let (src_mtime_ms, src_size) = match fingerprint(src) {
        Ok(value) => value,
        Err(_) => return false,
    };
    manifest == ThumbnailManifest {
        version: THUMBNAIL_MANIFEST_VERSION,
        src_mtime_ms,
        src_size,
        width,
        quality,
    }
}

pub fn write_thumbnail_manifest(
    src: &Path,
    dest: &Path,
    width: u32,
    quality: u32,
) -> Result<(), String> {
    let (src_mtime_ms, src_size) = fingerprint(src)?;
    let manifest = ThumbnailManifest {
        version: THUMBNAIL_MANIFEST_VERSION,
        src_mtime_ms,
        src_size,
        width,
        quality,
    };
    let bytes = serde_json::to_vec_pretty(&manifest).map_err(|e| e.to_string())?;
    std::fs::write(thumbnail_manifest_path(dest), bytes)
        .map_err(|e| format!("write thumbnail manifest for {}: {e}", dest.display()))
}

/// Are the previews in `pages_dir` still valid for `src` under these settings?
///
/// Returns the existing manifest when everything matches, so the caller can report the page count
/// without re-rendering. Any mismatch — or an unreadable manifest — means regenerate.
pub fn previews_current(
    src: &Path,
    pages_dir: &Path,
    limit: u32,
    width: u32,
    quality: u32,
) -> Option<PagesManifest> {
    let manifest: PagesManifest =
        serde_json::from_slice(&std::fs::read(manifest_path(pages_dir)).ok()?).ok()?;
    let (mtime_ms, size) = fingerprint(src).ok()?;

    let matches = manifest.version == PAGES_MANIFEST_VERSION
        && manifest.src_mtime_ms == mtime_ms
        && manifest.src_size == size
        && manifest.limit == limit
        && manifest.width == width
        && manifest.quality == quality;

    // A manifest claiming pages that are not on disk is stale, whatever it says about its inputs.
    let complete = (1..=manifest.rendered).all(|p| page_path(pages_dir, p).is_file());

    (matches && complete).then_some(manifest)
}

/// Write `pages.json` last, once every page is on disk.
///
/// Ordering matters: the manifest is what marks the set complete, so writing it before the pages
/// would let an interrupted run leave a directory that passes `previews_current` while missing files.
pub fn write_manifest(
    src: &Path,
    pages_dir: &Path,
    outcome: &RenderOutcome,
    limit: u32,
    width: u32,
    quality: u32,
) -> Result<PagesManifest, String> {
    let (src_mtime_ms, src_size) = fingerprint(src)?;
    let manifest = PagesManifest {
        version: PAGES_MANIFEST_VERSION,
        src_mtime_ms,
        src_size,
        total: outcome.total,
        rendered: outcome.rendered,
        limit,
        width,
        quality,
    };
    let json = serde_json::to_string_pretty(&manifest)
        .map_err(|e| format!("encode pages manifest: {e}"))?;
    std::fs::write(manifest_path(pages_dir), json + "\n")
        .map_err(|e| format!("write {}: {e}", manifest_path(pages_dir).display()))?;
    Ok(manifest)
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
    /* The gate is what keeps a raised budget from becoming an 8x peak. Classification only — holding
       the mutex is exercised by every large decode in a real run. */
    #[test]
    fn only_large_files_take_the_serialising_gate() {
        assert!(!needs_large_gate(0));
        assert!(!needs_large_gate(50 * 1024));            // an icon
        assert!(!needs_large_gate(LARGE_FILE_BYTES - 1));
        assert!(needs_large_gate(LARGE_FILE_BYTES));
        assert!(needs_large_gate(431 * 1024 * 1024));     // the TIFF that started this
    }

    /* Opt-in check against a real oversized image, since generating one big enough to exceed the old
       512 MiB default would mean allocating over a gigabyte inside the test suite.
           SOTTO_TEST_LARGE_IMAGE=/path/to/huge.tif cargo test -p sotto-app large_image */
    #[test]
    fn large_image_decodes_under_the_raised_budget() {
        let Ok(src) = std::env::var("SOTTO_TEST_LARGE_IMAGE") else {
            eprintln!("skipping: set SOTTO_TEST_LARGE_IMAGE to a large raster to run this");
            return;
        };
        let work = TempDir::new("sotto-large-image").unwrap();
        let dest = work.path().join("out.webp");
        image_to_thumb(&src, &dest.to_string_lossy(), 320, 70)
            .unwrap_or_else(|e| panic!("large image should decode: {e}"));
        let bytes = std::fs::read(&dest).unwrap();
        assert_eq!(&bytes[0..4], b"RIFF");
        let decoded = image::load_from_memory(&bytes).unwrap();
        assert_eq!(decoded.width(), 320);
    }

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

    #[test]
    fn thumbnail_cache_tracks_source_fingerprint_and_render_settings() {
        let work = TempDir::new("sotto-thumbnail-manifest").unwrap();
        let src = work.path().join("asset.png");
        let dest = work.path().join("asset-thumb.webp");
        std::fs::write(&src, b"source bytes").unwrap();
        std::fs::write(&dest, b"thumbnail bytes").unwrap();
        write_thumbnail_manifest(&src, &dest, 320, 70).unwrap();

        assert!(thumbnail_current(&src, &dest, 320, 70));
        assert!(!thumbnail_current(&src, &dest, 640, 70));

        std::fs::write(&src, b"restored source with changed bytes").unwrap();
        assert!(!thumbnail_current(&src, &dest, 320, 70));
    }


    /* Precedence is the load-bearing part of engine resolution: the BUNDLED LibreOffice is the
       version whose deck rendering was reviewed and accepted, so a different one installed on the
       host must never take priority. */
    /* The manifest is what makes re-runs cheap AND what makes a limit change take effect. Existence
       checking alone cannot see either, which is why `pages.json` exists at all. */
    #[test]
    fn previews_are_current_only_while_every_input_matches() {
        let work = TempDir::new("sotto-manifest").unwrap();
        let src = work.path().join("doc.pdf");
        let pages = work.path().join("doc-thumb");
        std::fs::write(&src, b"pretend document").unwrap();
        std::fs::create_dir_all(&pages).unwrap();
        std::fs::write(pages.join("001.webp"), b"page").unwrap();

        let outcome = RenderOutcome { total: 3, rendered: 1 };
        write_manifest(&src, &pages, &outcome, 50, 320, 70).unwrap();

        assert!(
            previews_current(&src, &pages, 50, 320, 70).is_some(),
            "unchanged inputs must be treated as current",
        );
        // An administrator raising the per-client limit has to force a re-render.
        assert!(previews_current(&src, &pages, 20, 320, 70).is_none(), "a limit change must invalidate");
        assert!(previews_current(&src, &pages, 50, 640, 70).is_none(), "a width change must invalidate");
        assert!(previews_current(&src, &pages, 50, 320, 90).is_none(), "a quality change must invalidate");

        // An edited document changes size, so the fingerprint stops matching.
        std::fs::write(&src, b"pretend document, now edited and longer").unwrap();
        assert!(previews_current(&src, &pages, 50, 320, 70).is_none(), "an edited source must invalidate");
    }

    /* A manifest that claims more pages than exist is stale regardless of its inputs — an
       interrupted run must not look complete. This is why the manifest is written last. */
    #[test]
    fn a_manifest_promising_missing_pages_is_not_current() {
        let work = TempDir::new("sotto-manifest-gap").unwrap();
        let src = work.path().join("doc.pdf");
        let pages = work.path().join("doc-thumb");
        std::fs::write(&src, b"doc").unwrap();
        std::fs::create_dir_all(&pages).unwrap();
        std::fs::write(pages.join("001.webp"), b"page").unwrap();

        // Claims 3 rendered pages; only 001 is on disk.
        write_manifest(&src, &pages, &RenderOutcome { total: 3, rendered: 3 }, 50, 320, 70).unwrap();

        assert!(
            previews_current(&src, &pages, 50, 320, 70).is_none(),
            "a manifest must not certify pages that are missing",
        );
    }

    #[test]
    fn a_missing_or_unreadable_manifest_means_regenerate() {
        let work = TempDir::new("sotto-manifest-none").unwrap();
        let src = work.path().join("doc.pdf");
        let pages = work.path().join("doc-thumb");
        std::fs::write(&src, b"doc").unwrap();
        std::fs::create_dir_all(&pages).unwrap();

        assert!(previews_current(&src, &pages, 50, 320, 70).is_none(), "no manifest → regenerate");

        std::fs::write(manifest_path(&pages), b"{ truncated").unwrap();
        assert!(previews_current(&src, &pages, 50, 320, 70).is_none(), "bad manifest → regenerate");
    }

    /* Spreadsheets are capped at one page on purpose: a wide sheet printed to PDF paginates into
       many near-empty slices, so the full allowance would render dozens of useless images. */
    #[test]
    fn spreadsheets_get_one_page_and_other_documents_get_the_full_budget() {
        for ext in ["xlsx", "xlsm", "xls"] {
            assert_eq!(page_budget(ext, 50), 1, ".{ext} must be capped at one page");
        }
        for ext in ["pdf", "pptx", "docx", "ppt", "doc"] {
            assert_eq!(page_budget(ext, 50), 50, ".{ext} must get the configured budget");
        }
        assert_eq!(page_budget("pdf", 0), 0, "a zero budget stays zero");
    }

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
        let (a, b) = (TempDir::new("sotto-test").unwrap(), TempDir::new("sotto-test").unwrap());
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

    /// A RenderJob for tests — the one place the field defaults live.
    fn job(lib_dir: &Path, src: &Path, thumb: &Path, pages_dir: Option<&Path>, limit: u32) -> RenderJob {
        RenderJob {
            lib_dir: lib_dir.to_string_lossy().into_owned(),
            src: src.to_string_lossy().into_owned(),
            thumb: thumb.to_string_lossy().into_owned(),
            pages_dir: pages_dir.map(|p| p.to_string_lossy().into_owned()),
            width: 320,
            quality: 70,
            limit,
        }
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
        let _serial = pdfium_serial();
        let Some(lib_dir) = pdfium_lib_dir() else {
            eprintln!("skipping: no bundled PDFium — run `npm run deps:native`");
            return;
        };
        let work = TempDir::new("sotto-render-test").unwrap();
        let src = work.path().join("in.pdf");
        let dest = work.path().join("out.webp");
        std::fs::write(&src, minimal_pdf()).unwrap();

        render_pdf(&job(&lib_dir, &src, &dest, None, 0)).expect("render should succeed");

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

    /* Poison-tolerant: a panicking test would otherwise poison the mutex and every later PDFium
       test would fail with PoisonError instead of its own result — one real failure reported as
       five, with the actual cause buried. The lock guards nothing but ordering, so a previous
       panic does not make it unsafe to take. */
    fn pdfium_serial() -> std::sync::MutexGuard<'static, ()> {
        PDFIUM_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

    /* The actual guarantee: one render, one worker process. Pins the argument order the parent and
       `worker_main` have to agree on — the only coupling between them. */
    #[test]
    fn worker_main_renders_a_pdf_and_reports_failure_by_exit_code() {
        let _serial = pdfium_serial();
        let Some(lib_dir) = pdfium_lib_dir() else { return };
        let work = TempDir::new("sotto-worker").unwrap();
        let good = work.path().join("good.pdf");
        let bad = work.path().join("bad.pdf");
        std::fs::write(&good, minimal_pdf()).unwrap();
        std::fs::write(&bad, b"not a pdf at all").unwrap();

        let argv = |src: &Path, dest: &Path| {
            vec![
                WORKER_FLAG.to_string(),
                serde_json::to_string(&job(&lib_dir, src, dest, None, 0)).unwrap(),
            ]
        };

        let out_good = work.path().join("good.webp");
        assert_eq!(worker_main(&argv(&good, &out_good)), 0, "valid PDF must exit 0");
        assert!(out_good.is_file(), "worker must have written the thumbnail");

        let out_bad = work.path().join("bad.webp");
        assert_eq!(worker_main(&argv(&bad, &out_bad)), 1, "invalid PDF must exit non-zero");
        assert!(!out_bad.exists(), "failed render must leave no file behind");

        // Both malformed-input shapes exit 2, distinct from a render failure's 1.
        assert_eq!(worker_main(&[WORKER_FLAG.to_string()]), 2, "missing payload must exit 2");
        assert_eq!(
            worker_main(&[WORKER_FLAG.to_string(), "{not json".to_string()]),
            2,
            "unreadable payload must exit 2",
        );
    }

    /* Multi-page rendering, including the cap. The synthetic PDF has one page, so the interesting
       assertions are the numbering, the reuse of page 1 as the thumbnail, and `total` vs `rendered`. */
    #[test]
    fn renders_pages_into_the_preview_folder_with_padded_names() {
        let _serial = pdfium_serial();
        let Some(lib_dir) = pdfium_lib_dir() else { return };
        let work = TempDir::new("sotto-pages").unwrap();
        let src = work.path().join("in.pdf");
        let thumb = work.path().join("in-thumb.webp");
        let pages = work.path().join("in-thumb");
        std::fs::write(&src, minimal_pdf()).unwrap();

        let outcome = render_pdf(&job(&lib_dir, &src, &thumb, Some(&pages), 50)).unwrap();

        assert_eq!(outcome.total, 1);
        assert_eq!(outcome.rendered, 1);
        assert!(thumb.is_file(), "the title thumbnail must still be written");
        // Zero-padded so lexical order is page order in shells, R2 listings and the portal.
        assert!(pages.join("001.webp").is_file(), "page 1 must be 001.webp");
        assert!(!pages.join("1.webp").exists(), "unpadded names must not be used");
    }

    /// `limit` caps what is rendered but must NOT change the reported page count.
    #[test]
    fn a_page_limit_caps_rendering_but_still_reports_the_real_total() {
        let _serial = pdfium_serial();
        let Some(lib_dir) = pdfium_lib_dir() else { return };
        let work = TempDir::new("sotto-pages-cap").unwrap();
        let src = work.path().join("in.pdf");
        let thumb = work.path().join("t.webp");
        let pages = work.path().join("p");
        std::fs::write(&src, minimal_pdf()).unwrap();

        // limit 0 renders nothing, yet `total` must still describe the document — that difference is
        // what lets the portal say "download the asset to see the rest".
        let outcome = render_pdf(&job(&lib_dir, &src, &thumb, Some(&pages), 0)).unwrap();
        assert_eq!(outcome.total, 1, "total is the document's page count, not the cap");
        assert_eq!(outcome.rendered, 0);
        assert!(!pages.join("001.webp").exists());
    }

    /* A shrinking page set must not leave orphans. The portal renders `rendered` pages from the
       manifest, so a leftover file past that count is invisible locally and visible to a client. */
    #[test]
    fn re_rendering_clears_pages_left_by_a_previous_run() {
        let _serial = pdfium_serial();
        let Some(lib_dir) = pdfium_lib_dir() else { return };
        let work = TempDir::new("sotto-pages-stale").unwrap();
        let src = work.path().join("in.pdf");
        let thumb = work.path().join("t.webp");
        let pages = work.path().join("p");
        std::fs::write(&src, minimal_pdf()).unwrap();
        std::fs::create_dir_all(&pages).unwrap();
        let orphan = pages.join("007.webp");
        std::fs::write(&orphan, b"stale page from an earlier, longer document").unwrap();

        render_pdf(&job(&lib_dir, &src, &thumb, Some(&pages), 50)).unwrap();

        assert!(!orphan.exists(), "a page beyond the new count must be removed");
        assert!(pages.join("001.webp").is_file());
    }

    /// A corrupt PDF must surface an error, never a zero-byte thumbnail the pipeline would cache.
    #[test]
    fn a_corrupt_pdf_errors_instead_of_writing_a_broken_thumbnail() {
        let _serial = pdfium_serial();
        let Some(lib_dir) = pdfium_lib_dir() else { return };
        let work = TempDir::new("sotto-render-bad").unwrap();
        let src = work.path().join("bad.pdf");
        let dest = work.path().join("bad.webp");
        std::fs::write(&src, b"%PDF-1.4\nthis is not a pdf").unwrap();

        let result = render_pdf(&job(&lib_dir, &src, &dest, None, 0));
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
