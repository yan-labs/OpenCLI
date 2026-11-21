#!/usr/bin/env bash
# check-doc-coverage.sh — Verify every adapter in clis/ has a doc page.
#
# Exit codes:
#   0 — all adapters have docs
#   1 — at least one adapter is missing documentation
#
# Usage:
#   bash scripts/check-doc-coverage.sh          # report only
#   bash scripts/check-doc-coverage.sh --strict  # exit 1 on missing docs

set -euo pipefail

STRICT=false
if [[ "${1:-}" == "--strict" ]]; then
  STRICT=true
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

SRC_DIR="$ROOT_DIR/clis"
DOCS_DIR="$ROOT_DIR/docs/adapters"

missing=()
covered=0
total=0

for adapter_dir in "$SRC_DIR"/*/; do
  adapter_name="$(basename "$adapter_dir")"
  # Skip internal directories (e.g., _shared)
  [[ "$adapter_name" == _* ]] && continue
  # Skip directories that only contain utility files (prefixed with _)
  has_commands=false
  for f in "$adapter_dir"*; do
    fname="$(basename "$f")"
    [[ "$fname" == _* ]] && continue
    [[ "$fname" == *.test.* ]] && continue
    has_commands=true
    break
  done
  [[ "$has_commands" == false ]] && continue
  total=$((total + 1))

  # Check for the website adapter's documentation.
  if [[ -f "$DOCS_DIR/browser/$adapter_name.md" ]]; then
    covered=$((covered + 1))
  else
    missing+=("$adapter_name")
  fi
done

echo "📊 Doc Coverage: $covered/$total adapters documented"
echo ""

if [[ ${#missing[@]} -gt 0 ]]; then
  echo "⚠️  Missing docs for ${#missing[@]} adapter(s):"
  for name in "${missing[@]}"; do
    echo "   - $name  →  create docs/adapters/browser/$name.md"
  done
  echo ""
  if $STRICT; then
    echo "❌ Doc check failed (--strict mode)."
    exit 1
  else
    echo "💡 Run with --strict to fail CI on missing docs."
    exit 0
  fi
else
  echo "✅ All adapters have documentation."
  exit 0
fi
