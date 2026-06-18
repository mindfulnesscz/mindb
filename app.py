#!/usr/bin/env python3
"""
dc-hub  v1.0
-----------------------------------------------------------------------------
Distribute:  scans source for [00] 📦 folders, collects files from sibling
             [03] OUT folders, version-filters, and copies them flat.
Publish:     mirrors [03] OUT contents to an equivalent target path, skipping
             everything except the output files (like rsync --delete per folder).
Thumbnails:  generates a WebP thumbnail from the first slide/page of every
             PPTX, PPT, PPTM and PDF file found in source (skips package folders).
Obsidian:    builds a DAM vault overlay -- one note per asset, canvases per scope.

Filename convention:  (Entity)(Angle)(Format)(Description)vX-Y-Z.ext
                      Round brackets () are canonical from v1.0.
                      Square brackets [] are accepted as a legacy alias.
Vocabulary:           vocabulary.json  -- canonical shortcode registry.
                      legacy_aliases   -- silent remapping of old shortcodes.
"""

import customtkinter as ctk
import threading
import shutil
import subprocess
import tempfile
import re
import json
import hashlib
import unicodedata
import urllib.request
import urllib.error
import urllib.parse
import webbrowser
import time
from pathlib import Path
from datetime import datetime
from tkinter import filedialog

# ── Appearance ────────────────────────────────────────────────────────────────
ctk.set_appearance_mode("dark")
ctk.set_default_color_theme("blue")

# ── Palette ───────────────────────────────────────────────────────────────────
C_BG      = "#0e0e11"
C_SURFACE = "#17171c"
C_SURFACE2= "#1e1e25"
C_BORDER  = "#2a2a35"
C_ACCENT  = "#7fff6e"
C_ACCENT2 = "#3d9bff"
C_WARN    = "#ffb83d"
C_DANGER  = "#ff5e5e"
C_TEXT    = "#e8e8f0"
C_MUTED   = "#6b6b80"

C_DISCONNECT = "#ff8c00"   # orange for disconnected asset warnings

LOG_COLORS = {
    "info":         C_TEXT,
    "success":      C_ACCENT,
    "skip":         C_WARN,
    "error":        C_DANGER,
    "dim":          C_MUTED,
    "section":      C_ACCENT2,
    "disconnected": C_DISCONNECT,
}

# ── Settings ──────────────────────────────────────────────────────────────────
SETTINGS_FILE = Path(__file__).parent / 'settings.json'
DEFAULT_SETTINGS = {
    'package_prefix': '[00] 📦',
    'out_folder':     '[03] OUT',
    'exclude_mark':   '⦰',
    'include_mark':   '🏁',
    'filter_mode':    'blacklist',
    'thumb_width':    '320',
    'thumb_quality':  '70',
    'source_folder':  '',
    'target_folder':  '',
    'do_distribute':      True,
    'do_publish':         False,
    'do_flat_export':     True,
    'do_thumbnails':      False,
    'do_obsidian':        False,
    'vault_folder':           '',
    'dropbox_app_key':        '',
    'dropbox_token':          '',
    'dropbox_refresh_token':  '',
    'onedrive_client_id':     '',
    'onedrive_tenant_id':     'common',
    'onedrive_token':         '',
    'onedrive_refresh_token': '',
    'onedrive_flat_folder':   '',
    'dam_depth':              '1',
}

def load_settings() -> dict:
    if SETTINGS_FILE.exists():
        try:
            with open(SETTINGS_FILE, encoding='utf-8') as f:
                return {**DEFAULT_SETTINGS, **json.load(f)}
        except Exception:
            pass
    return DEFAULT_SETTINGS.copy()

def save_settings(settings: dict) -> None:
    with open(SETTINGS_FILE, 'w', encoding='utf-8') as f:
        json.dump(settings, f, indent=2, ensure_ascii=False)

def _should_skip(name: str, settings: dict) -> bool:
    """Return True if this single item (file or folder) should be skipped."""
    if name.startswith('~$'):
        return True
    if '[99]' in name:
        return True
    if settings.get('filter_mode', 'blacklist') == 'whitelist':
        return settings.get('include_mark', '🏁') not in name
    return settings.get('exclude_mark', '⦰') in name

def _is_publishable_file(path: Path) -> bool:
    """Return True if a file has a real extension (not an alias/no-ext file)."""
    return bool(path.suffix)

def _is_unchanged(src: Path, dest: Path) -> bool:
    """Return True if dest exists with the same size as src (content is identical).
    Size-only: immune to sync-client mtime resets by OneDrive/SharePoint.
    """
    if not dest.exists():
        return False
    return src.stat().st_size == dest.stat().st_size


def _is_sync_noise(src: Path, dest: Path) -> bool:
    """Return True if dest has a different size but the same mtime as src.
    This is the signature of a sync client (SharePoint/OneDrive) silently
    rewriting the file with metadata — the mtime is preserved, but the bytes
    change slightly.  Safe to skip without alarming the user.
    """
    if not dest.exists():
        return False
    ss, ds = src.stat(), dest.stat()
    return ss.st_size != ds.st_size and ds.st_mtime == ss.st_mtime


def _is_externally_modified(src: Path, dest: Path) -> bool:
    """Return True if dest exists, has a DIFFERENT size from src, and is NEWER.
    This means a person intentionally modified the file after our last publish.
    We should not overwrite it — caller should report it instead.
    """
    if not dest.exists():
        return False
    ss, ds = src.stat(), dest.stat()
    return ss.st_size != ds.st_size and ds.st_mtime > ss.st_mtime


def _is_version_conflict(src: Path, dest: Path) -> bool:
    """Return True if dest exists with the same name but different size.
    This indicates the source was modified without bumping the version number.
    The file should NOT be overwritten — caller should alert the user instead.
    """
    if not dest.exists():
        return False
    return src.stat().st_size != dest.stat().st_size


def _note_is_fresh(src_mtime: float, note_path: Path, need_dropbox: bool) -> bool:
    """Return True if the note can be skipped entirely this run.
    src_mtime: mtime of the source asset file or folder.
    need_dropbox: True when a Dropbox token is active and a link is expected.
    """
    if not note_path.exists():
        return False
    if src_mtime > note_path.stat().st_mtime:
        return False
    if need_dropbox:
        try:
            text = note_path.read_text(encoding='utf-8')
            if not re.search(r'<!--\s*dam:dropbox:"[^"]+"\s*-->', text):
                return False
        except Exception:
            return False
    return True


def _should_skip_path(parts, settings: dict) -> bool:
    """Return True if an item whose relative path has these parts should be skipped.
    Blacklist: any part contains the exclude mark → skip.
    Whitelist: no part contains the include mark → skip.
    Always skips Office lock files (~$).
    """
    if any(part.startswith('~$') for part in parts):
        return True
    if settings.get('filter_mode', 'blacklist') == 'whitelist':
        mark = settings.get('include_mark', '🏁')
        return not any(mark in part for part in parts)
    mark = settings.get('exclude_mark', '⦰')
    return any(mark in part for part in parts)

# ── Version helpers ───────────────────────────────────────────────────────────
VERSION_RE = re.compile(
    r'^(.*?)[-_]?(v(\d+)(?:[.\-](\d+))?(?:[.\-](\d+))?)(\.[^.]+)?$',
    re.IGNORECASE
)

def parse_version(filename: str):
    m = VERSION_RE.match(filename)
    if not m:
        return None
    return (m.group(1), m.group(6) or '',
            (int(m.group(3) or 0), int(m.group(4) or 0), int(m.group(5) or 0)))

def highest_versions(files: list) -> list:
    groups = {}
    unversioned = []
    for f in files:
        p = parse_version(f.name)
        if p is None:
            unversioned.append(f)
            continue
        base, ext, ver = p
        key = (base.lower(), ext.lower())
        if key not in groups or ver > groups[key][0]:
            groups[key] = (ver, f)
    return unversioned + [v for _, v in groups.values()]

# ── Core logic — Distribute ───────────────────────────────────────────────────

def _find_all_package_anchors(source: Path, settings: dict) -> list:
    """Return every folder that directly contains a package folder, shallowest first.
    Each such folder is a 'canvas scope' — its sibling project folders form clusters."""
    pkg_prefix = settings.get('package_prefix', '[00] 📦')
    anchors = []

    def _walk(folder: Path):
        if _should_skip(folder.name, settings):
            return
        try:
            children = list(folder.iterdir())
        except PermissionError:
            return
        if any(c.is_dir() and c.name.startswith(pkg_prefix) for c in children):
            anchors.append(folder)
        for c in children:
            if c.is_dir() and not c.name.startswith(pkg_prefix) and not _should_skip(c.name, settings):
                _walk(c)

    _walk(source)
    return sorted(anchors, key=lambda p: len(p.parts))


def _scope_for(proj_dir: Path, anchors: list) -> 'Path | None':
    """Return the shallowest (topmost) anchor that is a proper ancestor of proj_dir, or None.
    Using the topmost anchor means all nested package folders collapse into the same canvas
    as their parent scope, forming clusters rather than separate canvases."""
    best = None
    for anchor in anchors:
        try:
            proj_dir.relative_to(anchor)
            if best is None or len(anchor.parts) < len(best.parts):
                best = anchor
        except ValueError:
            pass
    return best


def _iter_source_dirs(root: Path, settings: dict):
    """Yield (source_dir, is_orphan) pairs:
    - Folder has direct [03] OUT child → yield that OUT dir (not an orphan),
      do NOT recurse into siblings ([01] IN, [02] WRK).
    - Folder has direct publishable files but no [03] OUT → yield folder as orphan
      (caller must only collect DIRECT files from it, not recurse), then ALSO
      recurse into subdirectories so deeper [03] OUT dirs are not missed.
    - Folder has neither → recurse into subdirectories.
    """
    if _should_skip(root.name, settings):
        return
    # Never descend into package folders — they are collection targets, not sources
    pkg_prefix = settings.get('package_prefix', '[00] 📦')
    if root.name.startswith(pkg_prefix):
        return
    try:
        children = list(root.iterdir())
    except PermissionError:
        return
    out_dir = root / settings['out_folder']
    if out_dir.is_dir():
        yield out_dir, False
        return  # siblings ([01] IN, [02] WRK) are never recursed into
    has_files = any(
        f.is_file() and not f.name.startswith('.')
        and _is_publishable_file(f) and not _should_skip(f.name, settings)
        for f in children
    )
    if has_files:
        yield root, True
        # do NOT return — still recurse so deeper [03] OUT dirs are found
    for child in children:
        if child.is_dir() and not _should_skip(child.name, settings):
            yield from _iter_source_dirs(child, settings)


def find_out_folders(root: Path, settings: dict) -> list:
    out_name = settings['out_folder'].lower()
    results  = []
    try:
        for item in root.iterdir():
            if _should_skip(item.name, settings):
                continue
            if item.is_dir():
                if item.name.lower() == out_name:
                    results.append(item)
                else:
                    results.extend(find_out_folders(item, settings))
    except PermissionError:
        pass
    return results

def collect_files_from(folder: Path, settings: dict, direct_only: bool = False) -> list:
    pkg_prefix = settings.get('package_prefix', '[00] 📦')
    files   = []
    try:
        for item in folder.iterdir():
            if item.name.startswith('.'):
                continue
            if _should_skip(item.name, settings):
                continue
            if item.is_file() and '-thumb' not in item.stem and _is_publishable_file(item):
                files.append(item)
            elif item.is_dir() and not direct_only \
                    and not item.name.startswith(pkg_prefix):
                files.extend(collect_files_from(item, settings))
    except PermissionError:
        pass
    return files

def find_package_folders(root: Path, settings: dict) -> list:
    prefix  = settings['package_prefix']
    results = []
    try:
        for item in root.iterdir():
            if _should_skip(item.name, settings):
                continue
            if item.is_dir():
                if item.name.startswith(prefix):
                    results.append(item)
                results.extend(find_package_folders(item, settings))
    except PermissionError:
        pass
    return results

def run_collector(source: Path, dry_run: bool, version_filter: bool,
                  pack_subfolders: bool, settings: dict, log_fn, progress_fn,
                  stop_event=None) -> dict:
    stats   = {'packages': 0, 'copied': 0, 'skipped': 0, 'errors': 0}
    mode    = 'DRY RUN' if dry_run else 'COLLECTING'
    log_fn('section', f'━━━ {mode} — {datetime.now().strftime("%Y-%m-%d %H:%M:%S")} ━━━')

    packages = find_package_folders(source, settings)
    if not packages:
        log_fn('warning', f'No folders matching "{settings["package_prefix"]}" found.')
        return stats

    log_fn('info', f'Found {len(packages)} package folder(s)')
    total = max(len(packages), 1)

    for idx, pkg in enumerate(packages):
        if stop_event and stop_event.is_set():
            log_fn('warning', '  ⊘  Stopped by user.')
            break
        stats['packages'] += 1
        log_fn('section', f'📦  {pkg.relative_to(source)}')

        parent   = pkg.parent
        siblings = [i for i in parent.iterdir()
                    if i.is_dir() and i != pkg and not _should_skip(i.name, settings)]

        source_dirs = []  # (dir, is_orphan)
        for sib in siblings:
            for sd, is_orphan in _iter_source_dirs(sib, settings):
                label = '📂 orphan' if is_orphan else settings['out_folder']
                log_fn('dim', f'  ├─ {label}: …/{sd.relative_to(parent)}')
                source_dirs.append((sd, is_orphan))

        if not source_dirs:
            log_fn('dim', f'  └─ no {settings["out_folder"]} or publishable files found in siblings — skipping')
            progress_fn((idx + 1) / total)
            continue

        # Collect as (file, source_dir_root) pairs to preserve relative paths
        all_pairs = []
        for sd, is_orphan in source_dirs:
            for f in collect_files_from(sd, settings, direct_only=is_orphan):
                all_pairs.append((f, sd))

        if not all_pairs:
            log_fn('dim', f'  └─ {settings["out_folder"]} folders are empty — skipping')
            progress_fn((idx + 1) / total)
            continue

        if version_filter:
            file_paths = [f for f, _ in all_pairs]
            kept = set(highest_versions(file_paths))
            for f, _ in all_pairs:
                if f not in kept:
                    log_fn('skip', f'  ⊘  skipped older version: {f.name}')
                    stats['skipped'] += 1
            to_copy = [(f, root) for f, root in all_pairs if f in kept]
        else:
            to_copy = all_pairs

        live_pkg_paths: set[Path] = set()

        for f, out_root in to_copy:
            parsed    = _parse_asset_filename(f.stem)
            fmt_entry = _fmt_entry(parsed)
            translated = _translate_export_name(f.stem, f.suffix, parsed, fmt_entry)
            if pack_subfolders:
                rel   = f.relative_to(out_root)
                dest  = pkg / rel.parent / translated
                label = str(rel.parent / translated)
            else:
                dest  = pkg / translated
                label = translated

            live_pkg_paths.add(dest)

            if dry_run:
                log_fn('success', f'  ✓  [DRY] would copy: {label}')
                stats['copied'] += 1
            else:
                if _is_unchanged(f, dest):
                    log_fn('dim', f'  ↷  unchanged: {label}')
                    stats['skipped'] += 1
                    continue
                if _is_sync_noise(f, dest):
                    log_fn('dim', f'  ↷  sync noise (skipped): {label}')
                    stats['skipped'] += 1
                    continue
                if _is_externally_modified(f, dest):
                    stats.setdefault('_sp_modified', []).append(label)
                    stats['skipped'] += 1
                    continue
                if _is_version_conflict(f, dest):
                    stats.setdefault('_conflicts', []).append(label)
                    stats['skipped'] += 1
                    continue
                try:
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(f, dest)
                    log_fn('success', f'  ✓  copied: {label}')
                    stats['copied'] += 1
                except Exception as e:
                    log_fn('error', f'  ✗  failed: {label} — {e}')
                    stats['errors'] += 1

        # Delete orphaned files in the package that are no longer in any source.
        # NFC-normalise both sides so macOS NFD paths compare correctly against
        # translated names which may be in NFC form.
        if not dry_run:
            try:
                live_pkg_nfc = {unicodedata.normalize('NFC', str(p)) for p in live_pkg_paths}
                for existing in pkg.rglob('*'):
                    existing_nfc = unicodedata.normalize('NFC', str(existing))
                    if existing.is_file() and not existing.name.startswith('.') \
                            and existing_nfc not in live_pkg_nfc:
                        existing.unlink()
                        log_fn('dim', f'  🗑  Removed from package: {existing.relative_to(pkg)}')
                # Clean up any empty subdirectories left behind
                for d in sorted(pkg.rglob('*'), reverse=True):
                    if d.is_dir() and not any(d.iterdir()):
                        d.rmdir()
            except Exception as e:
                log_fn('error', f'  ✗  Could not clean package: {e}')

        progress_fn((idx + 1) / total)

    conflicts = stats.pop('_conflicts', [])
    if conflicts:
        log_fn('warning', f'  ⚠  VERSION CONFLICTS — {len(conflicts)} file(s) NOT overwritten '
               f'(same name, different size — bump the version number):')
        for name in conflicts:
            log_fn('warning', f'    ⚠  {name}')

    sp_modified = stats.pop('_sp_modified', [])
    if sp_modified:
        log_fn('warning', f'  ✏️  MODIFIED BY USER — {len(sp_modified)} file(s) were edited after last publish (not overwritten):')
        for name in sp_modified:
            log_fn('warning', f'    ☁  {name}')

    log_fn('section',
           f'━━━ COLLECT DONE — {stats["copied"]} copied · '
           f'{stats["skipped"]} skipped · {stats.get("disconnected", 0)} disconnected · '
           f'{len(conflicts)} conflicts · {stats["errors"]} errors ━━━')
    return stats

