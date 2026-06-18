#!/usr/bin/env python3
"""
dc-hub v1.0 patch — run once from Terminal:
    cd /Users/petrmucha/Sites/localhost/dc-hub
    python3 patch_v1.py

Applies 6 changes to app.py then deletes itself.
"""
import re, sys
from pathlib import Path

TARGET = Path(__file__).parent / 'app.py'
src = TARGET.read_text(encoding='utf-8')
original_len = len(src)

changes = 0

# 1. Module docstring
old = ('#!/usr/bin/env python3\n"""\nPackage Collector  v2.0\n'
       '\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n'
       'Distribute: scans source for [00] \U0001f4e6 folders, collects files from sibling\n'
       '            [03] OUT folders, version-filters, and copies them flat.\n'
       'Publish:    mirrors [03] OUT contents to an equivalent target path, skipping\n'
       '            everything except the output files (like rsync --delete per folder).\n'
       'Thumbnails: generates a WebP thumbnail from the first slide/page of every\n'
       '            PPTX, PPT, PPTM and PDF file found in source (skips package folders).\n'
       '"""')
new = ('#!/usr/bin/env python3\n"""\ndc-hub  v1.0\n'
       '\u2500' * 77 + '\n'
       'Distribute:  scans source for [00] \U0001f4e6 folders, collects files from sibling\n'
       '             [03] OUT folders, version-filters, and copies them flat.\n'
       'Publish:     mirrors [03] OUT contents to an equivalent target path, skipping\n'
       '             everything except the output files (like rsync --delete per folder).\n'
       'Thumbnails:  generates a WebP thumbnail from the first slide/page of every\n'
       '             PPTX, PPT, PPTM and PDF file found in source (skips package folders).\n'
       'Obsidian:    builds a DAM vault overlay \u2014 one note per asset, canvases per scope.\n\n'
       'Filename convention:  (Entity)(Angle)(Format)(Description)vX-Y-Z.ext\n'
       '                      Round brackets () are canonical from v1.0.\n'
       '                      Square brackets [] are accepted as a legacy alias.\n'
       'Vocabulary:           vocabulary.json  \u2014 canonical shortcode registry.\n'
       '                      legacy_aliases   \u2014 silent remapping of old shortcodes.\n'
       '"""')
if old in src:
    src = src.replace(old, new, 1); changes += 1
    print('  \u2713  1. docstring')
else:
    print('  \u2717  1. docstring NOT FOUND (already patched?)')

# 2. _load_vocabulary — add legacy_aliases
old = ('def _load_vocabulary() -> dict:\n'
       '    global _VOCABULARY_CACHE\n'
       '    if _VOCABULARY_CACHE is None:\n'
       '        try:\n'
       "            p = Path(__file__).parent / 'vocabulary.json'\n"
       "            with open(p, encoding='utf-8') as f:\n"
       '                data = json.load(f)\n'
       "            _VOCABULARY_CACHE = {t['shortcode']: t for t in data.get('tags', [])}\n"
       '        except Exception:\n'
       '            _VOCABULARY_CACHE = {}\n'
       '    return _VOCABULARY_CACHE')
new = ('def _load_vocabulary() -> dict:\n'
       '    """Return shortcode \u2192 tag entry mapping, including legacy alias resolution.\n'
       "    legacy_aliases in vocabulary.json maps old shortcodes (e.g. '_Rns', '\u00b1DIP')\n"
       '    to their canonical v1.0 replacements. Old files on disk are parsed silently\n'
       '    without warnings \u2014 no need to rename them immediately.\n'
       '    """\n'
       '    global _VOCABULARY_CACHE\n'
       '    if _VOCABULARY_CACHE is None:\n'
       '        try:\n'
       "            p = Path(__file__).parent / 'vocabulary.json'\n"
       "            with open(p, encoding='utf-8') as f:\n"
       '                data = json.load(f)\n'
       "            base = {t['shortcode']: t for t in data.get('tags', [])}\n"
       "            for old_sc, new_sc in data.get('legacy_aliases', {}).items():\n"
       "                if old_sc.startswith('_comment'):\n"
       '                    continue\n'
       '                if new_sc in base and old_sc not in base:\n'
       '                    base[old_sc] = base[new_sc]\n'
       '            _VOCABULARY_CACHE = base\n'
       '        except Exception:\n'
       '            _VOCABULARY_CACHE = {}\n'
       '    return _VOCABULARY_CACHE')
