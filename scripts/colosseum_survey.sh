#!/usr/bin/env bash
# One-off Colosseum Copilot corpus queries — requires COLOSSEUM_COPILOT_PAT in env (e.g. ~/.bashrc).
set -euo pipefail
BASE="${COLOSSEUM_COPILOT_API_BASE-}"
if [[ -z "${BASE}" ]]; then
  BASE="https://copilot.colosseum.com/api/v1"
fi
BASE="${BASE%/}"
if [[ -z "${COLOSSEUM_COPILOT_PAT:-}" ]]; then
  echo "COLOSSEUM_COPILOT_PAT unset" >&2
  exit 1
fi

HDR=(-H "Authorization: Bearer ${COLOSSEUM_COPILOT_PAT}" -H "Content-Type: application/json")

echo "=== /status ==="
curl -sS "${HDR[@]}" "$BASE/status"
echo

echo "=== Saving /filters to /tmp/colosseum_filters.json ==="
curl -sS "${HDR[@]}" "$BASE/filters" -o /tmp/colosseum_filters.json
python3 - "$@" <<'PY'
import json, re, sys
p = "/tmp/colosseum_filters.json"
with open(p, encoding="utf-8") as f:
    data = json.load(f)
for dim in ("problemTags","solutionTags","techStack","primitives"):
    arr = data.get(dim) or []
    keys = [(x.get("tag") or x.get("key"), x.get("count")) for x in arr if isinstance(x, dict)]
    needle = re.compile(r"(privacy|treasury|compress|compression|light\s*protocol|zero[\s-]?knowledge|zk)", re.I)
    hits = [(t, c) for t, c in keys if t and needle.search(str(t))]
    print(f"\n-- {dim}: {len(arr)} total, {len(hits)} matching privacy/treasury/compress/zk/light --")
    for t, c in sorted(hits, key=lambda x: -x[1])[:40]:
        print(f"  {t!r}: {c}")
PY

echo
echo "=== filter-only search: problemTags Privacy (limit 25) ==="
curl -sS -X POST "$BASE/search/projects" "${HDR[@]}" -d '{"limit":25,"filters":{"problemTags":["Privacy"]},"includeDiagnostics":true}' | python3 -c "import json,sys; d=json.load(sys.stdin); print('totalFound',d.get('totalFound')); print('n',len(d.get('results')or[])); [print(r.get('slug'), r.get('hackathon',{}).get('slug'), r.get('prize'), r.get('accelerator')) for r in (d.get('results')or[])[:25]]"

echo
echo "=== filter-only: primitives state compression (try tag) ==="
curl -sS -X POST "$BASE/search/projects" "${HDR[@]}" -d '{"limit":25,"filters":{"primitives":["State Compression"]}}' | python3 -c "import json,sys; d=json.load(sys.stdin); print('keys err', d.get('error')); print('totalFound',d.get('totalFound')); print('n',len(d.get('results')or[]))" 2>/dev/null || true

echo
echo "=== text search: Light Protocol CPI (limit 25 diversify false) ==="
curl -sS -X POST "$BASE/search/projects" "${HDR[@]}" -d '{"query":"Light Protocol CPI invoke compressed account","limit":25,"diversify":false,"includeDiagnostics":true}' | python3 -c "import json,sys; d=json.load(sys.stdin); print('totalFound',d.get('totalFound')); rs=d.get('results')or[]; print('returned',len(rs));
for r in rs[:15]:
  print('-',r.get('slug'), r.get('hackathon',{}).get('slug'), 'winner' if r.get('prize') else '', 'accel' if r.get('accelerator') else '')"

echo
echo "=== cohort: recent hackathons winners — problemTags top (analyze) ==="
curl -sS -X POST "$BASE/analyze" "${HDR[@]}" -d '{
  "cohort": {"hackathons": ["radar","breakout","cypherpunk"],"winnersOnly": true},
  "dimensions": ["problemTags","solutionTags","techStack","primitives"],
  "topK": 25,
  "samplePerBucket": 2
}' | python3 -c "import json,sys; d=json.load(sys.stdin); print('totals', d.get('totals')); b=d.get('buckets') or {}; 
import re
needle=re.compile(r'(privacy|treasury|compress|light)',re.I)
for dim in ('problemTags','solutionTags','techStack','primitives'):
  print('\n##',dim)
  for bucket in (b.get(dim) or [])[:30]:
    lab=bucket.get('label') or bucket.get('key')
    if not lab or not needle.search(str(lab)): continue
    print(bucket.get('key'), lab, 'count', bucket.get('count'), 'share', bucket.get('share'))
"

echo "Done."
