/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_RPC_URL?: string;
  readonly VITE_RESERVED_PROGRAM_ID?: string;
  /** Institutional SPL treasury mint (Base58). Required — set in app/.env */
  readonly VITE_USDC_MINT?: string;
  /** Light Protocol compression JSON-RPC — no trailing slash (see `utils/reconnection.ts`). */
  readonly VITE_LIGHT_COMPRESSION_URL?: string;
  /** Light prover endpoint — no trailing slash; defaults to compression URL. */
  readonly VITE_LIGHT_PROVER_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
