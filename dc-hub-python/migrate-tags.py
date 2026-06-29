#!/usr/bin/env python3
"""
migrate-tags.py -- migrate all asset filenames from [bracket] to (paren) style,
applying legacy alias remapping at the same time.

Sources vocabulary.json for both the canonical shortcode list and legacy_aliases.

Usage:
  python3 migrate-tags.py --dry-run          # preview everything, touch nothing
  python3 migrate-tags.py                    # execute renames
  python3 migrate-tags.py --dir /some/path   # target a specific folder (default: source_folder from settings.json)

Output:
  A migration report is written to  migrate-tags-report.txt  in the same folder as this script.
"""

import argparse
import json
import re
import sys
from pathlib import Path
from datetime import datetime

ROOT       = Path(__file__).parent
VOCAB_PATH = ROOT / "vocabulary.json"
SETTINGS_PATH = ROOT / "settings.json"
REPORT_PATH   = ROOT / "migrate-tags-report.txt"

# ── Load vocabulary ────────────────────────────────────────────────────────────

def load_vocab():
    with open(VOCAB_PATH, encoding="utf-8") as f:
        return json.load(f)

def build_rename_map(vocab):
    """Build an ordered list of (old_pattern, new_shortcode) substitution rules.

    Each rule matches a bracket tag in the filename and replaces it with the
    canonical (paren) form.  Rules are sorted longest-first so e.g. [P-EXP]
    is matched before [P-E] if such a thing existed.

    Two kinds of rule:
      1. legacy alias  : [_Sln] -> (p-Sln),  [BMW] -> (c-BMW), etc.
      2. bracket swap  : [SAL]  -> (SAL),     [SlD] -> (SlD),  etc.
         (canonical shortcodes that are already correct but use old brackets)
    """
    canonical = {t["shortcode"] for t in vocab["tags"]}
    aliases   = {k: v for k, v in vocab.get("legacy_aliases", {}).items()
                 if not k.startswith("_comment")}

    rules = {}  # old_shortcode -> new_shortcode

    # 1. Legacy aliases (may include bracket swaps AND code changes)
    for old, new in aliases.items():
        rules[old] = new

    # 2. Canonical shortcodes that still need bracket swap (not already in aliases)
    for sc in canonical:
        if sc not in rules:
            rules[sc] = sc   # same code, just swap [] -> ()

    return rules


def apply_rules_to_stem(stem, rules):
    """Replace all [TAG] groups in a filename stem using the rules map.

    Returns (new_stem, list_of_changes) where each change is a string like
    '[_Sln] -> (p-Sln)'.
    """
    # Sort by length of old shortcode descending to avoid partial matches
    sorted_rules = sorted(rules.items(), key=lambda x: len(x[0]), reverse=True)

    changes = []
    result  = stem

    for old_sc, new_sc in sorted_rules:
        # Escape special regex chars in the shortcode (e.g. ± . + *)
        pattern = re.escape(f"[{old_sc}]")
        replacement = f"({new_sc})"
        new_result, n = re.subn(pattern, replacement, result)
        if n:
            changes.append(f"[{old_sc}] -> ({new_sc})")
            result = new_result

    # Catch-all: any remaining [anything] groups not matched by vocabulary rules
    # (dates like [2510], unknown codes, legacy descriptions in brackets)
    remaining = re.findall(r'\[([^\]]+)\]', result)
    for content in remaining:
        result = result.replace(f'[{content}]', f'({content})', 1)
        changes.append(f'[{content}] -> ({content})  (catch-all)')

    return result, changes


# ── Filesystem walk ────────────────────────────────────────────────────────────

RENAME_EXTS = {
    ".pptx", ".pptm", ".ppt",
    ".pdf",
    ".docx", ".doc",
    ".xlsx",
    ".jpg", ".jpeg", ".png", ".webp", ".gif",
    ".mp4", ".mov",
}

def find_candidates(root: Path):
    """Yield Path objects for every file under root whose name contains [."""
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        if path.name.startswith(".") or path.name.startswith("~$"):
            continue
        # Only process files whose stem contains at least one [TAG] group
        if "[" not in path.stem:
            continue
        if path.suffix.lower() not in RENAME_EXTS:
            continue
        yield path


