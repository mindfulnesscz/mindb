#!/bin/bash
set -u

ROOT="${1:-.}"
WIDTH=320
QUALITY=70

find "$ROOT" -type f \( -iname "*.pptx" -o -iname "*.pptm" -o -iname "*.ppt" \) | while IFS= read -r ppt; do
  dir="$(dirname "$ppt")"
  file="$(basename "$ppt")"
  base="${file%.*}"

  out_webp="$dir/${base}-thumb.webp"
  tmpdir="$(mktemp -d)"

  echo "Processing: $ppt"

  # PPT/PPTX -> PDF
  soffice --headless --convert-to pdf --outdir "$tmpdir" "$ppt" >/dev/null 2>&1
  pdf="$tmpdir/${base}.pdf"

  if [ ! -f "$pdf" ]; then
    echo "Failed PDF conversion: $ppt"
    rm -rf "$tmpdir"
    continue
  fi

  # First page only -> PNG
  pdftoppm -png -f 1 -singlefile "$pdf" "$tmpdir/page" >/dev/null 2>&1
  png="$tmpdir/page.png"

  if [ ! -f "$png" ]; then
    echo "Failed PNG render: $ppt"
    rm -rf "$tmpdir"
    continue
  fi

  # Resize + encode to WebP
  cwebp -quiet -resize "$WIDTH" 0 -q "$QUALITY" "$png" -o "$out_webp"

  if [ -f "$out_webp" ]; then
    echo "Created: $out_webp"
  else
    echo "Failed WebP encode: $ppt"
  fi

  rm -rf "$tmpdir"
done