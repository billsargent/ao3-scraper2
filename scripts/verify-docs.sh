#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

cmp env.example .env.example
cmp env.production.example .env.production.example
cmp env.otw-private.example .env.otw-private.example

for env_file in env.example env.production.example env.otw-private.example; do
  bash -n "$env_file"
  bash -c "set -a; source '$env_file'; set +a"
done

python3 - <<'PY'
from pathlib import Path
import re
root = Path.cwd()
files = [root / "README.md", *sorted((root / "docs").glob("*.md"))]
missing = []
for file in files:
    text = file.read_text(encoding="utf-8")
    for target in re.findall(r"\[[^\]]*\]\(([^)]+)\)", text):
        target = target.split("#", 1)[0]
        if not target or "://" in target or target.startswith("mailto:"):
            continue
        path = (file.parent / target).resolve()
        if not path.exists():
            missing.append(f"{file.relative_to(root)} -> {target}")
if missing:
    raise SystemExit("Missing documentation links:\n" + "\n".join(missing))
print(f"Verified {len(files)} Markdown files and their local links")
PY

if grep -RInE 'Large range discovery still happens|capped at 10,000 IDs|SOURCE_BROWSER_ID|refuses placeholder contact|PostgreSQL collector' README.md docs env*.example; then
  echo "Found stale documentation text" >&2
  exit 1
fi

bash -n scripts/*.sh
echo "Documentation, visible environment samples, links, and shell syntax are valid"