def plan_renames(root: Path, rules: dict):
    """Return list of (src_path, dst_path, changes) for all files needing rename."""
    plans = []
    seen_destinations = {}  # dst -> src, collision detection

    for src in sorted(find_candidates(root)):
        new_stem, changes = apply_rules_to_stem(src.stem, rules)
        if not changes:
            continue
        dst = src.with_name(new_stem + src.suffix)
        if src == dst:
            continue
        # Collision check
        if dst in seen_destinations:
            changes.append(f"  !! COLLISION with {seen_destinations[dst]}")
        seen_destinations[dst] = src
        plans.append((src, dst, changes))

    return plans


# ── Reporting ─────────────────────────────────────────────────────────────────

def write_report(plans, dry_run, root, report_path):
    lines = []
    lines.append(f"migrate-tags report")
    lines.append(f"  generated : {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    lines.append(f"  root      : {root}")
    lines.append(f"  mode      : {'DRY RUN -- no files were changed' if dry_run else 'EXECUTED'}")
    lines.append(f"  files     : {len(plans)}")
    lines.append("")
    lines.append("-" * 80)

    for src, dst, changes in plans:
        rel = src.relative_to(root)
        lines.append(f"\n  {rel.parent}/")
        lines.append(f"    FROM  {src.name}")
        lines.append(f"    TO    {dst.name}")
        for c in changes:
            lines.append(f"          {c}")

    lines.append("\n" + "-" * 80)
    lines.append(f"\nTotal: {len(plans)} file(s) to rename.")

    text = "\n".join(lines)
    report_path.write_text(text, encoding="utf-8")
    return text


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Migrate [bracket] tags to (paren) style.")
    parser.add_argument("--dry-run", action="store_true",
                        help="Preview renames without touching any files")
    parser.add_argument("--dir", metavar="PATH", default=None,
                        help="Root folder to scan (default: source_folder from settings.json)")
    args = parser.parse_args()

    # Resolve root folder
    if args.dir:
        root = Path(args.dir).expanduser().resolve()
    else:
        if not SETTINGS_PATH.exists():
            print("  ERROR: settings.json not found and --dir not specified.")
            sys.exit(1)
        with open(SETTINGS_PATH, encoding="utf-8") as f:
            settings = json.load(f)
        source = settings.get("source_folder", "").strip()
        if not source:
            print("  ERROR: source_folder not set in settings.json. Use --dir.")
            sys.exit(1)
        root = Path(source).expanduser().resolve()

    if not root.exists():
        print(f"  ERROR: folder does not exist: {root}")
        sys.exit(1)

    # Build rules
    vocab = load_vocab()
    rules = build_rename_map(vocab)

    print(f"\n  dc-hub migrate-tags")
    print(f"  {'DRY RUN -- ' if args.dry_run else ''}scanning: {root}\n")

    # Plan
    plans = plan_renames(root, rules)

    if not plans:
        print("  Nothing to rename -- all files already use (paren) style.")
        return

    # Print preview
    for src, dst, changes in plans:
        try:
            rel = src.relative_to(root)
        except ValueError:
            rel = src
        print(f"  {rel.parent}/")
        print(f"    {src.name}")
        print(f"    -> {dst.name}")
        for c in changes:
            line = c.strip()
            if line.startswith("!!"):
                print(f"       !! {line}")
            else:
                print(f"       {line}")
        print()

    # Write report
    write_report(plans, args.dry_run, root, REPORT_PATH)
    print(f"  Report written to: {REPORT_PATH.name}")

    if args.dry_run:
        print(f"\n  DRY RUN complete -- {len(plans)} file(s) would be renamed.")
        print("  Run without --dry-run to apply changes.")
        return

    # Execute
    errors = []
    renamed = 0
    for src, dst, changes in plans:
        if any("COLLISION" in c for c in changes):
            print(f"  SKIP (collision): {src.name}")
            continue
        if dst.exists():
            print(f"  SKIP (exists): {dst.name}")
            continue
        try:
            src.rename(dst)
            renamed += 1
        except Exception as e:
            errors.append((src, str(e)))
            print(f"  ERROR: {src.name}: {e}")

    print(f"\n  Done -- {renamed} renamed, {len(errors)} errors.")
    if errors:
        print("  Errors:")
        for p, e in errors:
            print(f"    {p.name}: {e}")


if __name__ == "__main__":
    main()