# ── Core logic — Publish ──────────────────────────────────────────────────────

def _publish_folder(folder: Path, target: Path, settings: dict,
                    log_fn, stats: dict) -> None:
    out_name = settings['out_folder']

    if _should_skip(folder.name, settings):
        return

    try:
        children = list(folder.iterdir())
    except PermissionError:
        return

    if not children:
        return

    out_dir = folder / out_name
    if out_dir.is_dir():
        # Skip entirely if [03] OUT has no publishable files — avoids creating
        # empty target directories that would later be flagged as disconnected.
        try:
            _has_content = next(
                (f for f in out_dir.rglob('*')
                 if f.is_file() and not f.name.startswith('.')
                 and _is_publishable_file(f)),
                None
            )
        except PermissionError:
            _has_content = None
        if _has_content is None:
            log_fn('dim', f'  ⊘  empty [03] OUT — skipped: {folder.name}')
            return

        # Mirror [03] OUT contents → target (including thumbnails)
        log_fn('info', f'  📤 {folder.name}')
        try:
            target.mkdir(parents=True, exist_ok=True)
        except Exception as e:
            log_fn('error', f'  ✗  could not prepare target {target.name}: {e}')

        stats['pub_folders'] += 1
        try:
            # Collect direct children first to detect gallery folders at top level
            direct_children = list(out_dir.iterdir())
        except PermissionError:
            direct_children = []

        # Gallery folders: direct subfolders of [03] OUT matching naming convention
        gallery_names = {
            item.name for item in direct_children
            if item.is_dir() and not item.name.startswith('.')
            and not _should_skip(item.name, settings) and _is_gallery_folder(item)
        }

        try:
            for item in out_dir.rglob('*'):
                rel = item.relative_to(out_dir)
                if _should_skip_path(rel.parts, settings):
                    continue

                # Skip files inside gallery folders — galleries are copied wholesale below
                if rel.parts and rel.parts[0] in gallery_names and len(rel.parts) > 1:
                    continue

                if item.is_dir() and item.name in gallery_names and item.parent == out_dir:
                    # Gallery folder → copy entire folder translated
                    parsed    = _parse_asset_filename(item.name)
                    fmt_entry = _fmt_entry(parsed)
                    translated_name = _translate_export_name(item.name, '', parsed, fmt_entry).rstrip()
                    dest_dir = target / translated_name
                    # Pre-collect images; skip entirely if gallery is empty
                    try:
                        gallery_imgs = [
                            img for img in sorted(item.rglob('*'), key=lambda p: str(p).lower())
                            if img.is_file() and not img.name.startswith('.')
                        ]
                    except PermissionError:
                        gallery_imgs = []
                    if not gallery_imgs:
                        log_fn('dim', f'    ⊘  empty gallery — skipped: {translated_name}')
                        continue
                    stats.setdefault('_live_pub', set()).add(dest_dir)
                    log_fn('info', f'    🖼  gallery: {translated_name}')
                    try:
                        dest_dir.mkdir(parents=True, exist_ok=True)
                        for img in gallery_imgs:
                            img_dest = dest_dir / img.relative_to(item)
                            img_dest.parent.mkdir(parents=True, exist_ok=True)
                            stats.setdefault('_live_pub', set()).add(img_dest)
                            if _is_unchanged(img, img_dest):
                                stats['skipped'] += 1
                            else:
                                shutil.copy2(img, img_dest)
                                sz = img.stat().st_size
                                sz_str = f'{sz/1048576:.1f} MB' if sz >= 1048576 else f'{sz//1024} KB'
                                log_fn('success', f'      ✓  {img.name}  [{sz_str}, dest was missing]')
                                stats['published'] += 1
                    except Exception as e:
                        log_fn('error', f'    ✗  gallery copy failed {translated_name}: {e}')
                        stats['errors'] += 1
                    continue

                if item.is_file() and not item.name.startswith('.') and _is_publishable_file(item):
                    if '-thumb' in item.stem:
                        base_stem = item.stem[:item.stem.rfind('-thumb')]
                        base_parsed = _parse_asset_filename(base_stem)
                        translated_base = _translate_export_name(base_stem, '', base_parsed)
                        dest = target / rel.parent / (translated_base + '-thumb' + item.suffix)
                    else:
                        parsed    = _parse_asset_filename(item.stem)
                        fmt_entry = _fmt_entry(parsed)
                        dest = target / rel.parent / _translate_export_name(item.stem, item.suffix, parsed, fmt_entry)
                    stats.setdefault('_live_pub', set()).add(dest)
                    if _is_unchanged(item, dest):
                        log_fn('dim', f'    ↷  unchanged: {dest.name}')
                        stats['skipped'] += 1
                        continue
                    if _is_sync_noise(item, dest):
                        log_fn('dim', f'    ↷  sync noise (skipped): {dest.name}')
                        stats['skipped'] += 1
                        continue
                    if _is_externally_modified(item, dest):
                        stats.setdefault('_sp_modified', []).append(dest.name)
                        stats['skipped'] += 1
                        continue
                    if _is_version_conflict(item, dest):
                        stats.setdefault('_conflicts', []).append(dest.name)
                        stats['skipped'] += 1
                        continue
                    try:
                        dest.parent.mkdir(parents=True, exist_ok=True)
                        flagged_variant = dest.parent / f'🚫 {dest.name}'
                        if flagged_variant.exists():
                            log_fn('warning', f'    ⚠  STALE 🚫 FILE EXISTS: {flagged_variant.name} — orphan detection renamed this previously')
                        shutil.copy2(item, dest)
                        sz = item.stat().st_size
                        sz_str = f'{sz/1048576:.1f} MB' if sz >= 1048576 else f'{sz//1024} KB'
                        log_fn('success', f'    ✓  {dest.name}  [{sz_str}, dest was missing]')
                        stats['published'] += 1
                    except Exception as e:
                        log_fn('error', f'    ✗  {dest.name}: {e}')
                        stats['errors'] += 1
        except PermissionError:
            pass
    else:
        # Recurse into subfolders; track any intermediate direct files so they
        # are not mistakenly flagged as disconnected
        direct = [f for f in children
                  if f.is_file() and not _should_skip(f.name, settings)
                  and not f.name.startswith('.') and _is_publishable_file(f)]
        if direct:
            log_fn('dim', f'  📄 {folder.name}')
            try:
                target.mkdir(parents=True, exist_ok=True)
                for f in direct:
                    dest = target / f.name
                    stats.setdefault('_live_pub', set()).add(dest)
                    if _is_unchanged(f, dest):
                        stats['skipped'] += 1
                        continue
                    if _is_sync_noise(f, dest):
                        stats['skipped'] += 1
                        continue
                    if _is_externally_modified(f, dest):
                        stats.setdefault('_sp_modified', []).append(dest.name)
                        stats['skipped'] += 1
                        continue
                    sz = f.stat().st_size
                    sz_str = f'{sz/1048576:.1f} MB' if sz >= 1048576 else f'{sz//1024} KB'
                    log_fn('success', f'  ✓  {dest.name}  [{sz_str}, dest was missing]')
                    shutil.copy2(f, dest)
                    stats['published'] += 1
            except Exception as e:
                log_fn('error', f'  ✗  {folder.name}: {e}')
                stats['errors'] += 1

        for sub in children:
            if sub.is_dir() and not _should_skip(sub.name, settings):
                _publish_folder(sub, target / sub.name, settings, log_fn, stats)

def run_publish(source: Path, target: Path, settings: dict,
                log_fn, progress_fn, stop_event=None) -> dict:
    stats   = {'pub_folders': 0, 'published': 0, 'skipped': 0, 'errors': 0}
    log_fn('section', f'━━━ PUBLISHING — {datetime.now().strftime("%Y-%m-%d %H:%M:%S")} ━━━')
    log_fn('dim', f'  → {target}')

    out_name = settings['out_folder']
    try:
        top_items = [f for f in source.iterdir()
                     if f.is_dir() and not _should_skip(f.name, settings)]
    except Exception as e:
        log_fn('error', f'Cannot read source: {e}')
        return stats

    total = max(len(top_items), 1)
    for i, folder in enumerate(top_items):
        if stop_event and stop_event.is_set():
            log_fn('warning', '  ⊘  Stopped by user.')
            break
        # Rule: never publish a folder that is a sibling of an [03] OUT folder
        # at the same parent level (it would be [01] IN, [02] WRK, etc.)
        if folder.name.lower() != out_name.lower() and (folder.parent / out_name).is_dir():
            log_fn('dim', f'  ⊘  sibling of {out_name} — skipped: {folder.name}')
            progress_fn((i + 1) / total)
            continue
        _publish_folder(folder, target / folder.name, settings, log_fn, stats)
        progress_fn((i + 1) / total)

    # ── Disconnected detection in target ─────────────────────────────────────
    live_pub = stats.pop('_live_pub', set())
    # Skip the expensive rglob walk when nothing was published — avoids slow
    # SharePoint filesystem traversal and prevents false-positive orphan renames
    # caused by macOS NFD vs SharePoint NFC Unicode normalization differences.
    if stats['published'] == 0:
        log_fn('dim', f'  ↷  orphan scan skipped — nothing published this run')
    if target.exists() and live_pub and stats['published'] > 0 \
            and not (stop_event and stop_event.is_set()):
        # NFC-normalise live_pub paths so they compare correctly against
        # SharePoint-reflected filenames (SharePoint uses NFC, macOS uses NFD).
        live_pub_nfc = {unicodedata.normalize('NFC', str(p)) for p in live_pub}

        # Flag orphan files
        for existing in target.rglob('*'):
            if not existing.exists():
                continue  # already moved as child of a renamed parent
            existing_nfc = unicodedata.normalize('NFC', str(existing))
            if existing.is_file() and not existing.name.startswith('.') \
                    and existing_nfc not in live_pub_nfc \
                    and not existing.name.startswith('🚫'):
                flagged = existing.parent / f'🚫 {existing.name}'
                try:
                    existing.rename(flagged)
                    log_fn('disconnected', f'  🚫 DISCONNECTED: {existing.relative_to(target)}')
                    stats['disconnected'] = stats.get('disconnected', 0) + 1
                except Exception as e:
                    log_fn('error', f'  ✗  Could not flag {existing.name}: {e}')
        # Flag orphan folders (e.g. gallery folders removed from source)
        # Sort shallowest first so renaming a parent also moves its children
        for existing in sorted(target.rglob('*'), key=lambda p: len(p.parts)):
            if not existing.exists():
                continue  # already moved as child of a renamed parent
            existing_nfc = unicodedata.normalize('NFC', str(existing))
            if existing.is_dir() and not existing.name.startswith('.') \
                    and not existing.name.startswith('🚫'):
                has_live = any(
                    unicodedata.normalize('NFC', str(p)) == existing_nfc
                    or existing_nfc in unicodedata.normalize('NFC', str(p))
                    for p in live_pub
                )
                if not has_live:
                    flagged = existing.parent / f'🚫 {existing.name}'
                    try:
                        existing.rename(flagged)
                        log_fn('disconnected', f'  🚫 DISCONNECTED folder: {existing.relative_to(target)}')
                        stats['disconnected'] = stats.get('disconnected', 0) + 1
                    except Exception as e:
                        log_fn('error', f'  ✗  Could not flag folder {existing.name}: {e}')

    # ── Version conflict report ───────────────────────────────────────────────
    conflicts = stats.pop('_conflicts', [])
    if conflicts:
        log_fn('warning', f'  ⚠  VERSION CONFLICTS — {len(conflicts)} file(s) NOT overwritten '
               f'(same name, different size — bump the version number):')
        for name in conflicts:
            log_fn('warning', f'    ⚠  {name}')

    # ── SharePoint-modified report ────────────────────────────────────────────
    sp_modified = stats.pop('_sp_modified', [])
    if sp_modified:
        log_fn('warning', f'  ✏️  MODIFIED BY USER — {len(sp_modified)} file(s) were edited after last publish (not overwritten):')
        for name in sp_modified:
            log_fn('warning', f'    ☁  {name}')

    log_fn('section',
           f'━━━ PUBLISH DONE — {stats["pub_folders"]} folders · '
           f'{stats["published"]} files · '
           f'{stats.get("disconnected", 0)} disconnected · '
           f'{len(conflicts)} conflicts · '
           f'{stats["errors"]} errors ━━━')
    return stats

# ── Core logic — Thumbnails ───────────────────────────────────────────────────

THUMB_EXTS  = {'.pptx', '.pptm', '.ppt', '.pdf', '.png', '.jpg', '.jpeg', '.webp'}
IMAGE_EXTS  = {'.jpg', '.jpeg', '.png', '.webp', '.gif', '.tif', '.tiff', '.bmp'}


def _is_gallery_folder(folder: Path) -> bool:
    """A gallery folder is any direct subfolder of [03] OUT with a valid bracket-tag name
    that contains at least one direct publishable file.
    """
    parsed = _parse_asset_filename(folder.name)
    if parsed.get('error'):
        return False
    try:
        return any(f.is_file() and not f.name.startswith('.')
                   and _is_publishable_file(f)
                   for f in folder.iterdir())
    except PermissionError:
        return False


def _gallery_first_thumbnable(folder: Path) -> Path | None:
    """Return the alphabetically first thumbnable direct file (image/PDF/PPTX) in a gallery folder.
    Subfolders inside the gallery are ignored.
    """
    try:
        files = sorted(
            (f for f in folder.iterdir()
             if f.is_file() and f.suffix.lower() in THUMB_EXTS
             and not f.name.startswith('.')),
            key=lambda p: p.name.lower()
        )
        return files[0] if files else None
    except PermissionError:
        return None


def _image_to_thumb(img: Path, out_webp: Path, log_fn,
                    width: str = '320', quality: str = '70') -> bool:
    """Convert any image to a WebP thumbnail using cwebp."""
    return _encode_webp(img, out_webp, img.name, log_fn, width, quality)

def _find_thumbnable(root: Path, settings: dict) -> list:
    """Recursively collect PPTX/PDF files, respecting filter mode and skipping package folders."""
    prefix  = settings['package_prefix']
    results = []
    try:
        for item in root.iterdir():
            if _should_skip(item.name, settings):
                continue
            if item.is_dir():
                if item.name.startswith(prefix):
                    continue          # never enter package folders
                out_name = settings['out_folder']
                if item.name.lower() != out_name.lower() and (item.parent / out_name).is_dir():
                    continue          # sibling of [03] OUT — skip [01] IN, [02] WRK, etc.
                results.extend(_find_thumbnable(item, settings))
            elif item.is_file() and item.suffix.lower() in THUMB_EXTS \
                    and '-thumb' not in item.stem:
                results.append(item)
    except PermissionError:
        pass
    return results

def _encode_webp(png: Path, out_webp: Path, label: str, log_fn,
                 width: str = '320', quality: str = '70') -> bool:
    """Resize PNG → WebP at the configured width and quality."""
    try:
        r = subprocess.run(
            ['cwebp', '-quiet', '-resize', width, '0', '-q', quality,
             str(png), '-o', str(out_webp)],
            capture_output=True, timeout=30
        )
        if r.returncode == 0 and out_webp.exists():
            log_fn('success', f'  ✓  {label} → {out_webp.name}')
            return True
        log_fn('error', f'  ✗  WebP encode failed: {label}')
        return False
    except FileNotFoundError:
        log_fn('error', '  ✗  cwebp not found — install: brew install webp')
        return False
    except Exception as e:
        log_fn('error', f'  ✗  {label}: {e}')
        return False

def _pdf_to_thumb(pdf: Path, out_webp: Path, log_fn,
                  width: str, quality: str) -> bool:
    """Render first page of a PDF to WebP thumbnail."""
    try:
        with tempfile.TemporaryDirectory() as tmp:
            png = Path(tmp) / 'page.png'
            r = subprocess.run(
                ['pdftoppm', '-png', '-f', '1', '-singlefile',
                 str(pdf), str(png.with_suffix(''))],
                capture_output=True, timeout=60
            )
            if r.returncode != 0 or not png.exists():
                log_fn('error', f'  ✗  PDF render failed: {pdf.name}')
                return False
            return _encode_webp(png, out_webp, pdf.name, log_fn, width, quality)
    except FileNotFoundError:
        log_fn('error', '  ✗  pdftoppm not found — install: brew install poppler')
        return False
    except Exception as e:
        log_fn('error', f'  ✗  {pdf.name}: {e}')
        return False

