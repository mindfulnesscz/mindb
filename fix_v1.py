#!/usr/bin/env python3
"""
Fix script for dc-hub/app.py — run once:
    cd /Users/petrmucha/Sites/localhost/dc-hub
    python3 fix_v1.py
"""
import re
from pathlib import Path

TARGET = Path(__file__).parent / 'app.py'
src = TARGET.read_text(encoding='utf-8')

# ── 1. Replace the entire broken docstring at the top of the file ─────────────
# The docstring is everything from the very start up to the first blank line
# after the closing triple-quote. We use a regex to find and replace it cleanly.
GOOD_DOCSTRING = '''\
#!/usr/bin/env python3
"""
dc-hub  v1.0
-----------------------------------------------------------------------------
Distribute:  scans source for [00] \U0001f4e6 folders, collects files from sibling
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
'''

# Strip everything from the start up to (and including) the closing """
# then prepend the clean docstring.
# The pattern matches: optional BOM, shebang repeated garbage, up through closing """
fixed = re.sub(
    r'^.*?"""\s*\n',   # non-greedy: first """ ... closing """
    GOOD_DOCSTRING,
    src,
    count=1,
    flags=re.DOTALL
)

if fixed == src:
    print('  x  docstring pattern not matched -- inspect the file manually')
else:
    print('  v  docstring fixed')

# ── 2. Fix the warning text (missed in previous patch) ────────────────────────
# Find the exact string that's actually in the file right now
old_warn = "        > Please rename using `[TAG1][TAG2]\\u2026` convention.\\n'"
new_warn = "        > Please rename using `(Entity)(Angle)(Format)` convention.\\n'"

if old_warn in fixed:
    fixed = fixed.replace(old_warn, new_warn, 1)
    print('  v  warning text fixed')
else:
    # Try the literal escaped version that may be in the source
    old_warn2 = "        > Please rename using `[TAG1][TAG2]\u2026` convention.\\n'"
    if old_warn2 in fixed:
        fixed = fixed.replace(old_warn2, new_warn, 1)
        print('  v  warning text fixed (variant 2)')
    else:
        # Search for context around the warning block to find exact string
        m = re.search(r"Please rename using `[^`]+` convention", fixed)
        if m:
            print(f'  i  warning text currently reads: {m.group(0)!r}')
            if '(Entity)' in m.group(0):
                print('  -  warning text already correct, skipping')
            else:
                fixed = re.sub(
                    r"Please rename using `[^`]+` convention",
                    "Please rename using `(Entity)(Angle)(Format)` convention",
                    fixed, count=1
                )
                print('  v  warning text fixed (regex fallback)')
        else:
            print('  x  warning text not found at all')

# ── 3. Syntax check ────────────────────────────────────────────────────────────
try:
    compile(fixed, str(TARGET), 'exec')
    print('  v  syntax OK')
except SyntaxError as e:
    print(f'  x  SyntaxError at line {e.lineno}: {e.msg}')
    print('     File NOT written.')
    raise SystemExit(1)

TARGET.write_text(fixed, encoding='utf-8')
print(f'  v  Wrote {TARGET} ({len(fixed)} bytes)')

Path(__file__).unlink()
print('  v  fix_v1.py deleted')
print()
print('  Done. Now commit:')
print('    git add app.py README.md')
print('    git commit -m "feat: v1.0 -- () brackets, legacy alias resolver, new taxonomy"')
