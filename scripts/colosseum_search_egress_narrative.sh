#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
set -a
source "${SCRIPT_DIR}/colosseum_intel/env.secret"
set +a
BASE="https://copilot.colosseum.com/api/v1"
OUT="${HOME}/colosseum_intel/search_post_egress_narrative.json"
curl -sS -X POST "${BASE}/search/projects" \
  -H "Authorization: Bearer ${COLOSSEUM_COPILOT_PAT}" \
  -H "Content-Type: application/json" \
  -d '{"query":"Solana decompress SPL egress nullifier Light Merkle treasury auditor selective disclosure Anchor Phase 2","limit":25,"diversify":false,"includeDiagnostics":true}' \
  -o "${OUT}"
python3 - <<PY
import json
with open("${OUT}") as f:
    d = json.load(f)
print("totalFound", d.get("totalFound"))
for r in (d.get("results") or [])[:14]:
    h = r.get("hackathon") or {}
    print(" ", r.get("slug"), "|", h.get("slug"))
PY
