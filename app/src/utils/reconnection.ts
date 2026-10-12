/**
 * Light Protocol compression / prover HTTP endpoints (browser).
 * - Normalizes `.env` values (no trailing slash — avoids double `//` in paths).
 * - Optional fallback when `devnet.lightprotocol.com` is unreachable from localhost.
 * - `fetch` wrapper: minimal headers (CORS-friendly), configurable timeout, retries.
 */

import type { Connection } from "@solana/web3.js";
import { createRpc, type Rpc } from "@lightprotocol/stateless.js";

const DEFAULT_COMPRESSION_PRIMARY = "https://devnet.lightprotocol.com";
const DEFAULT_COMPRESSION_FALLBACK = "https://explorer.devnet.lightprotocol.com";

/** Strip whitespace and trailing slashes (single or repeated). */
export function normalizeLightEndpointUrl(raw: string | undefined | null): string | null {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s) return null;
  while (s.endsWith("/")) {
    s = s.slice(0, -1);
  }
  return s || null;
}

export type LightEndpointPair = {
  compressionApi: string;
  prover: string;
};

function pairsEqual(a: LightEndpointPair, b: LightEndpointPair): boolean {
  return a.compressionApi === b.compressionApi && a.prover === b.prover;
}

/**
 * Ordered endpoint pairs: env first (normalized), then explorer fallback when using Light devnet host.
 */
export function resolveLightEndpointAttempts(
  solanaRpcEndpoint: string,
): LightEndpointPair[] {
  const envComp = normalizeLightEndpointUrl(
    import.meta.env.VITE_LIGHT_COMPRESSION_URL as string | undefined,
  );
  const envProver = normalizeLightEndpointUrl(
    import.meta.env.VITE_LIGHT_PROVER_URL as string | undefined,
  );

  const rpcNorm = normalizeLightEndpointUrl(solanaRpcEndpoint);
  const primaryComp =
    envComp ??
    (rpcNorm && /lightprotocol|helius|compression/i.test(rpcNorm)
      ? rpcNorm
      : DEFAULT_COMPRESSION_PRIMARY);
  const primaryProver = envProver ?? primaryComp;

  const primary: LightEndpointPair = {
    compressionApi: primaryComp,
    prover: primaryProver,
  };

  const out: LightEndpointPair[] = [primary];

  const fb = DEFAULT_COMPRESSION_FALLBACK;
  const wantFallback =
    primary.compressionApi.includes("devnet.lightprotocol.com") &&
    !primary.compressionApi.includes("explorer.devnet.lightprotocol.com");

  if (wantFallback) {
    const fallback: LightEndpointPair = { compressionApi: fb, prover: fb };
    if (!pairsEqual(fallback, primary)) {
      out.push(fallback);
    }
  }

  return out;
}

function isLikelyFetchFailure(e: unknown): boolean {
  if (!e) return false;
  if (e instanceof TypeError) return true;
  if (e instanceof DOMException && e.name === "AbortError") return true;
  const msg = e instanceof Error ? e.message : String(e);
  return /failed to fetch|networkerror|load failed|fetch aborted|aborted|timeout/i.test(
    msg,
  );
}

/** Only headers safe for cross-origin JSON-RPC; drops extra `httpHeaders` from Solana Connection. */
function sanitizeRequestInit(
  init: RequestInit | undefined,
  signal: AbortSignal,
): RequestInit {
  const method = (init?.method ?? "GET").toUpperCase();
  const out: RequestInit = {
    method,
    signal,
    credentials: "omit",
    cache: "no-store",
    referrerPolicy: "no-referrer",
  };
  const headers = new Headers();
  if (init?.headers) {
    const h = new Headers(init.headers as HeadersInit);
    const ct = h.get("content-type");
    if (ct) headers.set("content-type", ct);
  }
  if (
    method !== "GET" &&
    method !== "HEAD" &&
    init?.body != null &&
    !headers.has("content-type")
  ) {
    headers.set("content-type", "application/json");
  }
  if ([...headers].length > 0) {
    out.headers = headers;
  }
  if (init?.body !== undefined) {
    out.body = init.body;
  }
  return out;
}

export function createLightCompatibleFetch(timeoutMs: number): typeof fetch {
  const inner = globalThis.fetch.bind(globalThis);
  return async (input, init) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const parentSignal = init?.signal;
    const onParentAbort = () => controller.abort();
    if (parentSignal) {
      if (parentSignal.aborted) controller.abort();
      else parentSignal.addEventListener("abort", onParentAbort);
    }

    try {
      return await inner(input, sanitizeRequestInit(init, controller.signal));
    } finally {
      clearTimeout(timer);
      if (parentSignal) {
        parentSignal.removeEventListener("abort", onParentAbort);
      }
    }
  };
}

export type LightRpcAttempt = {
  endpoints: LightEndpointPair;
  timeoutMs: number;
};

/**
 * Per host: short timeout first, then long (prover can be slow).
 */
export function buildLightFetchAttempts(endpoints: LightEndpointPair[]): LightRpcAttempt[] {
  const timeouts = [45_000, 120_000];
  const attempts: LightRpcAttempt[] = [];
  for (const e of endpoints) {
    for (const timeoutMs of timeouts) {
      attempts.push({ endpoints: e, timeoutMs });
    }
  }
  return attempts;
}

/**
 * Runs `work(rpc)` retrying on transient fetch failures with longer timeouts and fallback hosts.
 */
export async function withLightRpcRetries<T>(
  connection: Connection,
  work: (rpc: Rpc) => Promise<T>,
): Promise<T> {
  const endpointSets = resolveLightEndpointAttempts(connection.rpcEndpoint);
  const attempts = buildLightFetchAttempts(endpointSets);

  let lastError: unknown;
  for (const a of attempts) {
    try {
      const rpc = createRpc(connection, a.endpoints.compressionApi, a.endpoints.prover, {
        fetch: createLightCompatibleFetch(a.timeoutMs),
      });
      return await work(rpc);
    } catch (e) {
      lastError = e;
      if (!isLikelyFetchFailure(e)) {
        throw e;
      }
    }
  }
  const hint =
    "Light compression/prover unreachable after retries. Set VITE_LIGHT_COMPRESSION_URL / VITE_LIGHT_PROVER_URL (no trailing slash) to a CORS-enabled endpoint (e.g. Helius devnet + compression), or use a tunnel / WSL if localhost is blocked.";
  if (lastError instanceof Error) {
    lastError.message = `${lastError.message}\n\n${hint}`;
    throw lastError;
  }
  throw new Error(`${String(lastError)}\n\n${hint}`);
}
