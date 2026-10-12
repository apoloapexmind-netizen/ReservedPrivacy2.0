#!/usr/bin/env python3
"""
Colosseum Copilot API helper. Fixes common mistake: api.colosseum.org/v1 is NOT Copilot.

Skill default: https://copilot.colosseum.com/api/v1
Requires: COLOSSEUM_COPILOT_PAT in environment (see ~/.bashrc).
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request

# Official Copilot API base (must include /api/v1, not just /v1 on another host).
DEFAULT_BASE = "https://copilot.colosseum.com/api/v1"


def effective_base() -> str:
    raw = (os.environ.get("COLOSSEUM_COPILOT_API_BASE") or "").strip().rstrip("/")
    if not raw:
        return DEFAULT_BASE
    if "api.colosseum.org" in raw:
        print(
            "warning: COLOSSEUM_COPILOT_API_BASE points at api.colosseum.org — "
            "using Copilot host instead (that URL returns Cannot POST /v1/...)",
            file=sys.stderr,
        )
        return DEFAULT_BASE
    if "copilot.colosseum.com" not in raw:
        print(
            f"warning: unexpected API base {raw!r}; expected host copilot.colosseum.com",
            file=sys.stderr,
        )
    return raw


def request_json(method: str, path: str, body: dict | None, base: str, pat: str) -> dict:
    url = f"{base.rstrip('/')}{path}"
    data = None if body is None else json.dumps(body).encode("utf-8")
    headers = {
        "Authorization": f"Bearer {pat}",
        "Content-Type": "application/json",
        "Accept": "application/json",
        # Cloudflare may block urllib's default User-Agent; curl usually passes.
        "User-Agent": "curl/8.5.0",
    }
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        err_body = e.read().decode("utf-8", errors="replace")[:800]
        raise SystemExit(f"HTTP {e.code} {url}\n{err_body}") from e


def run_renaissance_winners(base: str, pat: str) -> dict:
    """
    Pitch research: what judges rewarded in Solana Renaissance (Mar–Apr 2024 cohort).
    API uses camelCase winnersOnly (not winners_only).

    POST /search/projects rejects filters.hackathons — we paginate all prize winners
    and keep rows where hackathon.slug == "renaissance".
    """
    out: dict = {}
    out["renaissance_winners_analyze"] = request_json(
        "POST",
        "/analyze",
        {
            "cohort": {"hackathons": ["renaissance"], "winnersOnly": True},
            "dimensions": ["tracks", "problemTags", "solutionTags", "techStack", "clusters"],
            "topK": 12,
            "samplePerBucket": 3,
        },
        base,
        pat,
    )
    renaissance_rows: list[dict] = []
    offset = 0
    page_limit = 25
    while offset < 800:
        page = request_json(
            "POST",
            "/search/projects",
            {
                "limit": page_limit,
                "offset": offset,
                "filters": {"winnersOnly": True},
                "diversify": False,
            },
            base,
            pat,
        )
        for row in page.get("results") or []:
            h = row.get("hackathon") or {}
            if h.get("slug") == "renaissance":
                renaissance_rows.append(row)
        if not page.get("hasMore"):
            break
        offset += page_limit

    out["renaissance_winners_projects"] = {
        "results": renaissance_rows,
        "filteredHackathon": "renaissance",
        "count": len(renaissance_rows),
        "note": "Built by paginating search/projects winnersOnly:true and filtering client-side.",
    }
    return out


def main() -> None:
    parser = argparse.ArgumentParser(description="Colosseum Copilot API batch queries")
    parser.add_argument(
        "--renaissance-winners",
        action="store_true",
        help="Analyze + list Renaissance hackathon winners only (judge signal for pitch)",
    )
    args = parser.parse_args()

    pat = os.environ.get("COLOSSEUM_COPILOT_PAT", "").strip()
    if not pat:
        sys.exit("Set COLOSSEUM_COPILOT_PAT (e.g. in ~/.bashrc)")

    base = effective_base()
    print(f"Using API base: {base}", file=sys.stderr)

    # Preflight (optional but matches SKILL)
    status = request_json("GET", "/status", None, base, pat)
    print("status:", json.dumps(status, indent=2), file=sys.stderr)
    if not status.get("authenticated"):
        sys.exit("PAT not authenticated according to /status")

    if args.renaissance_winners:
        print(
            "note: Renaissance = Mar–Apr 2024. For the latest Colosseum edition use "
            "slug from GET /filters (e.g. cypherpunk).",
            file=sys.stderr,
        )
        out = run_renaissance_winners(base, pat)
        print(json.dumps(out, indent=2, ensure_ascii=False))
        return

    queries: list[tuple[str, str, dict]] = [
        (
            "token2022_light_compression",
            "/search/projects",
            {
                "query": "Token-2022 confidential transfer Light Protocol ZK compression",
                "limit": 15,
                "filters": {"winnersOnly": False, "acceleratorOnly": False},
                "diversify": False,
            },
        ),
        (
            "selective_disclosure_audit",
            "/search/projects",
            {
                "query": "selective disclosure viewing keys corporate audit SPL tokens",
                "limit": 15,
                "filters": {"winnersOnly": False, "acceleratorOnly": False},
                "diversify": False,
            },
        ),
        (
            "zcash_archives",
            "/search/archives",
            {
                "query": "Zcash viewing keys selective disclosure auditability",
                "limit": 5,
                "maxChunksPerDoc": 1,
            },
        ),
    ]

    out: dict[str, dict] = {}
    for key, path, body in queries:
        out[key] = request_json("POST", path, body, base, pat)

    print(json.dumps(out, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