if old in src:
    src = src.replace(old, new, 1); changes += 1
    print('  \u2713  2. _load_vocabulary')
else:
    print('  \u2717  2. _load_vocabulary NOT FOUND (already patched?)')

# 3. _parse_asset_filename — accept () and []
old = (r"    lead = re.match(r'^(\[[^\]]+\])+', stem)" + '\n'
       '    if not lead:\n'
       "        r['error'] = 'No bracket tags at start of filename'\n"
       '        return r\n'
       r"    raw_tags = re.findall(r'\[([^\]]+)\]', lead.group(0))")
new = (r"    # Match a leading run of either (\u2026) or [\u2026] groups (may be mixed on legacy files)" + '\n'
       r"    lead = re.match(r'^(?:\([^)]+\)|\[[^\]]+\])+', stem)" + '\n'
       '    if not lead:\n'
       "        r['error'] = 'No bracket tags at start of filename'\n"
       '        return r\n'
       '\n'
       '    # Extract inner content from both bracket styles\n'
       r"    raw_tags = re.findall(r'(?:\(([^)]+)\)|\[([^\]]+)\])', lead.group(0))" + '\n'
       '    raw_tags = [a or b for a, b in raw_tags]   # each tuple has one non-empty str')
if old in src:
    src = src.replace(old, new, 1); changes += 1
    print('  \u2713  3. _parse_asset_filename')
else:
    print('  \u2717  3. _parse_asset_filename NOT FOUND (already patched?)')

# 4. _fmt_entry — check slot with type fallback
old = ('def _fmt_entry(parsed: dict) -> dict | None:\n'
       '    """Return the first format-type tag entry from a parsed result, or None."""\n'
       "    for t in parsed.get('tags', []):\n"
       "        if t.get('type') == 'format':\n"
       '            return t\n'
       '    return None')
new = ('def _fmt_entry(parsed: dict) -> dict | None:\n'
       '    """Return the first format-slot tag entry from a parsed result, or None.\n'
       "    Checks 'slot' (v1.0 schema) with fallback to legacy 'type' field.\n"
       '    """\n'
       "    for t in parsed.get('tags', []):\n"
       "        if t.get('slot') == 'format' or t.get('type') == 'format':\n"
       '            return t\n'
       '    return None')
if old in src:
    src = src.replace(old, new, 1); changes += 1
    print('  \u2713  4. _fmt_entry')
else:
    print('  \u2717  4. _fmt_entry NOT FOUND (already patched?)')

# 5. Warning message text
old = "        > Please rename using `[TAG1][TAG2]\u2026` convention.\\n'"
new = "        > Please rename using `(Entity)(Angle)(Format)` convention.\\n'"
if old in src:
    src = src.replace(old, new, 1); changes += 1
    print('  \u2713  5. warning text')
else:
    print('  \u2717  5. warning text NOT FOUND (already patched?)')

# 6. Window title
old = '        self.title("\U0001f4e6  Package Collector")'
new = '        self.title("\U0001f4e6  dc-hub")'
if old in src:
    src = src.replace(old, new, 1); changes += 1
    print('  \u2713  6. window title')
else:
    print('  \u2717  6. window title NOT FOUND (already patched?)')

print(f'\n  {changes}/6 changes applied.')

if changes == 0:
    print('  Nothing to do \u2014 file already patched.')
    sys.exit(0)

TARGET.write_text(src, encoding='utf-8')
print(f'  \u2713  Wrote {TARGET} ({len(src)} bytes)')

# Quick smoke test
import importlib.util, types
spec = importlib.util.spec_from_file_location('app_test', TARGET)
mod  = types.ModuleType('app_test')
# Just parse the file for syntax errors
compile(src, str(TARGET), 'exec')
print('  \u2713  Syntax check passed')

# Self-delete
Path(__file__).unlink()
print('  \u2713  patch_v1.py deleted\n')
print('  Done. Commit with:')
print('    git add app.py README.md')
print('    git commit -m "feat: v1.0 \u2014 () brackets, legacy alias resolver, new taxonomy"')
