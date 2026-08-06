# 00b — Desktop: the UI freezes during a run, and LibreOffice shows up in the Dock

Prepend the **SHARED CONTEXT block** from `DONE_01_security-hardening-S0-S7.md`.

**Part A is LANDED** (commit `f790fbb`) — but was written in an environment with no Rust toolchain,
so **it has never been compiled**. Run `npm run check` before merging. Parts B and C are open.

_Filed 2026-08-06 from a report of a spinning beachball during a run on the installed build, with a
LibreOffice Dock icon appearing partway through._

---

## Correction to an earlier read (recorded so it isn't re-litigated)

An initial pass concluded the deployed app was falling back to a host LibreOffice because
`tauri.conf.json` lists only `resources/native/pdfium/**/*` in `bundle.resources`. **That was wrong.**
LibreOffice is excluded from `bundle.resources` *deliberately* — Tauri's bundler dereferences
symlinks, which inflates `LibreOffice.app` from ~800MB to 1.5GB and breaks its sealed signature
(measured; see the header of `scripts/package-desktop.mjs`) — and it is placed afterwards with
`ditto` by `npm run build:app`.

Verified on the installed build: `/Applications/Sotto.app/Contents/Resources/resources/native/
libreoffice/LibreOffice.app/Contents/MacOS/soffice` **is present**. Packaging works. The engine that
appeared in the Dock was our own bundled copy, not the host's.

---

## A. The freeze: heavy commands ran on the main thread — LANDED, UNVERIFIED

**Root cause.** Tauri v2, verbatim: *"Commands without the `async` keyword are executed on the main
thread unless defined with `#[tauri::command(async)]`."* Four commands did seconds of work and were
all declared sync:

| Command | File | Work it did on the main thread |
|---|---|---|
| `generate_document_previews` | `lib.rs:175` | ~6.4s LibreOffice conversion + N page rasters |
| `generate_thumbnail` | `lib.rs:112` | image decode/resize/encode, PDF raster, or that conversion |
| `file_md5` | `lib.rs:85` | MD5 over an entire file |
| `files_equal` | `lib.rs:32` | byte-for-byte comparison of two files |

The main thread runs the macOS event loop, so while any of these was in flight the app could not
service a redraw — the window failing to repaint when another window uncovered it is the signature
of main-thread blocking, not of general slowness.

**It also silently defeated the concurrency the code thinks it has.** `thumbnails.ts:99` and `:124`
dispatch batches of 8 via `Promise.all`, and `render.rs:288` records the worker pool as *"Measured
at 8-way: 86 pages/s … 233 pages/s."* Sync commands serialise onto the one main thread, so the
batching bought nothing and queued eight conversions' worth of freeze back to back — roughly 50s of
dead UI per batch of documents.

**Landed:** all four are now `#[tauri::command(async)]`, which moves a *sync* fn to a worker thread
with no change to its body or to any call site. Deliberately NOT converted to `async fn` — that
parks blocking work on the async runtime's executor, the same bug in a different place. Keychain and
reveal commands stay sync.

**Still to do:**
- `npm run check` — this has never been compiled.
- **Measure.** Time a batch of eight documents. Expect ~50s of freeze to become ~7s of responsive
  work. If it goes responsive but not faster, the batching has a second bottleneck worth finding.

## B. LibreOffice appears in the Dock, and can hang forever

**B1 — the Dock icon.** `render.rs:512` passes `--headless --norestore` plus, correctly, a private
`-env:UserInstallation` profile per conversion (`render.rs:504-507` explains why that is not
optional at 8-way). On macOS `--headless` suppresses document *windows* but does not stop
LibreOffice initialising AppKit and registering with LaunchServices. Because we ship a full nested
`LibreOffice.app`, macOS is willing to give it a Dock tile.

**Do:** add the rest of the standard headless set — `--invisible --nodefault --nologo --nolockcheck`.

**Constraint worth stating so nobody tries it:** the obvious alternative — setting `LSUIElement` /
`LSBackgroundOnly` in the nested `LibreOffice.app/Contents/Info.plist` — **must not be done.** It
breaks the sealed signature `package-desktop.mjs` preserves with `ditto`, and that signature is a
hard prerequisite for notarisation. Flags are the only lever. If they prove insufficient, the next
step is invoking `soffice.bin` directly, not editing the bundle.

