#!/usr/bin/env bash
# Uso único para que Cursor/agent pueda ejecutar Copilot sin ver el PAT en línea:
#   1. cp ~/colosseum_intel/env.example ~/colosseum_intel/env.secret
#   2. Editar env.secret : COLOSSEUM_COPILOT_PAT=...
#   chmod 600 ~/colosseum_intel/env.secret
#
# Opción menos segura pero cómoda (revocá el PAT al terminar): export en ~/.bashrc

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCAL_ENV="${SCRIPT_DIR}/colosseum_intel/env.secret"
HOME_ENV="${HOME}/colosseum_intel/env.secret"

if [[ -f "$LOCAL_ENV" ]]; then
  ENV_FILE="$LOCAL_ENV"
elif [[ -f "$HOME_ENV" ]]; then
  ENV_FILE="$HOME_ENV"
else
  echo "Falta token: crea uno de:" >&2
  echo "  $LOCAL_ENV  (copiá desde scripts/colosseum_intel/env.example)" >&2
  echo "  $HOME_ENV" >&2
  echo "Alternativa temporal: export COLOSSEUM_COPILOT_PAT en ~/.bashrc" >&2
  exit 1
fi

OUT_DIR="${HOME}/colosseum_intel"
mkdir -p "$OUT_DIR"

# shellcheck source=/dev/null
set -a
source "$ENV_FILE"
set +a

BASE="${COLOSSEUM_COPILOT_API_BASE:-https://copilot.colosseum.com/api/v1}"
BASE="${BASE%/}"

curl -sS -H "Authorization: Bearer ${COLOSSEUM_COPILOT_PAT}" "${BASE}/status"
echo

curl -sS -H "Authorization: Bearer ${COLOSSEUM_COPILOT_PAT}" "${BASE}/filters" -o "${OUT_DIR}/filters.json"
wc -c "${OUT_DIR}/filters.json"

curl -sS -X POST "${BASE}/search/projects" \
  -H "Authorization: Bearer ${COLOSSEUM_COPILOT_PAT}" \
  -H "Content-Type: application/json" \
  -d '{"query":"Solana treasury privacy auditor selective disclosure Light compressed state CPI","limit":25,"diversify":false,"includeDiagnostics":true}' \
  -o "${OUT_DIR}/search_reserved_like.json"

curl -sS -X POST "${BASE}/analyze" \
  -H "Authorization: Bearer ${COLOSSEUM_COPILOT_PAT}" \
  -H "Content-Type: application/json" \
  -d '{"cohort":{"hackathons":["radar","breakout","cypherpunk"],"winnersOnly":true},"dimensions":["problemTags","solutionTags","techStack","primitives"],"topK":20,"samplePerBucket":2}' \
  -o "${OUT_DIR}/analyze_winners_recent.json"

ls -la "$OUT_DIR"