def _pptx_to_thumb(pptx: Path, out_webp: Path, log_fn,
                   width: str, quality: str) -> bool:
    """Convert PPTX → PDF (via LibreOffice) → render first slide → WebP."""
    try:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            # Try common macOS path for LibreOffice if not on PATH
            soffice = shutil.which('soffice') or \
                      '/Applications/LibreOffice.app/Contents/MacOS/soffice'
            r = subprocess.run(
                [soffice, '--headless', '--convert-to', 'pdf',
                 '--outdir', str(tmp_path), str(pptx)],
                capture_output=True, timeout=120
            )
            pdf = tmp_path / f'{pptx.stem}.pdf'
            if r.returncode != 0 or not pdf.exists():
                log_fn('error', f'  ✗  LibreOffice conversion failed: {pptx.name}')
                return False
            return _pdf_to_thumb(pdf, out_webp, log_fn, width, quality)
    except FileNotFoundError:
        log_fn('error', '  ✗  soffice not found — install LibreOffice')
        return False
    except Exception as e:
        log_fn('error', f'  ✗  {pptx.name}: {e}')
        return False

def run_thumbnails(source: Path, settings: dict, log_fn, progress_fn,
                   stop_event=None) -> dict:
    stats = {'thumbs': 0, 'errors': 0}
    log_fn('section', f'━━━ THUMBNAILS — {datetime.now().strftime("%Y-%m-%d %H:%M:%S")} ━━━')

    files = _find_thumbnable(source, settings)
    if not files:
        log_fn('dim', '  No thumbnable files found.')
        return stats

    log_fn('info', f'  Found {len(files)} file(s)')
    total   = max(len(files), 1)
    width   = settings.get('thumb_width', '320')
    quality = settings.get('thumb_quality', '70')

    for i, f in enumerate(files):
        if stop_event and stop_event.is_set():
            log_fn('warning', '  ⊘  Stopped by user.')
            break
        out_webp = f.parent / f'{f.stem}-thumb.webp'
        if out_webp.exists():
            log_fn('dim', f'  ↷ skipped (exists): {f.name}')
            progress_fn((i + 1) / total)
            continue
        ext = f.suffix.lower()
        if ext == '.pdf':
            ok = _pdf_to_thumb(f, out_webp, log_fn, width, quality)
        elif ext in {'.png', '.jpg', '.jpeg', '.webp'}:
            ok = _image_to_thumb(f, out_webp, log_fn, width, quality)
        else:
            ok = _pptx_to_thumb(f, out_webp, log_fn, width, quality)
        if ok:
            stats['thumbs'] += 1
        else:
            stats['errors'] += 1
        progress_fn((i + 1) / total)

    log_fn('section',
           f'━━━ THUMBNAILS DONE — {stats["thumbs"]} created · '
           f'{stats["errors"]} errors ━━━')
    return stats


# ── Dropbox integration ───────────────────────────────────────────────────────

def _dropbox_root(path: Path):
    """Return the Dropbox root directory found in path, or None.
    Handles personal (~/ Dropbox/), team (~/Dropbox (Team)/),
    and macOS CloudStorage (~/Library/CloudStorage/Dropbox-NAME/) layouts.
    """
    for i, part in enumerate(path.parts):
        if part == 'Dropbox' or part.startswith('Dropbox-') or part.startswith('Dropbox ('):
            return Path(*path.parts[:i + 1])
    return None


def _dropbox_api_path(local_path: Path, db_root: Path) -> str:
    """Convert a local absolute path to a Dropbox API path (/folder/file.ext)."""
    return '/' + local_path.relative_to(db_root).as_posix()