**B2 — no timeout.** `Command::new(&soffice)….output()` (`render.rs:512`) and the render worker's
`.output()` (`render.rs:293`) both block indefinitely. A hung LibreOffice — stuck profile, first-run
prompt, Gatekeeper check on an unsigned build — blocks forever. Even after A, it stalls a worker slot
and the run.

**Do:** give both subprocess calls a timeout (60s is a reasonable start against the ~6.4s baseline),
kill the child on expiry, and surface a clear per-file error so one bad document fails that document,
not the run.

## C. Guarantee the bundled engine — kill the silent host fallback

This is the substance of "the app must not rely on LibreOffice being installed."

`soffice_from` (`render.rs:470-476`) resolves `bundled.or(on_path).or(host)`, where `host` is a
hardcoded `/Applications/LibreOffice.app/…` (`render.rs:478-487`). The precedence is right — bundled
must win so the reviewed version renders client decks. **The problem is the failure mode.** If
placement silently doesn't happen — a bare `tauri build` instead of `npm run build:app`, which the
release workflow warns about in exactly these words: *"A bare `tauri build` produces a bundle with NO
LibreOffice, which silently falls back to a host install on the runner and fails on a user's
machine"* — the app keeps working on any machine that has LibreOffice in /Applications, and fails
only on a client's. On a dev machine both exist, so the fallback is invisible.

**Do:**

- On **macOS and Windows**, make the bundled engine mandatory: if `native::tool_path` misses, return
  a hard error naming the expected path and `npm run build:app`. Do not fall through to the host.
- Keep `on_path` / `host` for **Linux only** (LibreOffice is a declared `deb`/`rpm` dependency there,
  `tauri.conf.json:33-46`) and for `tauri dev` — gate the dev fallback on `cfg!(debug_assertions)` so
  it cannot exist in a release build.
- Extend `soffice_from`'s AppHandle-free unit tests, including "release build, no bundled engine ->
  `Err`, not host".
- Add a packaging assertion in `scripts/package-desktop.mjs` after the `ditto` step: the placed
  `soffice` exists and is executable in the finished `.app`; fail the build if not. The script
  validates the source tree today but never re-checks the destination.
- Add the same check to the release workflow so CI cannot publish an engine-less DMG.

## D. Follow-ups (not blocking, recorded so they aren't lost)

- **Signing/notarisation is still off**; the slot is marked but empty (`package-desktop.mjs`,
  `── SIGNING GOES HERE ──`). Users need `xattr -dr com.apple.quarantine` or Settings -> Privacy &
  Security -> Open Anyway. An unsigned nested LibreOffice is also a plausible source of the B2 stalls.
- **Builds are arm64-only** — `"targets": "all"` selects bundle *formats*, not architectures.
  `fetch-native-deps.mjs` already has `darwin-x64` URLs for both engines, so Intel is a runner-matrix
  change, not new code.
- **~800MB of LibreOffice per bundle**, with auto-update off. Before turning the updater on (four
  steps, listed in the release workflow), decide whether every patch ships ~800MB.
  `docs/pages/ideas/slimming-the-bundled-libreoffice.mdx` scopes the trim.

---

## Definition of done

- `npm run check` green on the landed part A, and a timed run confirming 8-way throughput matches
  `render.rs:288`'s figures.
- No LibreOffice Dock icon or window during a run on a packaged build.
- Both `.output()` calls time out, kill the child, and report a per-file error; a deliberately hung
  conversion fails one file and lets the run continue.
- A release build with the engine removed **fails loudly** instead of using `/Applications`; covered
  by a `soffice_from` unit test.
- `package-desktop.mjs` and the release workflow both fail if the placed `soffice` is missing or
  non-executable in the finished `.app`.
- `docs/pages/reference/third-party-engines.mdx` updated for the mandatory-bundled rule and the flag
  set. (CLAUDE.md already carries the `#[tauri::command(async)]` rule, added with part A.)