def _dropbox_token_refresh(app_key: str, refresh_token: str) -> dict:
    """Exchange a Dropbox refresh token for a new access token. Returns token dict."""
    data = urllib.parse.urlencode({
        'grant_type':    'refresh_token',
        'refresh_token': refresh_token,
        'client_id':     app_key,
    }).encode()
    req = urllib.request.Request(
        'https://api.dropbox.com/oauth2/token',
        data=data, headers={'Content-Type': 'application/x-www-form-urlencoded'},
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        try:
            body = json.loads(e.read())
            raise RuntimeError(body.get('error_description') or body.get('error', f'HTTP {e.code}')) from e
        except (json.JSONDecodeError, KeyError):
            raise RuntimeError(f'HTTP {e.code}') from e


def _dropbox_ensure_token(settings: dict, log_fn) -> str | None:
    """Return a valid Dropbox access token, refreshing silently if expired.
    Updates settings in-place. Returns None if no token available.
    """
    token   = settings.get('dropbox_token', '').strip()
    refresh = settings.get('dropbox_refresh_token', '').strip()
    app_key = settings.get('dropbox_app_key', '').strip()
    if not token:
        return None
    # Quick probe — if 401, try refresh
    probe = urllib.request.Request(
        'https://api.dropboxapi.com/2/users/get_current_account',
        data=b'null',
        headers={'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'},
    )
    try:
        urllib.request.urlopen(probe, timeout=8)
        return token
    except urllib.error.HTTPError as e:
        if e.code == 401 and refresh and app_key:
            try:
                tokens = _dropbox_token_refresh(app_key, refresh)
                new_token = tokens.get('access_token', '')
                if new_token:
                    settings['dropbox_token']         = new_token
                    settings['dropbox_refresh_token'] = tokens.get('refresh_token', refresh)
                    save_settings(settings)
                    log_fn('dim', '  🔗 Dropbox token refreshed silently')
                    return new_token
            except Exception as exc:
                log_fn('warning', f'  ⚠  Dropbox token refresh failed: {exc}')
        elif e.code == 401:
            log_fn('warning', '  ⚠  Dropbox token expired — click Connect Dropbox to re-authenticate')
    except Exception:
        pass
    return token   # return original and let the API call fail with its own error


def run_dropbox_auth(app_key: str, log_fn, on_tokens) -> None:
    """PKCE OAuth flow for Dropbox. Runs in a background thread.
    Starts a local HTTP server to catch the redirect, then exchanges the
    code for access_token + refresh_token. Calls on_tokens(dict) on success.
    """
    import hashlib, base64, secrets, http.server, socketserver

    # Generate PKCE verifier + challenge
    verifier  = base64.urlsafe_b64encode(secrets.token_bytes(48)).rstrip(b'=').decode()
    challenge = base64.urlsafe_b64encode(
        hashlib.sha256(verifier.encode()).digest()
    ).rstrip(b'=').decode()

    # Find a free port
    with socketserver.TCPServer(('localhost', 0), None) as s:
        port = s.server_address[1]

    redirect_uri = f'http://localhost:{port}'
    auth_params  = urllib.parse.urlencode({
        'client_id':             app_key,
        'response_type':         'code',
        'redirect_uri':          redirect_uri,
        'token_access_type':     'offline',
        'code_challenge':        challenge,
        'code_challenge_method': 'S256',
    })
    auth_url = f'https://www.dropbox.com/oauth2/authorize?{auth_params}'

    log_fn('section', '━━━ DROPBOX AUTH ━━━')
    log_fn('info',    f'  Opening browser for Dropbox login…')
    log_fn('dim',     f'  If browser doesn\'t open: {auth_url}')
    try:
        webbrowser.open(auth_url)
    except Exception:
        pass

    # Local server to catch the redirect
    code_holder = [None]

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            params = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            code_holder[0] = params.get('code', [None])[0]
            self.send_response(200)
            self.send_header('Content-Type', 'text/html')
            self.end_headers()
            self.wfile.write(b'<html><body><h2>Authorised. You can close this tab.</h2></body></html>')
        def log_message(self, *args):
            pass  # suppress server log noise

    with socketserver.TCPServer(('localhost', port), Handler) as srv:
        srv.timeout = 120
        srv.handle_request()   # blocks until one request comes in

    code = code_holder[0]
    if not code:
        log_fn('error', '  ✗  Dropbox auth: no code received (timed out or cancelled)')
        return

    # Exchange code for tokens
    data = urllib.parse.urlencode({
        'code':          code,
        'grant_type':    'authorization_code',
        'client_id':     app_key,
        'redirect_uri':  redirect_uri,
        'code_verifier': verifier,
    }).encode()
    req = urllib.request.Request(
        'https://api.dropbox.com/oauth2/token',
        data=data, headers={'Content-Type': 'application/x-www-form-urlencoded'},
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            tokens = json.loads(r.read())
            if 'access_token' in tokens:
                log_fn('success', '  ✓  Dropbox connected successfully')
                on_tokens(tokens)
            else:
                log_fn('error', f'  ✗  Dropbox token exchange failed: {tokens}')
    except urllib.error.HTTPError as e:
        try:
            body = json.loads(e.read())
            log_fn('error', f'  ✗  Dropbox auth error: {body.get("error_description", body)}')
        except Exception:
            log_fn('error', f'  ✗  Dropbox token exchange: HTTP {e.code}')
    except Exception as e:
        log_fn('error', f'  ✗  Dropbox token exchange failed: {e}')


def _get_dropbox_namespace(token: str, log_fn=None) -> str | None:
    """Return the root namespace ID for this Dropbox account (needed for Business/team folders).
    Returns None if the account is personal or the call fails.
    """
    hdrs = {'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'}
    try:
        req = urllib.request.Request(
            'https://api.dropboxapi.com/2/users/get_current_account',
            data=b'null', headers=hdrs
        )
        with urllib.request.urlopen(req, timeout=10) as r:
            info = json.loads(r.read())
            root_info = info.get('root_info', {})
            tag = root_info.get('.tag', 'unknown')
            root_ns = root_info.get('root_namespace_id', '')
            home_ns = root_info.get('home_namespace_id', '')
            if log_fn:
                log_fn('dim', f'  🔑 Dropbox account type: {tag}, root_ns: {root_ns or "—"}, home_ns: {home_ns or "—"}')
            # Use root_ns when it differs from home_ns (Dropbox Business shared
            # root, even when tag is "user"). Without this header the API uses
            # the personal home namespace and can't find team folder files.
            if root_ns and root_ns != home_ns:
                return str(root_ns)
    except urllib.error.HTTPError as e:
        if log_fn:
            log_fn('warning', f'  ⚠  Dropbox account info failed: HTTP {e.code}')
    except Exception as e:
        if log_fn:
            log_fn('warning', f'  ⚠  Dropbox account info error: {e}')
    return None


def _get_dropbox_link(api_path: str, token: str, namespace_id: str = None) -> str:
    """Get or create a shared link for *api_path* using the Dropbox API v2.
    Returns the URL string, or raises RuntimeError with a descriptive message.
    namespace_id: Dropbox root namespace ID (required for Business/team folder paths).
    """
    hdrs = {'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'}
    if namespace_id:
        hdrs['Dropbox-API-Path-Root'] = json.dumps({'.tag': 'namespace_id', 'namespace_id': namespace_id})

    def _post(endpoint, payload):
        data = json.dumps(payload).encode()
        req  = urllib.request.Request(
            f'https://api.dropboxapi.com/2/{endpoint}',
            data=data, headers=hdrs
        )
        return urllib.request.urlopen(req, timeout=15)

    def _http_err_msg(e: urllib.error.HTTPError) -> str:
        try:
            body    = json.loads(e.read())
            summary = body.get('error_summary') or body.get('error', {}).get('.tag') or str(body)
            return f'HTTP {e.code} — {summary}'
        except Exception:
            return f'HTTP {e.code}'

    # Verify the file exists in Dropbox cloud before trying to share
    try:
        with _post('files/get_metadata', {'path': api_path}) as r:
            pass  # file exists, continue
    except urllib.error.HTTPError as e:
        try:
            body = json.loads(e.read())
        except Exception:
            raise RuntimeError(f'Metadata check failed: HTTP {e.code}') from e
        err_summary = body.get('error_summary', '')
        tag = body.get('error', {}).get('path', {}).get('.tag', '')
        if tag == 'not_found':
            raise RuntimeError(f'File not in Dropbox cloud namespace (path: {api_path}) — check selective sync or namespace settings')
        raise RuntimeError(f'Metadata check: HTTP {e.code} — {err_summary or body}') from e

    # Try to create a new shared link
    try:
        with _post('sharing/create_shared_link_with_settings',
                   {'path': api_path, 'settings': {}}) as r:
            url = json.loads(r.read()).get('url')
            if url:
                return url
            raise RuntimeError('API returned no URL')
    except urllib.error.HTTPError as e:
        try:
            body = json.loads(e.read())
        except Exception:
            raise RuntimeError(f'HTTP {e.code}') from e

        tag = body.get('error', {}).get('.tag', '')
        if tag == 'shared_link_already_exists':
            # Link already exists — retrieve it via list_shared_links
            try:
                with _post('sharing/list_shared_links',
                           {'path': api_path, 'direct_only': True}) as r2:
                    links = json.loads(r2.read()).get('links', [])
                    if links:
                        return links[0]['url']
                    raise RuntimeError('Link exists but list_shared_links returned nothing')
            except urllib.error.HTTPError as e2:
                raise RuntimeError(f'list_shared_links failed: HTTP {e2.code}') from e2
        else:
            summary = body.get('error_summary') or tag or str(body)
            raise RuntimeError(f'HTTP {e.code} — {summary}') from e
    except urllib.error.URLError as e:
        raise RuntimeError(f'Network error: {e.reason}') from e


# ── Core logic — Flat Export (OneDrive) ──────────────────────────────────────

def run_flat_export(source: Path, flat_target: Path, settings: dict,
                    log_fn, progress_fn, stop_event=None) -> dict:
    """Copy every file from every [03] OUT folder flat into flat_target.
    Files with colliding names get a _{n} suffix.
    """
    stats    = {'copied': 0, 'skipped': 0, 'errors': 0}
    out_name = settings['out_folder'].lower()
    log_fn('section', f'━━━ FLAT EXPORT — {datetime.now().strftime("%Y-%m-%d %H:%M:%S")} ━━━')
    log_fn('dim', f'  → {flat_target}')

    source_dirs = list(_iter_source_dirs(source, settings))

    if not source_dirs:
        log_fn('dim', f'  No {settings["out_folder"]} folders or publishable files found.')
        return stats

    flat_target.mkdir(parents=True, exist_ok=True)
    total = max(len(source_dirs), 1)
    live_dest_paths: set[Path] = set()

    for idx, (out_dir, _is_orphan) in enumerate(source_dirs):
        if stop_event and stop_event.is_set():
            log_fn('warning', '  ⊘  Stopped by user.')
            break
        try:
            direct_children = list(out_dir.iterdir())
        except Exception as e:
            log_fn('error', f'  ✗  Cannot read {out_dir}: {e}')
            stats['errors'] += 1
            progress_fn((idx + 1) / total)
            continue

        gallery_names = {
            item.name for item in direct_children
            if item.is_dir() and not item.name.startswith('.')
            and not _should_skip(item.name, settings) and _is_gallery_folder(item)
        }

        # Gallery folders → copy as named subfolders
        for gal in (item for item in direct_children if item.is_dir() and item.name in gallery_names):
            parsed    = _parse_asset_filename(gal.name)
            fmt_entry = _fmt_entry(parsed)
            translated_name = _translate_export_name(gal.name, '', parsed, fmt_entry).rstrip()
            dest_dir = flat_target / translated_name
            try:
                gallery_imgs = [
                    img for img in sorted(gal.rglob('*'), key=lambda p: str(p).lower())
                    if img.is_file() and not img.name.startswith('.')
                    and not _should_skip(img.name, settings)
                ]
            except PermissionError:
                gallery_imgs = []
            if not gallery_imgs:
                log_fn('dim', f'  ⊘  empty gallery — skipped: {translated_name}')
                continue
            live_dest_paths.add(dest_dir)
            log_fn('info', f'  🖼  gallery: {translated_name}')
            try:
                dest_dir.mkdir(parents=True, exist_ok=True)
                for img in gallery_imgs:
                    img_dest = dest_dir / img.relative_to(gal)
                    img_dest.parent.mkdir(parents=True, exist_ok=True)
                    if _is_unchanged(img, img_dest):
                        stats['skipped'] += 1
                    elif _is_sync_noise(img, img_dest):
                        stats['skipped'] += 1
                    elif _is_externally_modified(img, img_dest):
                        stats.setdefault('_sp_modified', []).append(img.name)
                        stats['skipped'] += 1
                    else:
                        shutil.copy2(img, img_dest)
                        stats['copied'] += 1
            except Exception as e:
                log_fn('error', f'  ✗  gallery copy failed {translated_name}: {e}')
                stats['errors'] += 1

        # Orphan dirs: only collect direct files (subdirs are yielded separately by _iter_source_dirs)
        _file_iter = out_dir.iterdir() if _is_orphan else out_dir.rglob('*')
        files = [f for f in _file_iter
                 if f.is_file() and '-thumb' not in f.stem
                 and not f.name.startswith('.')
                 and _is_publishable_file(f)
                 and not _should_skip_path(f.relative_to(out_dir).parts, settings)
                 and not any(part in gallery_names for part in f.relative_to(out_dir).parts)]

        for f in files:
            parsed = _parse_asset_filename(f.stem)
            fmt_entry = _fmt_entry(parsed)
            translated = _translate_export_name(f.stem, f.suffix, parsed, fmt_entry)
            dest = flat_target / translated
            live_dest_paths.add(dest)
            if _is_unchanged(f, dest):
                log_fn('dim', f'  ↷  unchanged: {translated}')
                stats['skipped'] += 1
                continue
            if _is_sync_noise(f, dest):
                log_fn('dim', f'  ↷  sync noise (skipped): {translated}')
                stats['skipped'] += 1
                continue
            if _is_externally_modified(f, dest):
                stats.setdefault('_sp_modified', []).append(translated)
                stats['skipped'] += 1
                continue
            if _is_version_conflict(f, dest):
                stats.setdefault('_conflicts', []).append(translated)
                stats['skipped'] += 1
                continue
            try:
                shutil.copy2(f, dest)
                log_fn('success', f'  ✓  {translated}')
                stats['copied'] += 1
            except Exception as e:
                log_fn('error', f'  ✗  {f.name}: {e}')
                stats['errors'] += 1

        progress_fn((idx + 1) / total)

    # Disconnected detection — rename orphaned files/folders with 🚫 prefix
    # Guard: only run when something was actually copied this run, same as run_publish.
    # Unconditional orphan detection caused every run to rename files to 🚫 even
    # when nothing changed, triggering massive OneDrive re-syncs.
    if stats['copied'] == 0:
        log_fn('dim', f'  ↷  orphan scan skipped — nothing copied this run')
    else:
        live_dest_nfc = {unicodedata.normalize('NFC', str(p)) for p in live_dest_paths}
        try:
            for existing in flat_target.iterdir():
                if existing.name.startswith('.') or existing.name.startswith('🚫'):
                    continue
                existing_nfc = unicodedata.normalize('NFC', str(existing))
                if existing_nfc not in live_dest_nfc:
                    flagged = existing.parent / ('🚫 ' + existing.name)
                    try:
                        existing.rename(flagged)
                        log_fn('disconnected', f'  🚫  Disconnected (renamed): {existing.name}')
                    except Exception as e:
                        log_fn('error', f'  ✗  Could not rename {existing.name}: {e}')
        except Exception:
            pass

    # ── Version conflict report ───────────────────────────────────────────────
    conflicts = stats.pop('_conflicts', [])
    if conflicts:
        log_fn('warning', f'  ⚠  VERSION CONFLICTS — {len(conflicts)} file(s) NOT overwritten '
               f'(same name, different size — bump the version number):')
        for name in conflicts:
            log_fn('warning', f'    ⚠  {name}')

    sp_modified = stats.pop('_sp_modified', [])
    if sp_modified:
        log_fn('warning', f'  ✏️  MODIFIED BY USER — {len(sp_modified)} file(s) were edited after last publish (not overwritten):')
        for name in sp_modified:
            log_fn('warning', f'    ☁  {name}')

    log_fn('section',
           f'━━━ FLAT EXPORT DONE — {stats["copied"]} copied · '
           f'{stats["skipped"]} unchanged · {len(conflicts)} conflicts · '
           f'{stats["errors"]} errors ━━━')
    return stats


# ── OneDrive / Microsoft Graph integration ───────────────────────────────────

def _onedrive_root(path: Path):
    """Return the OneDrive sync root found in path, or None.
    Handles macOS CloudStorage layouts: OneDrive-NAME, OneDrive-SharedLibraries-NAME.
    """
    for i, part in enumerate(path.parts):
        if part == 'OneDrive' or part.startswith('OneDrive-'):
            return Path(*path.parts[:i + 1])
    return None


def _onedrive_drive_path(local_path: Path, od_root: Path) -> str:
    """Convert a local OneDrive-synced path to a Graph API item path (/folder/file)."""
    return '/' + local_path.relative_to(od_root).as_posix()


def _get_onedrive_link(drive_path: str, token: str) -> str:
    """Create or retrieve a sharing link via Microsoft Graph API.
    Returns the URL string, or raises RuntimeError with a descriptive message.
    """
    encoded = urllib.parse.quote(drive_path)
    url  = f'https://graph.microsoft.com/v1.0/me/drive/root:{encoded}:/createLink'
    data = json.dumps({'type': 'view', 'scope': 'organization'}).encode()
    req  = urllib.request.Request(url, data=data, headers={
        'Authorization': f'Bearer {token}',
        'Content-Type': 'application/json',
    })
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            result   = json.loads(r.read())
            link_url = result.get('link', {}).get('webUrl')
            if link_url:
                return link_url
            raise RuntimeError('Graph API returned no webUrl')
    except urllib.error.HTTPError as e:
        try:
            body = json.loads(e.read())
            code = body.get('error', {}).get('code', '')
            msg  = body.get('error', {}).get('message', '')
            raise RuntimeError(f'HTTP {e.code} — {code}: {msg}') from e
        except (json.JSONDecodeError, KeyError):
            raise RuntimeError(f'HTTP {e.code}') from e
    except urllib.error.URLError as e:
        raise RuntimeError(f'Network error: {e.reason}') from e


def _onedrive_refresh(client_id: str, refresh_token: str, tenant: str = 'common') -> dict:
    """Exchange a refresh token for a new access token. Returns token dict."""
    data = urllib.parse.urlencode({
        'grant_type':    'refresh_token',
        'client_id':     client_id,
        'refresh_token': refresh_token,
        'scope':         'https://graph.microsoft.com/Files.ReadWrite offline_access',
    }).encode()
    req = urllib.request.Request(
        f'https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token',
        data=data, headers={'Content-Type': 'application/x-www-form-urlencoded'},
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        try:
            body = json.loads(e.read())
            raise RuntimeError(body.get('error_description') or body.get('error', f'HTTP {e.code}')) from e
        except (json.JSONDecodeError, KeyError):
            raise RuntimeError(f'HTTP {e.code}') from e


def _onedrive_ensure_token(settings: dict, log_fn) -> str | None:
    """Return a valid OneDrive access token, refreshing silently if needed.
    Updates settings in-place with the new token. Returns None if unavailable.
    """
    token   = settings.get('onedrive_token', '').strip()
    refresh = settings.get('onedrive_refresh_token', '').strip()
    cid     = settings.get('onedrive_client_id', '').strip()
    if not token:
        return None
    # Quick probe — if 401, try refresh
    probe = urllib.request.Request(
        'https://graph.microsoft.com/v1.0/me/drive',
        headers={'Authorization': f'Bearer {token}'},
    )
    try:
        urllib.request.urlopen(probe, timeout=8)
        return token
    except urllib.error.HTTPError as e:
        if e.code == 401 and refresh and cid:
            try:
                tokens = _onedrive_refresh(cid, refresh, settings.get('onedrive_tenant_id', 'common'))
                new_token = tokens.get('access_token', '')
                if new_token:
                    settings['onedrive_token']         = new_token
                    settings['onedrive_refresh_token'] = tokens.get('refresh_token', refresh)
                    save_settings(settings)
                    log_fn('dim', '  🔷 OneDrive token refreshed silently')
                    return new_token
            except Exception as exc:
                log_fn('warning', f'  ⚠  OneDrive token refresh failed: {exc}')
        elif e.code == 401:
            log_fn('warning', '  ⚠  OneDrive token expired — click Connect OneDrive to re-authenticate')
    except Exception:
        pass
    return None


def run_onedrive_auth(client_id: str, log_fn, on_tokens, tenant: str = 'common') -> None:
    """Device code OAuth flow for Microsoft Graph. Runs in a background thread.
    Calls on_tokens(dict) with access_token + refresh_token on success.
    tenant: use 'common' for multi-tenant, or your Directory (tenant) ID for single-tenant apps.
    """
    base = f'https://login.microsoftonline.com/{tenant}/oauth2/v2.0'
    data = urllib.parse.urlencode({
        'client_id': client_id,
        'scope':     'https://graph.microsoft.com/Files.ReadWrite offline_access',
    }).encode()
    req = urllib.request.Request(
        f'{base}/devicecode',
        data=data, headers={'Content-Type': 'application/x-www-form-urlencoded'},
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            dc = json.loads(r.read())
    except Exception as e:
        log_fn('error', f'  ✗  OneDrive auth failed: {e}')
        return

    log_fn('section', '━━━ ONEDRIVE AUTH ━━━')
    log_fn('info',    f'  1. Open: {dc["verification_uri"]}')
    log_fn('info',    f'  2. Enter code: {dc["user_code"]}')
    log_fn('dim',     f'  (expires in {dc.get("expires_in", 900)}s — opening browser…)')
    try:
        webbrowser.open(dc['verification_uri'])
    except Exception:
        pass

    interval   = dc.get('interval', 5)
    device_code = dc['device_code']
    expires_at = time.time() + dc.get('expires_in', 900)

    while time.time() < expires_at:
        time.sleep(interval)
        poll_data = urllib.parse.urlencode({
            'grant_type':  'urn:ietf:params:oauth:grant-type:device_code',
            'client_id':   client_id,
            'device_code': device_code,
        }).encode()
        poll_req = urllib.request.Request(
            f'{base}/token',
            data=poll_data,
            headers={'Content-Type': 'application/x-www-form-urlencoded'},
        )
        try:
            with urllib.request.urlopen(poll_req, timeout=15) as r:
                tokens = json.loads(r.read())
                if 'access_token' in tokens:
                    log_fn('success', '  ✓  OneDrive connected')
                    on_tokens(tokens)
                    return
        except urllib.error.HTTPError as e:
            try:
                body  = json.loads(e.read())
                error = body.get('error', '')
                if error == 'authorization_pending':
                    continue
                elif error == 'slow_down':
                    interval += 5
                    continue
                else:
                    log_fn('error', f'  ✗  OneDrive auth error: {error} — {body.get("error_description", "")}')
                    return
            except Exception:
                log_fn('error', f'  ✗  OneDrive poll error: HTTP {e.code}')
                return

    log_fn('warning', '  ⚠  OneDrive auth timed out — try again')


# ── OneDrive link update (post-sync) ─────────────────────────────────────────

def _inject_onedrive_into_note(note_path: Path, onedrive_url: str) -> bool:
    """Patch an existing note with the OneDrive link.
    Adds onedrive: to frontmatter and a link line + table row in the body.
    Returns True if the note was modified, False if already had the link.
    """
    content = note_path.read_text(encoding='utf-8')
    if 'onedrive:' in content:
        return False

    # Split on frontmatter delimiters
    parts = content.split('---', 2)
    if len(parts) < 3:
        return False
    _, fm, body = parts

    fm_patched = fm.rstrip() + f'\nonedrive: "{onedrive_url}"\n'

    # Insert link line in body: after last existing link line (Dropbox or thumb)
    # then also append row to the markdown table if one exists
    lines = body.split('\n')
    insert_after = -1
    for i, line in enumerate(lines):
        if line.startswith('[Open in Dropbox') or line.startswith('![[10 ATTACHMENTS'):
            insert_after = i

    od_line = f'[Open in OneDrive ↗]({onedrive_url})'
    if insert_after >= 0:
        lines.insert(insert_after + 1, od_line)
    else:
        # fallback: insert after heading
        for i, line in enumerate(lines):
            if line.startswith('# '):
                lines.insert(i + 1, od_line)
                break

    # Append row to table
    body_joined = '\n'.join(lines)
    table_row = f'| OneDrive | [↗ Open]({onedrive_url}) |'
    if '| Field | Value |' in body_joined:
        body_joined = body_joined.replace(
            '| Field | Value |',
            '| Field | Value |',   # no-op marker, real insert below
        )
        # Find last table row and append after it
        table_lines = body_joined.split('\n')
        last_row = -1
        for i, line in enumerate(table_lines):
            if line.startswith('| ') and line.endswith(' |'):
                last_row = i
        if last_row >= 0:
            table_lines.insert(last_row + 1, table_row)
            body_joined = '\n'.join(table_lines)

    note_path.write_text('---' + fm_patched + '---' + body_joined, encoding='utf-8')
    return True


def run_onedrive_link_update(flat_folder: Path, vault: Path, settings: dict,
                             log_fn, progress_fn, stop_event=None) -> dict:
    """Walk the flat OneDrive export folder, get sharing links, and inject them
    into matching notes under vault/05 DAM/01 EXPORTS.
    Matching is done by source: frontmatter field == filename in flat folder.
    """
    stats = {'updated': 0, 'skipped': 0, 'errors': 0}
    log_fn('section', f'━━━ ONEDRIVE LINKS — {datetime.now().strftime("%Y-%m-%d %H:%M:%S")} ━━━')
    log_fn('dim', f'  Flat folder: {flat_folder}')

    od_token = _onedrive_ensure_token(settings, log_fn)
    if not od_token:
        log_fn('warning', '  ⚠  No OneDrive token — connect OneDrive first.')
        return stats

    od_root = _onedrive_root(flat_folder)
    if not od_root:
        log_fn('warning', '  ⚠  Flat folder is not inside OneDrive sync root.')
        return stats

    log_fn('dim', f'  OneDrive root: {od_root}')

    # Index all notes by their export_name: field (translated filename without path)
    dam_root = vault / '05 DAM' / '01 EXPORTS'
    note_index: dict[str, Path] = {}
    if dam_root.exists():
        for note in dam_root.rglob('*.md'):
            try:
                text = note.read_text(encoding='utf-8')
                m = re.search(r'<!--\s*dam:export_name:"([^"]+)"\s*-->', text)
                if m:
                    note_index[m.group(1)] = note
            except Exception:
                pass
    log_fn('dim', f'  Indexed {len(note_index)} notes')

    try:
        files = [f for f in flat_folder.iterdir()
                 if f.is_file() and not f.name.startswith('.')]
    except Exception as e:
        log_fn('error', f'  ✗  Cannot read flat folder: {e}')
        return stats

    total = max(len(files), 1)
    for idx, f in enumerate(files):
        if stop_event and stop_event.is_set():
            log_fn('warning', '  ⊘  Stopped by user.')
            break

        note_path = note_index.get(f.name)
        if not note_path:
            log_fn('dim', f'  ○  no note for {f.name}')
            stats['skipped'] += 1
            progress_fn((idx + 1) / total)
            continue

        try:
            od_drive_path = _onedrive_drive_path(f, od_root)
            url = _get_onedrive_link(od_drive_path, od_token)
        except Exception as exc:
            log_fn('warning', f'  ⚠  {f.name}: {exc}')
            stats['errors'] += 1
            progress_fn((idx + 1) / total)
            continue

        try:
            if _inject_onedrive_into_note(note_path, url):
                log_fn('success', f'  ✓  {note_path.name}  🔷 {url}')
                stats['updated'] += 1
            else:
                log_fn('dim', f'  ↷ already linked: {note_path.name}')
                stats['skipped'] += 1
        except Exception as exc:
            log_fn('error', f'  ✗  Could not patch {note_path.name}: {exc}')
            stats['errors'] += 1

        progress_fn((idx + 1) / total)

    log_fn('section',
           f'━━━ ONEDRIVE LINKS DONE — {stats["updated"]} updated · '
           f'{stats["skipped"]} skipped · {stats["errors"]} errors ━━━')
    return stats


# ── Core logic — Obsidian Notes ───────────────────────────────────────────────

_VOCABULARY_CACHE: dict | None = None

def _load_vocabulary() -> dict:
    """Return shortcode → tag entry mapping, including legacy alias resolution.
    legacy_aliases in vocabulary.json maps old shortcodes (e.g. '_Rns', '±DIP')
    to their canonical v1.0 replacements. Old files on disk are parsed silently
    without warnings — no need to rename them immediately.
    """
    global _VOCABULARY_CACHE
    if _VOCABULARY_CACHE is None:
        try:
            p = Path(__file__).parent / 'vocabulary.json'
            with open(p, encoding='utf-8') as f:
                data = json.load(f)
            base = {t['shortcode']: t for t in data.get('tags', [])}
            for old_sc, new_sc in data.get('legacy_aliases', {}).items():
                if old_sc.startswith('_comment'):
                    continue
                if new_sc in base and old_sc not in base:
                    base[old_sc] = base[new_sc]
            _VOCABULARY_CACHE = base
        except Exception:
            _VOCABULARY_CACHE = {}
    return _VOCABULARY_CACHE

def _load_format_tags() -> dict:
    return {sc: e for sc, e in _load_vocabulary().items() if e.get('type') == 'format'}


def _parse_asset_filename(stem: str) -> dict:
    """Parse filename stem. Returns tags (matched), unknown_tags (not in vocab),
    description, version, yymm, error. error is only set if there are NO bracket tags."""
    r = {'tags': [], 'unknown_tags': [], 'description': None, 'version': None, 'yymm': None, 'error': None}
    # Match a leading run of either (\u2026) or [\u2026] groups (may be mixed on legacy files)
    lead = re.match(r'^(?:\([^)]+\)|\[[^\]]+\])+', stem)
    if not lead:
        r['error'] = 'No bracket tags at start of filename'
        return r

    # Extract inner content from both bracket styles
    raw_tags = re.findall(r'(?:\(([^)]+)\)|\[([^\]]+)\])', lead.group(0))
    raw_tags = [a or b for a, b in raw_tags]   # each tuple has one non-empty str
    vocab = _load_vocabulary()
    for tag in raw_tags:
        if re.fullmatch(r'\d{2}(0[1-9]|1[0-2])', tag):
            r['yymm'] = tag
            continue
        entry = vocab.get(tag)
        if entry:
            r['tags'].append(entry)
        else:
            r['unknown_tags'].append(tag)
    rest = stem[lead.end():]
    ver_m = re.search(r'\b[vV]\d+(?:[-._]\d+)*\b', rest)
    if ver_m:
        raw_ver = ver_m.group(0)
        r['version'] = 'v' + re.sub(r'[._]', '-', raw_ver[1:])
    desc_part = (rest[:ver_m.start()] if ver_m else rest).strip()
    if desc_part:
        r['description'] = desc_part.strip(' _-')
    return r


def _fmt_entry(parsed: dict) -> dict | None:
    """Return the first format-slot tag entry from a parsed result, or None.
    Checks 'slot' (v1.0 schema) with fallback to legacy 'type' field.
    """
    for t in parsed.get('tags', []):
        if t.get('slot') == 'format' or t.get('type') == 'format':
            return t
    return None


def _build_note_name(parsed: dict, fmt_entry=None) -> str:
    parts = [t['label'] for t in parsed.get('tags', [])]
    parts += [f'[{u}]' for u in parsed.get('unknown_tags', [])]
    name = ' '.join(parts) if parts else '(Untagged)'
    if parsed.get('description'):
        name += f' — {parsed["description"]}'
    return re.sub(r'\s+', ' ', name).strip()


def _translate_export_name(stem: str, ext: str, parsed: dict, fmt_entry=None) -> str:
    if parsed.get('error') and not parsed.get('tags') and not parsed.get('unknown_tags'):
        return f'{stem}{ext}'
    parts = [t['label'] for t in parsed.get('tags', [])]
    parts += [f'[{u}]' for u in parsed.get('unknown_tags', [])]
    name = ' '.join(parts) if parts else stem
    if parsed.get('description'):
        name += f' — {parsed["description"]}'
    if parsed.get('version'):
        name += f' {parsed["version"]}'
    name = re.sub(r'\s+', ' ', name).strip()
    if parsed.get('yymm'):
        name = f'{parsed["yymm"]} {name}'
    return name + ext


def _make_note(parsed: dict, fmt_entry, thumb_name, source_file: str,
               export_name: str = None, dropbox_url: str = None,
               onedrive_url: str = None, dropbox_path: str = None,
               source_path: str = None) -> str:
    today = datetime.now().strftime('%Y-%m-%d')
    thumb_section    = f'![[10 ATTACHMENTS/{thumb_name}]]\n\n' if thumb_name else ''
    dropbox_section  = f'[Open in Dropbox ↗]({dropbox_url})\n\n' if dropbox_url else ''
    onedrive_section = f'[Open in OneDrive ↗]({onedrive_url})\n\n' if onedrive_url else ''

    fmt_e   = _fmt_entry(parsed)
    icon    = next((t['icon'] for t in parsed.get('tags', []) if t.get('icon')), '')
    name    = _build_note_name(parsed, fmt_e)

    # Obsidian inline tags from all matched vocab entries + dam
    obs_tags = [t['obsidian_tag'].split('/')[-1] for t in parsed.get('tags', [])]
    obs_tags.append('dam')
    has_issues = bool(parsed.get('error') or parsed.get('unknown_tags'))
    if has_issues:
        obs_tags.append('dam/incomplete')
    inline_tags = ' '.join(f'#{t}' for t in obs_tags)

    # Frontmatter
    fm_extra = ''

    # Hidden meta comments
    meta_comments = ''
    if parsed.get('version'):
        meta_comments += f'<!-- dam:version:"{parsed["version"]}" -->\n'
    if export_name:
        meta_comments += f'<!-- dam:export_name:"{export_name}" -->\n'
    if dropbox_url:
        meta_comments += f'<!-- dam:dropbox:"{dropbox_url}" -->\n'
    if onedrive_url:
        meta_comments += f'<!-- dam:onedrive:"{onedrive_url}" -->\n'
    if source_path:
        meta_comments += f'<!-- dam:source_path:"{source_path}" -->\n'

    source_display = dropbox_path if dropbox_path else source_file
    rows = []
    rows.append(('Version', parsed.get('version') or '---'))
    rows.append(('Created', today))
    if parsed.get('yymm'):
        rows.append(('Year / Month', parsed['yymm']))
    if dropbox_url:
        rows.append(('Dropbox', f'[↗ Open]({dropbox_url})'))
    if onedrive_url:
        rows.append(('OneDrive', f'[↗ Open]({onedrive_url})'))
    rows.append(('Source', f'`{source_display}`'))
    if export_name:
        rows.append(('Export name', f'`{export_name}`'))
    for t in parsed.get('tags', []):
        rows.append((t.get('type', 'tag').capitalize(), f'{t.get("icon", "")} {t["label"]}'.strip()))
    if parsed.get('description'):
        rows.append(('Description', parsed['description']))

    table = ('| Field | Value |\n| --- | --- |\n'
             + '\n'.join(f'| {k} | {v} |' for k, v in rows))

    fm_block = f'---\n{fm_extra.lstrip()}\n---\n\n' if fm_extra.strip() else '---\n---\n\n'

    # Warning block at the BOTTOM (not top) — doesn't uglify the canvas preview
    warning_block = ''
    if parsed.get('error'):
        warning_block = (
            f'\n> [!warning] Filename has no bracket tags\n'
            f'> **File:** `{source_file}`  \n'
            f'> Please rename using `(Entity)(Angle)(Format)` convention.\n'
        )
    elif parsed.get('unknown_tags'):
        tags_str = ', '.join(f'[{t}]' for t in parsed['unknown_tags'])
        warning_block = (
            f'\n> [!note] Unknown tags skipped: {tags_str}\n'
            f'> These shortcodes are not in the vocabulary. Add them to vocabulary.json if needed.\n'
        )

    return (
        f'{fm_block}'
        f'{thumb_section}{inline_tags}\n\n'
        f'{table}\n\n'
        f'{meta_comments}'
        f'{warning_block}'
        f'\n#### Notes\n\n'
    )


def _patch_note(note_path: Path, parsed: dict, thumb_name: str,
                dropbox_url: str, export_name: str,
                source_path: str = None) -> bool:
    """Update version, dropbox link, export_name and thumbnail in an existing note.
    Never touches the body text written by the user.
    Returns True if any change was made.
    """
    content = note_path.read_text(encoding='utf-8')
    parts = content.split('---', 2)
    if len(parts) < 3:
        return False
    _, fm, body = parts

    changed = False

    def _comment_set(text, key, value):
        """Update or append a <!-- dam:key:"value" --> comment in the body."""
        pattern = rf'<!--\s*dam:{re.escape(key)}:"([^"]*)"\s*-->'
        existing = re.search(pattern, text)
        if existing:
            if existing.group(1) == value:
                return text, False
            new = re.sub(pattern, f'<!-- dam:{key}:"{value}" -->', text)
            return new, True
        return text + f'<!-- dam:{key}:"{value}" -->\n', True

    if parsed.get('version'):
        body, c = _comment_set(body, 'version', parsed['version'])
        changed = changed or c
    if dropbox_url:
        body, c = _comment_set(body, 'dropbox', dropbox_url)
        changed = changed or c
    if export_name:
        body, c = _comment_set(body, 'export_name', export_name)
        changed = changed or c
    if source_path:
        body, c = _comment_set(body, 'source_path', source_path)
        changed = changed or c

    # Update thumbnail wikilink in body if a new thumb exists and it differs
    if thumb_name:
        new_thumb = f'![[10 ATTACHMENTS/{thumb_name}]]'
        new_body, n = re.subn(
            r'!\[\[10 ATTACHMENTS/[^\]]+\]\]',
            new_thumb,
            body
        )
        if n and new_body != body:
            body = new_body
            changed = True

    if changed:
        note_path.write_text('---' + fm + '---' + body, encoding='utf-8')
    return changed


def _flag_disconnected_note(note_path: Path) -> None:
    """Add #disconnected inline tag to the note body if not already present."""
    content = note_path.read_text(encoding='utf-8')
    if '#disconnected' in content.lower():
        return
    # Append inline tag at the end
    note_path.write_text(content.rstrip() + '\n#disconnected\n', encoding='utf-8')


# ── Obsidian Canvas helpers ───────────────────────────────────────────────────
# Card dimensions: 480 × 540, on Obsidian 20px grid, portrait orientation
CANVAS_W   = 480
CANVAS_H   = 540
CANVAS_GAP = 40


def _canvas_cols_from_name(stem: str, default: int = 3) -> int:
    """Read column count from canvas filename stem '_X Title -cN' → N."""
    m = re.search(r'-c(\d+)', stem)
    return int(m.group(1)) if m else default


def _canvas_source_path(note: Path) -> tuple:
    """Read dam:source_path from a note. Returns a tuple of path parts for sorting."""
    try:
        text = note.read_text(encoding='utf-8')
        m = re.search(r'<!--\s*dam:source_path:"([^"]*)"\s*-->', text)
        if m and m.group(1):
            return tuple(m.group(1).split('/'))
    except Exception:
        pass
    return ()


def _update_dam_canvas(folder: Path, vault: Path, log_fn,
                       source_map: dict | None = None,
                       canvas_label: str | None = None) -> None:
    """Create or update the Obsidian canvas for all notes directly in folder.

    source_map: {note_path: source_path_tuple} built during the current run.
    Each unique source_path is its own cluster placed left-to-right.
    Gap between adjacent clusters scales with how high their paths diverge.
    Falls back to reading <!-- dam:source_path --> from note files if not provided.
    """
    # Find existing canvas (starts with '_X ')
    existing_canvas = None
    cols = 3
    try:
        for f in folder.iterdir():
            if f.suffix == '.canvas' and f.stem.startswith('_X '):
                existing_canvas = f
                cols = _canvas_cols_from_name(f.stem)
                break
    except PermissionError:
        return

    # Derive a clean canvas label: use explicit override, otherwise strip [n] prefix.
    if canvas_label:
        _canvas_name = canvas_label
    else:
        _canvas_name = re.sub(r'^\[\d+\]\s*', '', folder.name) or folder.name
    canvas_path = existing_canvas if existing_canvas else folder / f'_X {_canvas_name} -c3.canvas'

    # Collect current non-disconnected notes directly in this folder
    try:
        raw_notes = [f for f in folder.iterdir()
                     if f.is_file() and f.suffix == '.md' and not f.name.startswith('🚫')]
    except PermissionError:
        return

    if not raw_notes:
        return

    # Attach (cluster_key, sort_key) per note.
    # Live run map stores (cluster_key, sort_key); legacy file fallback returns
    # a plain tuple which we use as both (old behaviour).
    def _get_src(note: Path) -> tuple[tuple, tuple]:
        if source_map and note in source_map:
            val = source_map[note]
            if val and isinstance(val[0], tuple):
                return val          # new format: (cluster_key, sort_key)
            return (val, val)       # old format: plain tuple → use as both
        plain = _canvas_source_path(note)
        return (plain, plain)

    notes_with_src = [(n, _get_src(n)) for n in raw_notes]

    # Load existing canvas — preserve non-note nodes and edges
    preserved_nodes = []
    edges = []
    vault_rel_folder = folder.relative_to(vault).as_posix()
    if canvas_path.exists():
        try:
            data = json.loads(canvas_path.read_text(encoding='utf-8'))
            edges = data.get('edges', [])
            for node in data.get('nodes', []):
                if node.get('type') == 'file':
                    nf_folder = '/'.join(node.get('file', '').split('/')[:-1])
                    if nf_folder != vault_rel_folder:
                        preserved_nodes.append(node)
                else:
                    preserved_nodes.append(node)
        except Exception:
            pass

    # ── Hierarchical cluster layout ───────────────────────────────────────────
    # Cluster key = full source_path tuple.
    # Every unique source folder is its own cluster (placed left-to-right).
    # Gap between adjacent clusters scales with how high up the tree they diverge:
    #   same parent → gap_level=1, different grandparent → gap_level=2, etc.
    # Notes without a source_path (legacy) share key=() → one cluster on the left.

    cell_w      = CANVAS_W + CANVAS_GAP
    cell_h      = CANVAS_H + CANVAS_GAP
    BASE_H_GAP  = 150   # horizontal gap per divergence level (px)

    def _path_sort_key(parts: tuple) -> tuple:
        """Sort path components numerically on [n] prefix, then alphabetically."""
        def _part_key(p: str):
            m = re.match(r'^\[(\d+)\]', p)
            return (int(m.group(1)), p.lower()) if m else (9999, p.lower())
        return tuple(_part_key(p) for p in parts)

    # Sort: primary = cluster_key (siblings share a cluster), secondary = sort_key
    # (full path, preserves [n] order within cluster), tertiary = note filename.
    notes_with_src.sort(key=lambda ns: (
        _path_sort_key(ns[1][0]),   # cluster_key
        _path_sort_key(ns[1][1]),   # sort_key (full path)
        ns[0].name.lower()
    ))

    # Group into clusters by cluster_key — store (note, sort_key) pairs
    clusters: list[tuple[tuple, list]] = []
    for note, (c_key, s_key) in notes_with_src:
        if clusters and clusters[-1][0] == c_key:
            clusters[-1][1].append((note, s_key))
        else:
            clusters.append((c_key, [(note, s_key)]))

    # Sort clusters: direct-children cluster () always first, then by [n] number
    def _cluster_order(c: tuple) -> tuple:
        key = c[0]
        if not key:                          # () = direct scope children → first
            return (0, ())
        return (1, _path_sort_key(key))

    clusters.sort(key=_cluster_order)

    note_nodes  = []
    x_cursor    = 0
    prev_key: tuple | None = None

    prev_cluster_cols = cols   # actual columns used by the previous cluster

    for cluster_key, cluster_note_skeys in clusters:
        # ── Horizontal gap before this cluster ────────────────────────────────
        if prev_key is not None:
            common = 0
            for a, b in zip(prev_key, cluster_key):
                if a == b:
                    common += 1
                else:
                    break
            max_depth = max(len(prev_key), len(cluster_key), 1)
            gap_level = max_depth - common      # ≥1 when paths diverge
            h_gap     = BASE_H_GAP * gap_level
            # Advance by actual width of previous cluster, not a fixed cols width
            x_cursor += prev_cluster_cols * cell_w + h_gap

        # ── Column assignment: multi-asset out_dirs get dedicated columns ─────
        # Group notes by sort_key (= project folder / out_dir)
        sk_groups: dict[tuple, list] = {}
        for note, sk in cluster_note_skeys:
            sk_groups.setdefault(sk, []).append(note)

        sorted_sks = sorted(sk_groups.keys(), key=_path_sort_key)
        has_multi  = any(len(sk_groups[sk]) >= 2 for sk in sorted_sks)

        if not has_multi:
            # Standard wrap layout: pack notes across `cols` columns
            cluster_notes = [note for note, _ in cluster_note_skeys]
            prev_cluster_cols = min(len(cluster_notes), cols)
            for i, note in enumerate(cluster_notes):
                col = i % cols
                row = i // cols
                x = x_cursor + col * cell_w
                y = row * cell_h
                vault_rel = note.relative_to(vault).as_posix()
                node_id   = hashlib.md5(vault_rel.encode()).hexdigest()[:16]
                note_nodes.append({
                    'id': node_id, 'type': 'file', 'file': vault_rel,
                    'x': x, 'y': y, 'width': CANVAS_W, 'height': CANVAS_H,
                })
        else:
            # Mixed layout: multi-asset out_dirs get a dedicated column each;
            # single-asset out_dirs share one column (inserted at first-single position).
            col_assignments: dict[tuple, int] = {}
            col_counter = 0
            singles_col: int | None = None
            for sk in sorted_sks:
                if len(sk_groups[sk]) >= 2:
                    col_assignments[sk] = col_counter
                    col_counter += 1
                else:
                    if singles_col is None:
                        singles_col = col_counter
                        col_counter += 1
                    col_assignments[sk] = singles_col

            total_cols = col_counter
            prev_cluster_cols = total_cols
            col_row = [0] * total_cols

            for note, sk in cluster_note_skeys:
                assigned_col = col_assignments[sk]
                row = col_row[assigned_col]
                col_row[assigned_col] += 1
                x = x_cursor + assigned_col * cell_w
                y = row * cell_h
                vault_rel = note.relative_to(vault).as_posix()
                node_id   = hashlib.md5(vault_rel.encode()).hexdigest()[:16]
                note_nodes.append({
                    'id': node_id, 'type': 'file', 'file': vault_rel,
                    'x': x, 'y': y, 'width': CANVAS_W, 'height': CANVAS_H,
                })

        prev_key = cluster_key

    canvas_data = {'nodes': preserved_nodes + note_nodes, 'edges': edges}
    try:
        canvas_path.write_text(
            json.dumps(canvas_data, indent=2, ensure_ascii=False),
            encoding='utf-8'
        )
        log_fn('success', f'  🗺  canvas: {canvas_path.relative_to(vault)}')
    except Exception as e:
        log_fn('error', f'  ✗  Canvas write failed: {e}')


def run_obsidian_notes(source: Path, vault: Path, settings: dict,
                       log_fn, progress_fn, stop_event=None) -> dict:
    stats    = {'notes': 0, 'note_thumbs': 0, 'errors': 0}
    out_name = settings['out_folder'].lower()
    dam_root = vault / '05 DAM' / '01 EXPORTS'
    att_root = vault / '10 ATTACHMENTS'

    token   = _dropbox_ensure_token(settings, log_fn) if settings.get('dropbox_token') else None
    db_root = _dropbox_root(source) if token else None
    if token and not db_root:
        log_fn('warning', '  ⚠  Dropbox token set but source is not inside a Dropbox folder — links skipped.')

    namespace_id = None
    if token and db_root:
        namespace_id = _get_dropbox_namespace(token, log_fn)

    log_fn('section', f'━━━ OBSIDIAN — {datetime.now().strftime("%Y-%m-%d %H:%M:%S")} ━━━')
    log_fn('dim', f'  → {vault}')
    if token and db_root:
        ns_label = f' (namespace: {namespace_id})' if namespace_id else ' (personal namespace)'
        log_fn('dim', f'  🔗 Dropbox root: {db_root}{ns_label}')
    log_fn('dim', '  💡 OneDrive links: run "Update OneDrive Links" after files have synced.')

    # Each scope anchor (folder directly containing a [00] 📦 package folder) defines
    # one canvas. proj_rel is the cluster key within that canvas.
    # Content with no package ancestor goes to the root canvas (note_base = dam_root).
    anchors = _find_all_package_anchors(source, settings)

    out_dirs = []
    for sd, is_orphan in _iter_source_dirs(source, settings):
        proj_dir = sd.parent if not is_orphan else sd
        scope = _scope_for(proj_dir, anchors)
        if scope:
            note_base = dam_root / scope.name
            proj_rel = proj_dir.relative_to(scope)
        else:
            note_base = dam_root
            proj_rel = proj_dir.relative_to(source)
        # Unified cluster key: parts[:min(n-1, 2)]
        #   n=1 → ()              direct scope/source child
        #   n=2 → parts[:1]       first grouping level  (ESS PORTFOLIO, Account Based…)
        #   n≥3 → parts[:2]       sub-grouping level    (ESS PORTFOLIO+ALSIM, ESS PORTFOLIO+Intro…)
        # Works at every canvas level without a hard-coded std_depth.
        n = len(proj_rel.parts)
        cluster_key = tuple(proj_rel.parts[:min(n - 1, 2)])
        sort_key = tuple(proj_rel.parts)
        out_dirs.append((sd, is_orphan, note_base, proj_rel, cluster_key, sort_key))

    if not out_dirs:
        log_fn('dim', f'  No {settings["out_folder"]} folders or publishable files found.')
        return stats

    log_fn('info', f'  Found {len(out_dirs)} output folder(s)')
    total = max(len(out_dirs), 1)

    # Track every note path that is still live (matched a source file this run)
    live_note_paths: set[Path] = set()
    # Map note_path → source_path tuple for canvas clustering (avoids reading files)
    note_source_map: dict[Path, tuple] = {}

    for idx, (out_dir, is_orphan, note_base, proj_rel, cluster_key, sort_key) in enumerate(out_dirs):
        if stop_event and stop_event.is_set():
            log_fn('warning', '  ⊘  Stopped by user.')
            break

        log_fn('info', f'  📁 {proj_rel}')

        try:
            direct_children = list(out_dir.iterdir())
        except Exception as e:
            log_fn('error', f'  ✗  Cannot read {out_dir.name}: {e}')
            stats['errors'] += 1
            progress_fn((idx + 1) / total)
            continue

        gallery_names = {
            item.name for item in direct_children
            if item.is_dir() and not item.name.startswith('.')
            and not _should_skip(item.name, settings) and _is_gallery_folder(item)
        }

        # ── Gallery folders ───────────────────────────────────────────────────
        for gal_dir in (item for item in direct_children
                        if item.is_dir() and item.name in gallery_names):
            gal_parsed    = _parse_asset_filename(gal_dir.name)
            gal_fmt_entry = _fmt_entry(gal_parsed)

            if gal_parsed.get('error'):
                log_fn('warning', f'    ⚠  {gal_dir.name}: {gal_parsed["error"]}')

            note_title   = _build_note_name(gal_parsed, gal_fmt_entry)
            gal_icon     = next((t['icon'] for t in gal_parsed.get('tags', []) if t.get('icon')), '')
            safe_title   = re.sub(r'[<>:"/\\|?*]', '-', note_title)
            note_path    = note_base / f'{(gal_icon + " ") if gal_icon else ""}{safe_title}.md'
            export_name  = _translate_export_name(gal_dir.name, '', gal_parsed, gal_fmt_entry).rstrip()
            live_note_paths.add(note_path)
            note_source_map[note_path] = (cluster_key, sort_key)

            # Fast-skip: gallery folder unchanged since last note write
            if _note_is_fresh(gal_dir.stat().st_mtime, note_path, bool(token and db_root)):
                log_fn('dim', f'    ↷  unchanged: {note_path.name}')
                continue

            # Thumbnail — first thumbnable direct file (image/PDF/PPTX) alphabetically
            thumb_name = None
            first_src  = _gallery_first_thumbnable(gal_dir)
            if first_src:
                translated_thumb = safe_title + '-thumb.webp'
                dest_thumb = att_root / translated_thumb
                width   = settings.get('thumb_width', '320')
                quality = settings.get('thumb_quality', '70')
                try:
                    att_root.mkdir(parents=True, exist_ok=True)
                    ext = first_src.suffix.lower()
                    if ext == '.pdf':
                        ok = _pdf_to_thumb(first_src, dest_thumb, log_fn, width, quality)
                    elif ext in {'.pptx', '.pptm', '.ppt'}:
                        ok = _pptx_to_thumb(first_src, dest_thumb, log_fn, width, quality)
                    else:
                        ok = _image_to_thumb(first_src, dest_thumb, log_fn, width, quality)
                    if ok:
                        thumb_name = translated_thumb
                        stats['note_thumbs'] += 1
                except Exception as e:
                    log_fn('error', f'    ✗  Gallery thumb failed: {e}')

            # Dropbox link → folder
            gal_dropbox_url = None
            if token and db_root:
                cached_url = None
                if note_path.exists() and gal_parsed.get('version'):
                    try:
                        note_text = note_path.read_text(encoding='utf-8')
                        vm = re.search(r'<!--\s*dam:version:"([^"]+)"\s*-->', note_text)
                        dm = re.search(r'<!--\s*dam:dropbox:"([^"]+)"\s*-->', note_text)
                        if vm and dm and vm.group(1) == gal_parsed['version']:
                            cached_url = dm.group(1)
                    except Exception:
                        pass
                if cached_url:
                    gal_dropbox_url = cached_url
                    log_fn('dim', f'    ↷  Dropbox link reused (version unchanged)')
                else:
                    try:
                        api_path = _dropbox_api_path(gal_dir, db_root)
                        gal_dropbox_url = _get_dropbox_link(api_path, token, namespace_id)
                        if gal_dropbox_url:
                            log_fn('dim', f'    🔗 {gal_dropbox_url}')
                    except Exception as exc:
                        log_fn('warning', f'    ⚠  Dropbox error: {exc}')

            if note_path.exists():
                try:
                    patched = _patch_note(note_path, gal_parsed, thumb_name, gal_dropbox_url, export_name,
                                          source_path=proj_rel.as_posix())
                    if patched:
                        log_fn('success', f'    ↑  updated: {note_path.name}')
                        stats['notes'] += 1
                    else:
                        log_fn('dim', f'    ↷  unchanged: {note_path.name}')
                except Exception as e:
                    log_fn('error', f'    ✗  Patch failed: {e}')
                    stats['errors'] += 1
            else:
                gal_db_path = _dropbox_api_path(gal_dir, db_root) if (token and db_root) else None
                content = _make_note(gal_parsed, gal_fmt_entry, thumb_name, gal_dir.name,
                                     export_name, gal_dropbox_url, dropbox_path=gal_db_path,
                                     source_path=proj_rel.as_posix())
                try:
                    note_base.mkdir(parents=True, exist_ok=True)
                    note_path.write_text(content, encoding='utf-8')
                    log_fn('success', f'    ✓  gallery note: {note_path.name}')
                    stats['notes'] += 1
                except Exception as e:
                    log_fn('error', f'    ✗  Note write failed: {e}')
                    stats['errors'] += 1

        # ── Regular files ─────────────────────────────────────────────────────
        # Orphan dirs: only collect direct files — subdirs are visited separately
        _asset_iter = out_dir.iterdir() if is_orphan else out_dir.rglob('*')
        assets = [f for f in _asset_iter
                  if f.is_file() and '-thumb' not in f.stem
                  and not f.name.startswith('.')
                  and _is_publishable_file(f)
                  and not _should_skip_path(f.relative_to(out_dir).parts, settings)
                  and not any(part in gallery_names for part in f.relative_to(out_dir).parts)]

        # ── WIP placeholder — empty [03] OUT, non-orphan only ─────────────────
        if not assets and not gallery_names and not is_orphan:
            folder_name = re.sub(r'^\[\d+\]\s*', '', out_dir.parent.name) or out_dir.parent.name
            safe_name   = re.sub(r'[<>:"/\\|?*]', '-', folder_name)
            wip_path    = note_base / f'⏳ {safe_name}.md'
            live_note_paths.add(wip_path)
            note_source_map[wip_path] = (cluster_key, sort_key)
            if not wip_path.exists():
                today = datetime.now().strftime('%Y-%m-%d')
                wip_content = (
                    f'---\n---\n\n'
                    f'#dam #dam/wip\n\n'
                    f'| Field | Value |\n| --- | --- |\n'
                    f'| Status | ⏳ Work in Progress |\n'
                    f'| Updated | {today} |\n'
                    f'<!-- dam:source_path:"{proj_rel.as_posix()}" -->\n'
                    f'\n#### Notes\n\n'
                )
                try:
                    note_base.mkdir(parents=True, exist_ok=True)
                    wip_path.write_text(wip_content, encoding='utf-8')
                    log_fn('info', f'    ⏳  WIP note: {wip_path.name}')
                    stats['notes'] += 1
                except Exception as e:
                    log_fn('error', f'    ✗  WIP note failed: {e}')
                    stats['errors'] += 1

        for asset in assets:
            stem       = asset.stem
            rel_in_out = asset.relative_to(out_dir).parent
            note_dir   = note_base
            for part in rel_in_out.parts:
                note_dir = note_dir / part

            parsed    = _parse_asset_filename(stem)
            fmt_entry = _fmt_entry(parsed)

            if parsed.get('error'):
                log_fn('warning', f'    ⚠  {asset.name}: {parsed["error"]}')
            elif parsed.get('unknown_tags'):
                log_fn('warning', f'    ⚠  {asset.name}: unknown tags {parsed["unknown_tags"]}')

            note_title = _build_note_name(parsed, fmt_entry)
            note_icon   = next((t['icon'] for t in parsed.get('tags', []) if t.get('icon')), '')
            safe_title  = re.sub(r'[<>:"/\\|?*]', '-', note_title)
            note_path   = note_dir / f'{(note_icon + " ") if note_icon else ""}{safe_title}.md'
            export_name = _translate_export_name(stem, asset.suffix, parsed, fmt_entry)

            live_note_paths.add(note_path)
            note_source_map[note_path] = (cluster_key, sort_key)

            # Fast-skip: source unchanged since last note write
            if _note_is_fresh(asset.stat().st_mtime, note_path, bool(token and db_root)):
                log_fn('dim', f'    ↷  unchanged: {note_path.name}')
                continue

            # ── Thumbnail ─────────────────────────────────────────────────────
            thumb_file = asset.parent / f'{stem}-thumb.webp'
            thumb_name = None
            if thumb_file.exists():
                translated_thumb = re.sub(r'[<>:"/\\|?*]', '-', note_title) + '-thumb.webp'
                dest_thumb = att_root / translated_thumb
                try:
                    att_root.mkdir(parents=True, exist_ok=True)
                    if not _is_unchanged(thumb_file, dest_thumb):
                        shutil.copy2(thumb_file, dest_thumb)
                        log_fn('success', f'    ✓  thumb → {translated_thumb}')
                        stats['note_thumbs'] += 1
                    thumb_name = translated_thumb
                except Exception as e:
                    log_fn('error', f'    ✗  Thumb copy failed: {e}')
                    stats['errors'] += 1

            # ── Dropbox shared link ───────────────────────────────────────────
            dropbox_url = None
            if token and db_root:
                # Reuse cached link if the note exists with the same version
                cached_url = None
                if note_path.exists() and parsed.get('version'):
                    try:
                        note_text = note_path.read_text(encoding='utf-8')
                        vm = re.search(r'<!--\s*dam:version:"([^"]+)"\s*-->', note_text)
                        dm = re.search(r'<!--\s*dam:dropbox:"([^"]+)"\s*-->', note_text)
                        if vm and dm and vm.group(1) == parsed['version']:
                            cached_url = dm.group(1)
                    except Exception:
                        pass
                if cached_url:
                    dropbox_url = cached_url
                    log_fn('dim', f'    ↷  Dropbox link reused (version unchanged)')
                else:
                    try:
                        api_path    = _dropbox_api_path(asset, db_root)
                        log_fn('dim', f'    📂 Dropbox path: {api_path}')
                        dropbox_url = _get_dropbox_link(api_path, token, namespace_id)
                        if dropbox_url:
                            log_fn('dim', f'    🔗 {dropbox_url}')
                        else:
                            log_fn('warning', f'    ⚠  Dropbox link not obtained for {asset.name}')
                    except Exception as exc:
                        log_fn('warning', f'    ⚠  Dropbox error: {exc}')

            # ── Note: create new or patch existing ───────────────────────────
            if note_path.exists():
                try:
                    patched = _patch_note(note_path, parsed, thumb_name, dropbox_url, export_name,
                                          source_path=proj_rel.as_posix())
                    if patched:
                        log_fn('success', f'    ↑  updated: {note_path.name}')
                        stats['notes'] += 1
                    else:
                        log_fn('dim', f'    ↷  unchanged: {note_path.name}')
                except Exception as e:
                    log_fn('error', f'    ✗  Patch failed: {e}')
                    stats['errors'] += 1
            else:
                db_path = _dropbox_api_path(asset, db_root) if (token and db_root) else None
                content = _make_note(parsed, fmt_entry, thumb_name, asset.name,
                                     export_name, dropbox_url, dropbox_path=db_path,
                                     source_path=proj_rel.as_posix())
                try:
                    note_dir.mkdir(parents=True, exist_ok=True)
                    note_path.write_text(content, encoding='utf-8')
                    log_fn('success', f'    ✓  {note_path.name}')
                    stats['notes'] += 1
                except Exception as e:
                    log_fn('error', f'    ✗  Note write failed: {e}')
                    stats['errors'] += 1

        progress_fn((idx + 1) / total)

    # ── Disconnected note detection ───────────────────────────────────────────
    if dam_root.exists() and not (stop_event and stop_event.is_set()):
        for existing_note in dam_root.rglob('*.md'):
            if existing_note.name.startswith('🚫'):
                continue
            if existing_note not in live_note_paths:
                flagged = existing_note.parent / f'🚫 {existing_note.name}'
                log_fn('disconnected', f'  🚫 DISCONNECTED: {existing_note.relative_to(dam_root)}')
                try:
                    _flag_disconnected_note(existing_note)
                except Exception as e:
                    log_fn('error', f'  ✗  Could not tag {existing_note.name}: {e}')
                try:
                    existing_note.rename(flagged)
                except Exception as e:
                    log_fn('error', f'  ✗  Could not rename {existing_note.name}: {e}')
                stats['disconnected'] = stats.get('disconnected', 0) + 1

    # ── Canvas update — one canvas per unique note folder ────────────────────
    if not (stop_event and stop_event.is_set()):
        note_folders = {p.parent for p in live_note_paths}
        for note_folder in sorted(note_folders):
            try:
                if note_folder == dam_root:
                    _label = 'ROOT'
                else:
                    _label = re.sub(r'^\[\d+\]\s*', '', note_folder.name) or note_folder.name
                _update_dam_canvas(note_folder, vault, log_fn,
                                   source_map=note_source_map, canvas_label=_label)
            except Exception as e:
                log_fn('error', f'  ✗  Canvas failed for {note_folder.name}: {e}')

    log_fn('section',
           f'━━━ OBSIDIAN DONE — {stats["notes"]} notes · '
           f'{stats["note_thumbs"]} thumbs · '
           f'{stats.get("disconnected", 0)} disconnected · '
           f'{stats["errors"]} errors ━━━')
    return stats


# ── Widgets ───────────────────────────────────────────────────────────────────

class StatCard(ctk.CTkFrame):
    def __init__(self, master, label: str, **kwargs):
        super().__init__(master, corner_radius=10,
                         fg_color=C_SURFACE2, border_width=1,
                         border_color=C_BORDER, **kwargs)
        self._var = ctk.StringVar(value="—")
        ctk.CTkLabel(self, textvariable=self._var,
                     font=ctk.CTkFont("Courier New", 22, "bold"),
                     text_color=C_ACCENT).pack(pady=(12, 0), padx=12)
        ctk.CTkLabel(self, text=label,
                     font=ctk.CTkFont("Courier New", 10),
                     text_color=C_MUTED).pack(pady=(0, 10), padx=12)

    def set(self, value):
        self._var.set(str(value))


class SectionLabel(ctk.CTkLabel):
    def __init__(self, master, text, **kwargs):
        super().__init__(master, text=text.upper(),
                         font=ctk.CTkFont("Courier New", 10, "bold"),
                         text_color=C_MUTED, **kwargs)


class SettingsModal(ctk.CTkToplevel):
    def __init__(self, master, settings: dict, on_save):
        super().__init__(master)
        self.title("Settings")
        self.resizable(False, True)
        self.configure(fg_color=C_BG)
        self.transient(master)
        self.grab_set()

        self._on_save = on_save
        self._vars    = {}

        # Header
        hdr = ctk.CTkFrame(self, fg_color=C_SURFACE, corner_radius=0, height=48)
        hdr.pack(fill="x")
        hdr.pack_propagate(False)
        ctk.CTkLabel(hdr, text="FOLDER PATTERNS",
                     font=ctk.CTkFont("Courier New", 10, "bold"),
                     text_color=C_MUTED).pack(side="left", padx=20)

        # Fields — scrollable so content is never cropped
        scroll = ctk.CTkScrollableFrame(self, fg_color="transparent",
                                        scrollbar_button_color=C_BORDER,
                                        scrollbar_button_hover_color=C_MUTED)
        scroll.pack(fill="both", expand=True, padx=24, pady=20)
        scroll.grid_columnconfigure(1, weight=1)
        body = scroll

        # Filter mode toggle
        ctk.CTkLabel(body, text="Filter mode",
                     font=ctk.CTkFont("Courier New", 12),
                     text_color=C_TEXT,
                     anchor="w").grid(row=0, column=0, sticky="w", pady=8, padx=(0, 16))
        mode_var = ctk.StringVar(value=settings.get('filter_mode', 'blacklist'))
        ctk.CTkSegmentedButton(
            body, values=['blacklist', 'whitelist'],
            variable=mode_var,
            fg_color=C_SURFACE2, unselected_color=C_SURFACE2,
            selected_color=C_ACCENT2, selected_hover_color=C_ACCENT2,
            unselected_hover_color=C_BORDER,
            text_color=C_TEXT, text_color_disabled=C_MUTED,
            font=ctk.CTkFont("Courier New", 12),
            corner_radius=8,
        ).grid(row=0, column=1, sticky="ew", pady=8)
        self._vars['filter_mode'] = mode_var

        fields = [
            ('package_prefix', 'Package folder prefix'),
            ('out_folder',     'Output folder name'),
            ('exclude_mark',   'Exclude mark  (blacklist)'),
            ('include_mark',   'Include mark  (whitelist)'),
            ('thumb_width',         'Thumbnail width (px)'),
            ('thumb_quality',       'Thumbnail quality (0–100)'),
            ('dam_depth',           'DAM folder depth  (0 = flat, 1 = one level, …)'),
            ('dropbox_app_key',     'Dropbox app key  (optional)'),
            ('dropbox_token',       'Dropbox access token  (optional)'),
            ('onedrive_client_id',  'OneDrive app client ID  (optional)'),
            ('onedrive_tenant_id',  'OneDrive tenant ID  (or "common")'),
        ]
        for row_i, (key, label) in enumerate(fields, start=1):
            ctk.CTkLabel(body, text=label,
                         font=ctk.CTkFont("Courier New", 12),
                         text_color=C_TEXT,
                         anchor="w").grid(row=row_i, column=0, sticky="w",
                                          pady=8, padx=(0, 16))
            var = ctk.StringVar(value=settings.get(key, ''))
            ctk.CTkEntry(body, textvariable=var,
                         fg_color=C_SURFACE2, border_color=C_BORDER,
                         text_color=C_TEXT, height=34,
                         font=ctk.CTkFont("Courier New", 13),
                         corner_radius=8).grid(row=row_i, column=1, sticky="ew", pady=8)
            self._vars[key] = var

        # Buttons
        ctk.CTkFrame(self, fg_color=C_BORDER, height=1, corner_radius=0).pack(fill="x")
        btn_row = ctk.CTkFrame(self, fg_color=C_SURFACE, corner_radius=0, height=56)
        btn_row.pack(fill="x")
        btn_row.pack_propagate(False)
        ctk.CTkButton(btn_row, text="Cancel", width=90, height=34,
                      fg_color="transparent", hover_color=C_BORDER,
                      border_width=1, border_color=C_BORDER,
                      text_color=C_MUTED,
                      font=ctk.CTkFont("Courier New", 12),
                      corner_radius=8,
                      command=self.destroy).pack(side="right", padx=(6, 20), pady=11)
        ctk.CTkButton(btn_row, text="Save", width=90, height=34,
                      fg_color=C_ACCENT, hover_color="#9fffb0",
                      text_color="#000000",
                      font=ctk.CTkFont("Courier New", 12, "bold"),
                      corner_radius=8,
                      command=self._save).pack(side="right", padx=4, pady=11)

        # Size and center over parent
        self.update_idletasks()
        w, h = 480, 600
        px = master.winfo_x() + (master.winfo_width()  - w) // 2
        py = master.winfo_y() + (master.winfo_height() - h) // 2
        self.geometry(f"{w}x{h}+{px}+{py}")
        self.focus_set()

    def _save(self):
        new      = {k: v.get().strip() for k, v in self._vars.items()}
        optional = {'dropbox_app_key', 'dropbox_token', 'dropbox_refresh_token',
                    'filter_mode', 'onedrive_client_id',
                    'onedrive_token', 'onedrive_refresh_token'}
        if not all(v for k, v in new.items() if k not in optional):
            return
        self._on_save(new)
        self.destroy()


# ── Main App ──────────────────────────────────────────────────────────────────

class App(ctk.CTk):
    def __init__(self):
        super().__init__()
        self.title("📦  dc-hub")
        self.geometry("1100x760")
        self.minsize(900, 580)
        self.configure(fg_color=C_BG)

        self._source     = None
        self._target     = None
        self._vault      = None
        self._od_flat    = None
        self._running    = False
        self._stop_event = threading.Event()
        self._settings   = load_settings()
        self._modal    = None
        self._build_ui()
        self._restore_folders()

    # ── Layout ────────────────────────────────────────────────────────────────

    def _build_ui(self):
        # Header
        header = ctk.CTkFrame(self, fg_color=C_SURFACE, corner_radius=0, height=62)
        header.pack(fill="x", side="top")
        header.pack_propagate(False)

        ctk.CTkLabel(header, text="📦  Package Collector",
                     font=ctk.CTkFont("Helvetica", 20, "bold"),
                     text_color=C_TEXT).pack(side="left", padx=24, pady=16)
        ctk.CTkLabel(header, text="collect · publish · version-filter",
                     font=ctk.CTkFont("Courier New", 11),
                     text_color=C_MUTED).pack(side="left", pady=16)
        ctk.CTkButton(header, text="⚙  Settings",
                      width=110, height=32,
                      fg_color="transparent", hover_color=C_BORDER,
                      border_width=1, border_color=C_BORDER,
                      text_color=C_MUTED,
                      font=ctk.CTkFont("Courier New", 11),
                      corner_radius=8,
                      command=self._open_settings).pack(side="right", padx=20)

        # Body
        body = ctk.CTkFrame(self, fg_color="transparent", corner_radius=0)
        body.pack(fill="both", expand=True)
        body.grid_columnconfigure(1, weight=1)
        body.grid_rowconfigure(0, weight=1)

        self._build_sidebar(body)
        self._build_log_panel(body)

    def _build_sidebar(self, parent):
        sidebar = ctk.CTkFrame(parent, fg_color=C_SURFACE,
                                corner_radius=0, width=300)
        sidebar.grid(row=0, column=0, sticky="nsew")
        sidebar.pack_propagate(False)
        sidebar.grid_propagate(False)

        # Action buttons anchored at bottom (packed before scroll area)
        btn_frame = ctk.CTkFrame(sidebar, fg_color=C_SURFACE, corner_radius=0)
        btn_frame.pack(side="bottom", fill="x", padx=20, pady=16)
        ctk.CTkFrame(sidebar, fg_color=C_BORDER, height=1,
                     corner_radius=0).pack(side="bottom", fill="x")

        self._run_btn = ctk.CTkButton(
            btn_frame, text="▶   Run",
            height=46, fg_color=C_ACCENT, hover_color="#9fffb0",
            text_color="#000000",
            font=ctk.CTkFont("Helvetica", 14, "bold"),
            corner_radius=10, state="disabled",
            command=self._run
        )
        self._run_btn.pack(fill="x", pady=(0, 8))

        self._stop_btn = ctk.CTkButton(
            btn_frame, text="■   Stop",
            height=36, fg_color=C_SURFACE2, hover_color=C_SURFACE2,
            text_color=C_MUTED, border_width=1, border_color=C_BORDER,
            font=ctk.CTkFont("Helvetica", 13, "bold"),
            corner_radius=10, state="disabled",
            command=self._stop
        )
        self._stop_btn.pack(fill="x", pady=(8, 0))

        self._od_links_btn = ctk.CTkButton(
            btn_frame, text="🔷  Update OneDrive Links",
            height=36, fg_color=C_SURFACE2, hover_color=C_BORDER,
            text_color=C_ACCENT2, border_width=1, border_color=C_ACCENT2,
            font=ctk.CTkFont("Helvetica", 12, "bold"),
            corner_radius=10, state="disabled",
            command=self._run_od_update
        )
        self._od_links_btn.pack(fill="x", pady=(8, 0))

        # Scrollable content area fills the rest
        sc = ctk.CTkScrollableFrame(sidebar, fg_color="transparent",
                                    scrollbar_button_color=C_BORDER,
                                    scrollbar_button_hover_color=C_MUTED,
                                    corner_radius=0)
        sc.pack(fill="both", expand=True)

        # ── Source Folder ──────────────────────────────────────────
        SectionLabel(sc, "Source Folder").pack(anchor="w", padx=20, pady=(20, 6))
        self._src_var = ctk.StringVar(value="not selected")
        self._folder_row(sc, self._src_var, self._pick_source)

        ctk.CTkFrame(sc, fg_color=C_BORDER, height=1,
                     corner_radius=0).pack(fill="x", pady=(16, 0))

        # ── Target Folder ──────────────────────────────────────────
        SectionLabel(sc, "Target Folder").pack(anchor="w", padx=20, pady=(14, 6))
        self._tgt_var = ctk.StringVar(value="not selected")
        self._folder_row(sc, self._tgt_var, self._pick_target)

        ctk.CTkFrame(sc, fg_color=C_BORDER, height=1,
                     corner_radius=0).pack(fill="x", pady=(16, 0))

        # ── OneDrive Flat Folder ───────────────────────────────────
        SectionLabel(sc, "OneDrive Flat Folder").pack(anchor="w", padx=20, pady=(14, 6))
        self._od_flat_var = ctk.StringVar(value="not selected")
        self._folder_row(sc, self._od_flat_var, self._pick_od_flat)

        ctk.CTkFrame(sc, fg_color=C_BORDER, height=1,
                     corner_radius=0).pack(fill="x", pady=(16, 0))

        # ── Obsidian Vault ─────────────────────────────────────────
        SectionLabel(sc, "Obsidian Vault").pack(anchor="w", padx=20, pady=(14, 6))
        self._vault_var = ctk.StringVar(value="not selected")
        self._folder_row(sc, self._vault_var, self._pick_vault)

        ctk.CTkFrame(sc, fg_color=C_BORDER, height=1,
                     corner_radius=0).pack(fill="x", pady=(16, 0))

        # ── Dropbox Auth ───────────────────────────────────────────
        SectionLabel(sc, "Dropbox").pack(anchor="w", padx=20, pady=(14, 6))
        db_row = ctk.CTkFrame(sc, fg_color="transparent")
        db_row.pack(fill="x", padx=20, pady=(0, 4))
        self._db_status_var = ctk.StringVar(value=self._db_status_label())
        ctk.CTkLabel(db_row, textvariable=self._db_status_var,
                     font=ctk.CTkFont("Courier New", 11),
                     text_color=C_MUTED, anchor="w").pack(side="left", fill="x", expand=True)
        ctk.CTkButton(db_row, text="Connect", width=80, height=28,
                      fg_color=C_SURFACE2, hover_color=C_BORDER,
                      border_width=1, border_color=C_BORDER,
                      text_color=C_TEXT,
                      font=ctk.CTkFont("Courier New", 11),
                      corner_radius=6,
                      command=self._connect_dropbox).pack(side="right")

        ctk.CTkFrame(sc, fg_color=C_BORDER, height=1,
                     corner_radius=0).pack(fill="x", pady=(16, 0))

        # ── OneDrive ───────────────────────────────────────────────
        SectionLabel(sc, "OneDrive").pack(anchor="w", padx=20, pady=(14, 6))
        od_row = ctk.CTkFrame(sc, fg_color="transparent")
        od_row.pack(fill="x", padx=20, pady=(0, 4))
        self._od_status_var = ctk.StringVar(value=self._od_status_label())
        ctk.CTkLabel(od_row, textvariable=self._od_status_var,
                     font=ctk.CTkFont("Courier New", 11),
                     text_color=C_MUTED, anchor="w").pack(side="left", fill="x", expand=True)
        ctk.CTkButton(od_row, text="Connect", width=80, height=28,
                      fg_color=C_SURFACE2, hover_color=C_BORDER,
                      border_width=1, border_color=C_BORDER,
                      text_color=C_TEXT,
                      font=ctk.CTkFont("Courier New", 11),
                      corner_radius=6,
                      command=self._connect_onedrive).pack(side="right")

        ctk.CTkFrame(sc, fg_color=C_BORDER, height=1,
                     corner_radius=0).pack(fill="x", pady=16)

        # ── Tasks ──────────────────────────────────────────────────
        SectionLabel(sc, "Tasks").pack(anchor="w", padx=20, pady=(0, 10))

        self._distribute_var    = ctk.BooleanVar(value=self._settings.get('do_distribute', True))
        self._publish_var       = ctk.BooleanVar(value=self._settings.get('do_publish', False))
        self._flat_export_var   = ctk.BooleanVar(value=self._settings.get('do_flat_export', True))
        self._thumb_var         = ctk.BooleanVar(value=self._settings.get('do_thumbnails', False))
        self._obsidian_var      = ctk.BooleanVar(value=self._settings.get('do_obsidian', False))

        for text, var in [
            ("Generate thumbnails",        self._thumb_var),
            ("Distribute packages",        self._distribute_var),
            ("Publish on cloud",           self._publish_var),
            ("Publish to DAM",             self._obsidian_var),
        ]:
            ctk.CTkCheckBox(sc, text=text, variable=var,
                            font=ctk.CTkFont("Helvetica", 13),
                            text_color=C_TEXT, fg_color=C_ACCENT2,
                            hover_color=C_ACCENT, border_color=C_BORDER,
                            corner_radius=4, checkmark_color=C_BG,
                            command=self._update_run_btn
                            ).pack(anchor="w", padx=20, pady=5)

        ctk.CTkCheckBox(sc, text="└  Flat export to OneDrive",
                        variable=self._flat_export_var,
                        font=ctk.CTkFont("Helvetica", 12),
                        text_color="#8888a0", fg_color=C_ACCENT2,
                        hover_color=C_ACCENT, border_color=C_BORDER,
                        corner_radius=4, checkmark_color=C_BG,
                        command=self._update_run_btn
                        ).pack(anchor="w", padx=36, pady=(0, 5))

        ctk.CTkFrame(sc, fg_color=C_BORDER, height=1,
                     corner_radius=0).pack(fill="x", pady=16)

        # ── Options ────────────────────────────────────────────────
        SectionLabel(sc, "Options").pack(anchor="w", padx=20, pady=(0, 10))

        self._dry_run_var      = ctk.BooleanVar(value=False)
        self._version_var      = ctk.BooleanVar(value=True)
        self._pack_subfolders_var = ctk.BooleanVar(value=True)

        for text, var in [
            ("Dry run  (preview, no changes)",         self._dry_run_var),
            ("Keep highest version only  (vX-X-X)",    self._version_var),
            ("Preserve folder structure in packages",  self._pack_subfolders_var),
        ]:
            ctk.CTkCheckBox(sc, text=text, variable=var,
                            font=ctk.CTkFont("Helvetica", 13),
                            text_color=C_TEXT, fg_color=C_ACCENT2,
                            hover_color=C_ACCENT, border_color=C_BORDER,
                            corner_radius=4, checkmark_color=C_BG
                            ).pack(anchor="w", padx=20, pady=5)

        ctk.CTkFrame(sc, fg_color=C_BORDER, height=1,
                     corner_radius=0).pack(fill="x", pady=16)

        # ── Stats ──────────────────────────────────────────────────
        SectionLabel(sc, "Last Run").pack(anchor="w", padx=20, pady=(0, 12))

        grid = ctk.CTkFrame(sc, fg_color="transparent")
        grid.pack(fill="x", padx=16, pady=(0, 16))
        grid.grid_columnconfigure((0, 1), weight=1)

        self._cards = {}
        for i, (key, label) in enumerate([
            ("packages",    "Packages"),
            ("copied",      "Copied"),
            ("skipped",     "Skipped"),
            ("errors",      "Errors"),
            ("pub_folders", "Pub.Folders"),
            ("published",   "Published"),
        ]):
            card = StatCard(grid, label)
            card.grid(row=i // 2, column=i % 2, padx=4, pady=4, sticky="nsew")
            self._cards[key] = card

        # Thumbnails card spans full width
        thumb_card = StatCard(grid, "Thumbnails")
        thumb_card.grid(row=3, column=0, columnspan=2, padx=4, pady=4, sticky="nsew")
        self._cards['thumbs'] = thumb_card

        # Obsidian Notes card spans full width
        notes_card = StatCard(grid, "Notes")
        notes_card.grid(row=4, column=0, columnspan=2, padx=4, pady=4, sticky="nsew")
        self._cards['notes'] = notes_card

    def _folder_row(self, parent, var, command):
        row = ctk.CTkFrame(parent, fg_color="transparent")
        row.pack(fill="x", padx=20, pady=(0, 4))
        row.grid_columnconfigure(0, weight=1)
        ctk.CTkEntry(row, textvariable=var, state="disabled",
                     font=ctk.CTkFont("Courier New", 11),
                     fg_color=C_SURFACE2, border_color=C_BORDER,
                     text_color=C_MUTED, height=36,
                     corner_radius=8).grid(row=0, column=0, sticky="ew", padx=(0, 8))
        ctk.CTkButton(row, text="Browse", width=80, height=36,
                      fg_color=C_SURFACE2, hover_color=C_BORDER,
                      border_width=1, border_color=C_BORDER,
                      text_color=C_TEXT,
                      font=ctk.CTkFont("Courier New", 12, "bold"),
                      corner_radius=8,
                      command=command).grid(row=0, column=1)

    def _build_log_panel(self, parent):
        log_frame = ctk.CTkFrame(parent, fg_color=C_BG, corner_radius=0)
        log_frame.grid(row=0, column=1, sticky="nsew")
        log_frame.grid_rowconfigure(2, weight=1)
        log_frame.grid_columnconfigure(0, weight=1)

        log_hdr = ctk.CTkFrame(log_frame, fg_color=C_SURFACE,
                                corner_radius=0, height=48)
        log_hdr.grid(row=0, column=0, sticky="ew")
        log_hdr.pack_propagate(False)

        ctk.CTkLabel(log_hdr, text="ACTIVITY LOG",
                     font=ctk.CTkFont("Courier New", 10, "bold"),
                     text_color=C_MUTED).pack(side="left", padx=20)
        ctk.CTkButton(log_hdr, text="clear", width=60, height=26,
                      fg_color="transparent", hover_color=C_BORDER,
                      border_width=1, border_color=C_BORDER,
                      text_color=C_MUTED,
                      font=ctk.CTkFont("Courier New", 11),
                      corner_radius=6,
                      command=self._clear_log).pack(side="right", padx=16)

        self._progress = ctk.CTkProgressBar(log_frame,
                                             fg_color=C_BORDER,
                                             progress_color=C_ACCENT,
                                             corner_radius=0, height=4)
        self._progress.grid(row=1, column=0, sticky="ew")
        self._progress.set(0)

        self._log = ctk.CTkTextbox(
            log_frame,
            fg_color=C_BG, text_color=C_TEXT,
            font=ctk.CTkFont("Courier New", 12),
            wrap="word", corner_radius=0, border_width=0,
            scrollbar_button_color=C_BORDER,
            scrollbar_button_hover_color=C_MUTED,
        )
        self._log.grid(row=2, column=0, sticky="nsew")

        for tag, color in LOG_COLORS.items():
            self._log.tag_config(tag, foreground=color)

        self._log.configure(state="disabled")
        self._append_log("dim", "Select folders, choose tasks, and press Run.\n")

    # ── Handlers ─────────────────────────────────────────────────────────────

    def _restore_folders(self):
        src = self._settings.get('source_folder', '')
        tgt = self._settings.get('target_folder', '')
        vlt = self._settings.get('vault_folder', '')
        odf = self._settings.get('onedrive_flat_folder', '')
        if src and Path(src).exists():
            self._source = Path(src)
            parts = self._source.parts
            self._src_var.set(('…/' + '/'.join(parts[-3:])) if len(parts) > 3 else src)
        if tgt and Path(tgt).exists():
            self._target = Path(tgt)
            parts = self._target.parts
            self._tgt_var.set(('…/' + '/'.join(parts[-3:])) if len(parts) > 3 else tgt)
        if vlt and Path(vlt).exists():
            self._vault = Path(vlt)
            parts = self._vault.parts
            self._vault_var.set(('…/' + '/'.join(parts[-3:])) if len(parts) > 3 else vlt)
        if odf and Path(odf).exists():
            self._od_flat = Path(odf)
            parts = self._od_flat.parts
            self._od_flat_var.set(('…/' + '/'.join(parts[-3:])) if len(parts) > 3 else odf)
        if src or tgt or vlt or odf:
            self._update_run_btn()

    def _pick_source(self):
        path = filedialog.askdirectory(title="Select root folder to scan")
        if not path:
            return
        self._source = Path(path)
        parts = self._source.parts
        self._src_var.set(('…/' + '/'.join(parts[-3:])) if len(parts) > 3 else str(self._source))
        self._settings['source_folder'] = str(self._source)
        save_settings(self._settings)
        self._update_run_btn()
        self._append_log("info", f"Source: {self._source}\n")

    def _pick_target(self):
        path = filedialog.askdirectory(title="Select target folder for publishing")
        if not path:
            return
        self._target = Path(path)
        parts = self._target.parts
        self._tgt_var.set(('…/' + '/'.join(parts[-3:])) if len(parts) > 3 else str(self._target))
        self._settings['target_folder'] = str(self._target)
        save_settings(self._settings)
        self._update_run_btn()
        self._append_log("info", f"Target: {self._target}\n")

    def _pick_od_flat(self):
        path = filedialog.askdirectory(title="Select OneDrive flat export folder")
        if not path:
            return
        self._od_flat = Path(path)
        parts = self._od_flat.parts
        self._od_flat_var.set(('…/' + '/'.join(parts[-3:])) if len(parts) > 3 else str(self._od_flat))
        self._settings['onedrive_flat_folder'] = str(self._od_flat)
        save_settings(self._settings)
        self._update_run_btn()
        self._append_log("info", f"OneDrive flat: {self._od_flat}\n")

    def _pick_vault(self):
        path = filedialog.askdirectory(title="Select Obsidian vault root folder")
        if not path:
            return
        self._vault = Path(path)
        parts = self._vault.parts
        self._vault_var.set(('…/' + '/'.join(parts[-3:])) if len(parts) > 3 else str(self._vault))
        self._settings['vault_folder'] = str(self._vault)
        save_settings(self._settings)
        self._update_run_btn()
        self._append_log("info", f"Vault: {self._vault}\n")

    def _db_status_label(self) -> str:
        if self._settings.get('dropbox_refresh_token'):
            return '● connected (auto-refresh)'
        return '● token set' if self._settings.get('dropbox_token') else '○ not connected'

    def _connect_dropbox(self):
        app_key = self._settings.get('dropbox_app_key', '').strip()
        if not app_key:
            self._append_log('warning',
                'Dropbox: set an App key in Settings first.\n'
                'Find it at dropbox.com/developers/apps → your app → App key.\n'
            )
            return
        if self._running:
            return

        def on_tokens(tokens):
            self._settings['dropbox_token']         = tokens.get('access_token', '')
            self._settings['dropbox_refresh_token'] = tokens.get('refresh_token', '')
            save_settings(self._settings)
            self.after(0, lambda: (
                self._db_status_var.set(self._db_status_label()),
                self._update_run_btn(),
            ))

        def auth_thread():
            run_dropbox_auth(
                app_key,
                lambda lvl, msg: self.after(0, lambda l=lvl, m=msg: self._append_log(l, m + '\n')),
                on_tokens,
            )

        threading.Thread(target=auth_thread, daemon=True).start()

    def _od_status_label(self) -> str:
        return '● connected' if self._settings.get('onedrive_token') else '○ not connected'

    def _connect_onedrive(self):
        cid = self._settings.get('onedrive_client_id', '').strip()
        if not cid:
            self._append_log('warning',
                'OneDrive: set a Client ID in Settings first.\n'
                'Register a free Azure app at portal.azure.com → App registrations\n'
                '→ New registration → Platform: Mobile/desktop → enable Device code flow.\n'
            )
            return
        if self._running:
            return

        def on_tokens(tokens):
            self._settings['onedrive_token']         = tokens.get('access_token', '')
            self._settings['onedrive_refresh_token'] = tokens.get('refresh_token', '')
            save_settings(self._settings)
            self.after(0, lambda: (
                self._od_status_var.set(self._od_status_label()),
                self._update_run_btn(),
            ))

        def auth_thread():
            run_onedrive_auth(
                cid,
                lambda lvl, msg: self.after(0, lambda l=lvl, m=msg: self._append_log(l, m + '\n')),
                on_tokens,
                self._settings.get('onedrive_tenant_id', 'common'),
            )

        threading.Thread(target=auth_thread, daemon=True).start()

    def _update_run_btn(self):
        do_dist  = self._distribute_var.get()
        do_pub   = self._publish_var.get()
        do_thumb = self._thumb_var.get()
        do_obs   = self._obsidian_var.get()
        run_ready = (
            self._source is not None and (
                do_thumb or
                do_dist or
                (do_pub and self._target is not None) or
                (do_pub and self._od_flat is not None) or
                (do_obs and self._vault is not None)
            )
        )
        od_links_ready = (
            self._od_flat is not None and
            self._vault is not None and
            bool(self._settings.get('onedrive_token'))
        )
        if not self._running:
            self._run_btn.configure(state="normal" if run_ready else "disabled")
            self._od_links_btn.configure(state="normal" if od_links_ready else "disabled")
            self._stop_btn.configure(
                state="disabled", text="■   Stop",
                fg_color=C_SURFACE2, hover_color=C_SURFACE2,
                text_color=C_MUTED, border_color=C_BORDER
            )

    def _open_settings(self):
        if self._modal and self._modal.winfo_exists():
            self._modal.focus()
            return
        self._modal = SettingsModal(self, self._settings, self._apply_settings)

    def _apply_settings(self, new_settings: dict):
        self._settings.update(new_settings)
        save_settings(self._settings)
        self._append_log("info", "Settings saved.\n")

    def _stop(self):
        self._stop_event.set()
        self._stop_btn.configure(state="disabled", text="■   Stopping…")

    def _run_od_update(self):
        if self._running:
            return
        self._running = True
        self._od_links_btn.configure(state="disabled", text="⏳   Updating…")
        self._stop_event.clear()
        self._stop_btn.configure(
            state="normal", text="■   Stop",
            fg_color=C_DANGER, hover_color="#ff3a3a",
            text_color="#ffffff", border_color=C_DANGER
        )
        self._progress.set(0)

        flat_folder = self._od_flat
        vault       = self._vault
        settings    = self._settings.copy()

        def log_fn(t, m):
            self.after(0, lambda t=t, m=m: self._append_log(t, m + "\n"))

        def worker():
            stats = run_onedrive_link_update(
                flat_folder, vault, settings, log_fn,
                lambda p: self.after(0, lambda v=p: self._progress.set(v)),
                self._stop_event
            )
            def _finish():
                self._running = False
                self._od_links_btn.configure(text="🔷  Update OneDrive Links")
                self._update_run_btn()
                self._progress.set(1)
                self._cards['notes'].set(f"+{stats.get('updated', 0)}")
            self.after(0, _finish)

        threading.Thread(target=worker, daemon=True).start()

    def _run(self):
        if self._running:
            return
        self._running = True
        self._run_btn.configure(state="disabled", text="⏳   Running…")
        self._stop_event.clear()
        self._stop_btn.configure(
            state="normal", text="■   Stop",
            fg_color=C_DANGER, hover_color="#ff3a3a",
            text_color="#ffffff", border_color=C_DANGER
        )
        self._progress.set(0)

        do_thumb      = self._thumb_var.get()
        do_dist       = self._distribute_var.get()
        do_pub        = self._publish_var.get()
        do_flat_exp   = self._flat_export_var.get()
        do_notes      = self._obsidian_var.get()
        self._settings['do_thumbnails']  = do_thumb
        self._settings['do_distribute']  = do_dist
        self._settings['do_publish']     = do_pub
        self._settings['do_flat_export'] = do_flat_exp
        self._settings['do_obsidian']    = do_notes
        save_settings(self._settings)
        dry      = self._dry_run_var.get()
        ver      = self._version_var.get()
        pack_sub = self._pack_subfolders_var.get()
        source   = self._source
        target   = self._target
        vault    = self._vault
        od_flat  = self._od_flat
        settings = self._settings.copy()

        def log_fn(t, m):
            self.after(0, lambda t=t, m=m: self._append_log(t, m + "\n"))

        def on_done(stats):
            def _finish():
                self._running = False
                self._run_btn.configure(text="▶   Run")
                self._update_run_btn()
                self._progress.set(1)
                for k, card in self._cards.items():
                    card.set(stats.get(k, "—"))
            self.after(0, _finish)

        def worker():
            combined = {k: 0 for k in
                        ('packages', 'copied', 'skipped', 'errors',
                         'pub_folders', 'published', 'thumbs', 'notes')}
            # Fixed execution order: thumbs → distribute → cloud publish → DAM
            do_flat = do_pub and do_flat_exp and od_flat is not None
            active_phases = sum([
                bool(do_thumb),
                bool(do_dist),
                bool(do_pub and target),
                bool(do_flat),
                bool(do_notes and vault),
            ]) or 1

            phase_idx = 0

            # 1. Generate thumbnails (always first so notes can reference them)
            if do_thumb:
                scale  = 1.0 / active_phases
                offset = phase_idx / active_phases
                phase_idx += 1
                stats  = run_thumbnails(
                    source, settings, log_fn,
                    lambda p: self.after(0, lambda v=offset + p * scale:
                                         self._progress.set(v)),
                    self._stop_event
                )
                combined['thumbs'] += stats.get('thumbs', 0)
                combined['errors'] += stats.get('errors', 0)

            # 2. Distribute packages
            if do_dist:
                scale  = 1.0 / active_phases
                offset = phase_idx / active_phases
                phase_idx += 1
                stats  = run_collector(
                    source, dry, ver, pack_sub, settings, log_fn,
                    lambda p: self.after(0, lambda v=offset + p * scale:
                                         self._progress.set(v)),
                    self._stop_event
                )
                for k in ('packages', 'copied', 'skipped', 'errors'):
                    combined[k] += stats.get(k, 0)

            # 3. Publish on cloud — SharePoint structured export
            if do_pub and target:
                scale  = 1.0 / active_phases
                offset = phase_idx / active_phases
                phase_idx += 1
                stats  = run_publish(
                    source, target, settings, log_fn,
                    lambda p: self.after(0, lambda v=offset + p * scale:
                                         self._progress.set(v)),
                    self._stop_event
                )
                combined['pub_folders'] += stats.get('pub_folders', 0)
                combined['published']   += stats.get('published', 0)
                combined['errors']      += stats.get('errors', 0)

            # 3b. Publish on cloud — OneDrive flat export (runs with cloud step)
            if do_flat:
                scale  = 1.0 / active_phases
                offset = phase_idx / active_phases
                phase_idx += 1
                stats  = run_flat_export(
                    source, od_flat, settings, log_fn,
                    lambda p: self.after(0, lambda v=offset + p * scale:
                                         self._progress.set(v)),
                    self._stop_event
                )
                combined['published'] += stats.get('copied', 0)
                combined['errors']    += stats.get('errors', 0)

            # 4. Publish to DAM (Obsidian notes)
            if do_notes and vault:
                scale  = 1.0 / active_phases
                offset = phase_idx / active_phases
                phase_idx += 1
                stats  = run_obsidian_notes(
                    source, vault, settings, log_fn,
                    lambda p: self.after(0, lambda v=offset + p * scale:
                                         self._progress.set(v)),
                    self._stop_event
                )
                combined['notes']  += stats.get('notes', 0)
                combined['errors'] += stats.get('errors', 0)

            on_done(combined)

        threading.Thread(target=worker, daemon=True).start()

    def _clear_log(self):
        self._log.configure(state="normal")
        self._log.delete("0.0", "end")
        self._log.configure(state="disabled")
        self._progress.set(0)
        for card in self._cards.values():
            card.set("—")

    def _append_log(self, type_: str, text: str):
        self._log.configure(state="normal")
        if type_ == "section":
            self._log.insert("end", "\n" + text, type_)
        else:
            self._log.insert("end", text, type_)
        self._log.see("end")
        self._log.configure(state="disabled")


if __name__ == "__main__":
    app = App()
    app.mainloop()
