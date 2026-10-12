import { Buffer } from "buffer";
import {
  AnchorProvider,
  BN,
  type Idl,
  Program,
  type Wallet,
} from "@coral-xyz/anchor";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createInitializeMint2Instruction,
  getAssociatedTokenAddressSync,
  getMinimumBalanceForRentExemptMint,
} from "@solana/spl-token";
import {
  ConnectionProvider,
  WalletProvider,
} from "@solana/wallet-adapter-react";
import {
  WalletModalProvider,
  WalletMultiButton,
} from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import { SolflareWalletAdapter } from "@solana/wallet-adapter-solflare";
import {
  type Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { useCallback, useEffect, useMemo, useRef, useState, type FC, type PropsWithChildren } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";

// IDL — copy kept in-repo so UI stays aligned with program/Anchor build (sync from `target/idl/reserved.json` after IDL changes).
import idlRaw from "./idl/reserved.json";
import { sendShieldZkTx, wipeZkShieldVolatile } from "./shieldCompressed";

import "@solana/wallet-adapter-react-ui/styles.css";

/** Wallet-adapter `FC` types can disagree with React 18 JSX; cast for the root provider only. */
const RootConnectionProvider = ConnectionProvider as unknown as FC<
  PropsWithChildren<{ endpoint: string }>
>;

/**
 * Must match the deployed RESERVED program authority (see Anchor.toml).
 * Override with `VITE_RESERVED_PROGRAM_ID` if client and chain drift.
 */
const RESERVED_PROGRAM_ADDRESS =
  (import.meta.env.VITE_RESERVED_PROGRAM_ID as string | undefined)?.trim() ||
  "BA5QxMGYW132ELKZ58jJ7hDjKNHSPB52hfmuwiYGDNYR";

const idl = { ...idlRaw } as Idl;
delete (idl as any).address;

const PROGRAM_ID = new PublicKey(RESERVED_PROGRAM_ADDRESS);
idl.address = RESERVED_PROGRAM_ADDRESS;

const SEED_VAULT = Buffer.from("vault_cfg");
const SEED_ESCROW = Buffer.from("pub_escrow");
const SEED_NOTE = Buffer.from("note_head");
const SEED_AUDIT = Buffer.from("audit_pol");

const DEVNET_RPC =
  import.meta.env.VITE_RPC_URL ?? "https://api.devnet.solana.com";

/** SPL treasury mint (must match deployment intent). Single source: `VITE_USDC_MINT` in app/.env */
function readConfiguredUsdcMint(): PublicKey {
  const s = import.meta.env.VITE_USDC_MINT?.trim();
  if (!s) {
    throw new Error(
      "VITE_USDC_MINT is not set. Add it to app/.env for program/UI synchronization.",
    );
  }
  try {
    return new PublicKey(s);
  } catch {
    throw new Error(`Invalid VITE_USDC_MINT (expected Base58 mint): ${s}`);
  }
}

const CONFIGURED_USDC_MINT = readConfiguredUsdcMint();
const USDC_DECIMALS = 6;

const SHADOW_BALANCE_MESSAGE_BASE =
  "RESERVED_BA5Q/SHADOW_BALANCE_V1 — prove vault authority to view vault ATA balance.";

const BUNKER_DEP_SCHEMA = new TextEncoder().encode("RESV/bunker_dep:v1");
const BUNKER_WDR_SCHEMA = new TextEncoder().encode("RESV/bunker_wdr:v1");

const BUNKER_OPENING_LEN = 40;

/** localStorage: BA5Q bunker SPL mint (new PDA after `VaultConfig` layout changes). */
const LS_BA5Q_MINT = "reserved.ba5q.mintPubkey";
const LS_BA5Q_SCHEMA = "reserved.ba5q.schemaVersion";
/** Bump when on-chain `VaultConfig` layout changes (forces new mint / PDA bookkeeping). */
const BA5Q_LS_SCHEMA = "vaultcfg-186-v2";

function purgeReservedVaultLocalStorage() {
  const keys = [
    LS_BA5Q_MINT,
    "reserved.ba5q.vaultMint",
    "reserved.ops.vaultMint",
    "reserved.vaultConfigHint",
  ];
  for (const k of keys) {
    try {
      localStorage.removeItem(k);
    } catch {
      /* ignore */
    }
  }
}

function loadBa5qMintFromLs(): PublicKey | null {
  try {
    const s = localStorage.getItem(LS_BA5Q_MINT)?.trim();
    if (!s) return null;
    return new PublicKey(s);
  } catch {
    return null;
  }
}

function persistBa5qMint(pk: PublicKey) {
  localStorage.setItem(LS_BA5Q_MINT, pk.toBase58());
}

/** True when mint matches `VITE_USDC_MINT` (institutional treasury). */
function isUsdcDevnetMint(pk: PublicKey): boolean {
  return pk.equals(CONFIGURED_USDC_MINT);
}

function solscanTx(sig: string) {
  return `https://solscan.io/tx/${sig}?cluster=devnet`;
}

function parsePubkey(s: string, label: string): PublicKey {
  try {
    return new PublicKey(s.trim());
  } catch {
    throw new Error(`Invalid ${label}`);
  }
}

function bytes32FromHexOrFill(hex: string, fill: number): number[] {
  const t = hex.trim().replace(/^0x/i, "");
  if (t.length === 64) {
    const out: number[] = [];
    for (let i = 0; i < 32; i++) {
      out.push(parseInt(t.slice(i * 2, i * 2 + 2), 16));
    }
    return out;
  }
  return Array(32).fill(fill & 0xff);
}

function isBytes32FilledWith(bytes: ArrayLike<number>, value: number): boolean {
  const v = value & 0xff;
  if (bytes.length !== 32) return false;
  for (let i = 0; i < 32; i += 1) {
    if (bytes[i] !== v) return false;
  }
  return true;
}

function deriveVaultConfig(programId: PublicKey, mint: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [SEED_VAULT, mint.toBuffer()],
    programId,
  );
}

function deriveVaultAuthority(programId: PublicKey, mint: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [SEED_ESCROW, mint.toBuffer()],
    programId,
  );
}

function deriveUserNoteHead(
  programId: PublicKey,
  spend: PublicKey,
  vaultConfig: PublicKey,
) {
  return PublicKey.findProgramAddressSync(
    [SEED_NOTE, spend.toBuffer(), vaultConfig.toBuffer()],
    programId,
  );
}

function deriveAuditorPolicy(programId: PublicKey, vaultConfig: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [SEED_AUDIT, vaultConfig.toBuffer()],
    programId,
  );
}

/** SPL Token-legacy mint + RESERVED VaultConfig + vault custodian ATA (from `initialize_vault`). */
type VaultProvisionState =
  | { kind: "no_mint" }
  | { kind: "mint_not_found"; mint: PublicKey }
  | { kind: "mint_program_mismatch"; owner: PublicKey }
  | { kind: "needs_init"; vaultConfig: PublicKey; vaultTokenAta: PublicKey }
  | { kind: "ata_missing"; vaultConfig: PublicKey; vaultTokenAta: PublicKey }
  | { kind: "ready" };

async function getVaultProvisionState(
  conn: Connection,
  programId: PublicKey,
  mint: PublicKey | null,
): Promise<VaultProvisionState> {
  if (!mint) return { kind: "no_mint" };
  const mintInfo = await conn.getAccountInfo(mint);
  if (!mintInfo)
    return { kind: "mint_not_found", mint };
  if (!mintInfo.owner.equals(TOKEN_PROGRAM_ID))
    return { kind: "mint_program_mismatch", owner: mintInfo.owner };

  const [vaultConfig] = deriveVaultConfig(programId, mint);
  const vcInfo = await conn.getAccountInfo(vaultConfig);
  const [vaultAuthority] = deriveVaultAuthority(programId, mint);
  const vaultTokenAta = getAssociatedTokenAddressSync(
    mint,
    vaultAuthority,
    true,
    TOKEN_PROGRAM_ID,
  );

  if (!vcInfo || !vcInfo.owner.equals(programId)) {
    return { kind: "needs_init", vaultConfig, vaultTokenAta };
  }

  const ataInfo = await conn.getAccountInfo(vaultTokenAta);
  if (!ataInfo)
    return { kind: "ata_missing", vaultConfig, vaultTokenAta };

  return { kind: "ready" };
}

function formatProvisionBlocker(s: VaultProvisionState): string | null {
  switch (s.kind) {
    case "no_mint":
      return null;
    case "mint_not_found":
      return `Treasury mint account was not found on this RPC (${s.mint.toBase58()}). Confirm VITE_RPC_URL / cluster and that the mint exists on Devnet.`;
    case "mint_program_mismatch": {
      const o = s.owner.toBase58();
      if (s.owner.equals(TOKEN_2022_PROGRAM_ID)) {
        return `This mint is owned by Token-2022 (${o}). RESERVED's on-chain initializer expects a legacy SPL Token mint (owner ${TOKEN_PROGRAM_ID.toBase58()}). Use Devnet USDC or "Create test mint" — not a Token-2022 mint.`;
      }
      return `Mint owner ${o} is not the legacy SPL Token program. initialize_vault cannot proceed with this mint.`;
    }
    case "needs_init":
      return null;
    case "ata_missing":
      return `VaultConfig exists but the vault token account is missing — contact engineering (unexpected state). VaultConfig: ${s.vaultConfig.toBase58()}`;
    case "ready":
      return null;
    default:
      return null;
  }
}

function u64LeBuf(n: bigint): Buffer {
  const out = Buffer.allocUnsafe(8);
  let x = n;
  for (let i = 0; i < 8; i++) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

function concatUint8Arrays(parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

async function sha256Bytes(data: Uint8Array): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", data as BufferSource);
  return new Uint8Array(digest);
}

function randomBlinding32(): Uint8Array {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return b;
}

/** Best-effort zeroing of SBED ed25519 session signature; `session_nonce` remains only in React state. */
function wipeShadowBunkerSession(ref: {
  current: { signature: Uint8Array } | null;
}) {
  const cur = ref.current;
  if (cur) {
    cur.signature.fill(0);
  }
  ref.current = null;
}

function buildBunkerOpening(amountRaw: bigint): {
  opening: Buffer;
  blinding: Uint8Array;
} {
  const blinding = randomBlinding32();
  const opening = Buffer.alloc(BUNKER_OPENING_LEN);
  u64LeBuf(amountRaw).copy(opening, 0);
  Buffer.from(blinding).copy(opening, 8);
  return { opening, blinding };
}

async function bunkerDepositCommitmentBytes(
  amountRaw: bigint,
  blinding: Uint8Array,
  depositor: PublicKey,
  vaultConfigPk: PublicKey,
  mint: PublicKey,
  chainIdHash: Uint8Array,
  programId: PublicKey,
): Promise<Uint8Array> {
  const payload = concatUint8Arrays([
    BUNKER_DEP_SCHEMA,
    new Uint8Array(u64LeBuf(amountRaw)),
    blinding,
    new Uint8Array(depositor.toBytes()),
    new Uint8Array(vaultConfigPk.toBytes()),
    new Uint8Array(mint.toBytes()),
    chainIdHash,
    new Uint8Array(programId.toBytes()),
  ]);
  return sha256Bytes(payload);
}

async function bunkerWithdrawCommitmentBytes(
  amountRaw: bigint,
  blinding: Uint8Array,
  authority: PublicKey,
  vaultConfigPk: PublicKey,
  mint: PublicKey,
  chainIdHash: Uint8Array,
  programId: PublicKey,
): Promise<Uint8Array> {
  const payload = concatUint8Arrays([
    BUNKER_WDR_SCHEMA,
    new Uint8Array(u64LeBuf(amountRaw)),
    blinding,
    new Uint8Array(authority.toBytes()),
    new Uint8Array(vaultConfigPk.toBytes()),
    new Uint8Array(mint.toBytes()),
    chainIdHash,
    new Uint8Array(programId.toBytes()),
  ]);
  return sha256Bytes(payload);
}

function deriveCofreVaultAtas(programId: PublicKey, depositMint: PublicKey) {
  const [vaultConfig] = deriveVaultConfig(programId, depositMint);
  const [vaultAuthority] = deriveVaultAuthority(programId, depositMint);
  const vaultTokenAccount = getAssociatedTokenAddressSync(
    depositMint,
    vaultAuthority,
    true,
    TOKEN_PROGRAM_ID,
  );
  return { vaultConfig, vaultAuthority, vaultTokenAccount };
}

async function fetchReservedVaultTokenBalance(
  connection: Connection,
  programId: PublicKey,
  depositMint: PublicKey,
): Promise<{
  uiAmount: string;
  rawAmount: string;
  decimals: number;
  vaultAta58: string;
} | null> {
  const { vaultTokenAccount } = deriveCofreVaultAtas(
    programId,
    depositMint,
  );
  try {
    const { value } = await connection.getTokenAccountBalance(vaultTokenAccount);
    return {
      uiAmount: value.uiAmountString ?? String(value.uiAmount ?? "0"),
      rawAmount: value.amount,
      decimals: value.decimals,
      vaultAta58: vaultTokenAccount.toBase58(),
    };
  } catch {
    return null;
  }
}

function walletToAnchorWallet(
  w: ReturnType<typeof useWallet>,
): Wallet | null {
  if (!w.publicKey || !w.signTransaction || !w.signAllTransactions) return null;
  return {
    publicKey: w.publicKey,
    signTransaction: w.signTransaction.bind(w),
    signAllTransactions: w.signAllTransactions.bind(w),
  } as unknown as Wallet;
}

type VaultOverviewProps = {
  cofreReady: boolean;
  cofreBalance: {
    uiAmount: string;
    rawAmount: string;
    decimals: number;
    vaultAta58: string;
  } | null;
  cofreBalanceBusy: boolean;
  cofreBalanceHint: string | null;
  cofreShadowUnlocked: boolean;
  cofreShadowBusy: boolean;
  sbedSessionReady: boolean;
  vaultAuthorityPk: PublicKey | null;
  onUnlockShadow: () => void;
  onLockShadow: () => void;
  onRefresh: () => void;
};

function VaultOverviewCard({
  cofreReady,
  cofreBalance,
  cofreBalanceBusy,
  cofreBalanceHint,
  cofreShadowUnlocked,
  cofreShadowBusy,
  sbedSessionReady,
  vaultAuthorityPk,
  onUnlockShadow,
  onLockShadow,
  onRefresh,
}: VaultOverviewProps) {
  return (
    <section className="inst-card mb-10">
      <div className="flex flex-wrap items-start justify-between gap-4 leading-relaxed">
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-inst-accent">
            SBED · Authentication
          </p>
          <h2 className="mt-2 text-2xl font-semibold tracking-tight text-inst-navy">
            Digital Vault
          </h2>
          <p className="mt-3 max-w-xl text-sm leading-relaxed text-inst-muted">
            Vault balance remains private until you authenticate as the on-chain vault authority.
            Session credentials exist only in volatile memory.
          </p>
        </div>
      </div>

      <div className="inst-frost mt-8 p-6 shadow-inst">
        <div className="text-xs font-medium uppercase tracking-wider text-inst-muted">
          Custodied balance
        </div>
        {!cofreShadowUnlocked ? (
          <div className="mt-6 space-y-5">
            <div className="relative flex min-h-[5.5rem] items-center justify-center rounded-xl bg-white/60 px-4 py-6 backdrop-blur-md">
              <span className="select-none font-mono text-4xl font-semibold tracking-[0.35em] text-inst-navy/25">
                ∗∗∗∗
              </span>
            </div>
            <p className="text-sm leading-relaxed text-inst-muted">
              Authenticate to reveal assets. Numeric balances are not shown until verification
              succeeds.
            </p>
            {!sbedSessionReady ? (
              <p className="text-sm font-medium text-amber-700">
                Connect a wallet to initialize the session.
              </p>
            ) : null}
            {vaultAuthorityPk ? (
              <p className="break-all font-mono text-xs text-inst-muted">
                Expected authority:{" "}
                <span className="text-inst-navy/80">{vaultAuthorityPk.toBase58()}</span>
              </p>
            ) : null}
            <button
              type="button"
              disabled={!cofreReady || cofreShadowBusy || !sbedSessionReady}
              onClick={onUnlockShadow}
              className="w-full rounded-inst bg-inst-navy py-4 text-sm font-semibold text-white shadow-inst transition hover:bg-inst-navy/90 disabled:cursor-not-allowed disabled:opacity-45"
            >
              {cofreShadowBusy ? "Authenticating…" : "Authenticate to Reveal Assets"}
            </button>
          </div>
        ) : cofreBalanceBusy ? (
          <div className="mt-6 text-sm font-medium text-inst-accent">Loading balance…</div>
        ) : cofreBalance ? (
          <div className="mt-6 space-y-4">
            <div className="font-mono text-4xl font-semibold text-inst-navy">{cofreBalance.uiAmount}</div>
            <p className="text-xs text-inst-muted">
              USDC in protocol custody (vault token account)
            </p>
            <button
              type="button"
              onClick={onLockShadow}
              className="text-sm font-medium text-inst-accent underline-offset-4 hover:underline"
            >
              Hide balance
            </button>
          </div>
        ) : (
          <div className="mt-6 text-sm text-amber-800">{cofreBalanceHint ?? "—"}</div>
        )}
      </div>

      <div className="mt-6 flex flex-wrap gap-3">
        <button
          type="button"
          disabled={!cofreReady || !cofreShadowUnlocked}
          onClick={onRefresh}
          className="rounded-inst border border-inst-border bg-inst-surface px-5 py-2.5 text-sm font-medium text-inst-navy shadow-sm transition hover:border-inst-accent/40 disabled:cursor-not-allowed disabled:opacity-45"
        >
          Refresh balance
        </button>
      </div>
    </section>
  );
}

type VaultAdvancedCofreProps = {
  cofreReady: boolean;
  cofreShadowUnlocked: boolean;
  bunkerShadowMeta: { seq: string; rootHex: string } | null;
  cofreAmount: string;
  onCofreAmountChange: (v: string) => void;
  userCofreAta: PublicKey | null;
  vaultCofreAta: PublicKey | null;
  ba5qMintDisplay: string;
  onDeposit: () => void;
  onWithdraw: () => void;
  walletBunkerBalance: {
    uiAmount: string;
    rawAmount: string;
    decimals: number;
  } | null;
  walletBunkerBalanceBusy: boolean;
  onRefreshWalletBunkerBalance: () => void;
  onUseMaxWalletRaw: () => void;
  bunkerUsesUsdc: boolean;
  vaultOpsReady: boolean;
  vaultOpsHint: string | null;
};

function VaultAdvancedCofrePanel({
  cofreReady,
  cofreShadowUnlocked,
  bunkerShadowMeta,
  cofreAmount,
  onCofreAmountChange,
  userCofreAta,
  vaultCofreAta,
  ba5qMintDisplay,
  onDeposit,
  onWithdraw,
  walletBunkerBalance,
  walletBunkerBalanceBusy,
  onRefreshWalletBunkerBalance,
  onUseMaxWalletRaw,
  bunkerUsesUsdc,
  vaultOpsReady,
  vaultOpsHint,
}: VaultAdvancedCofreProps) {
  return (
    <section className="inst-card space-y-5 !p-6">
      <div>
        <h3 className="text-sm font-semibold uppercase tracking-wide text-inst-navy">
          Vault operations (raw units)
        </h3>
        <p className="mt-2 break-all text-xs leading-relaxed text-inst-muted">
          Bunker mint identifier:{" "}
          <span className="text-sm text-inst-navy" title={ba5qMintDisplay}>
            {ba5qMintDisplay}
          </span>
        </p>
      </div>
      {!vaultOpsReady && vaultOpsHint ? (
        <div
          role="alert"
          className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-relaxed text-amber-950"
        >
          {vaultOpsHint}
        </div>
      ) : null}
      <div className="grid gap-4 text-xs text-inst-muted md:grid-cols-2 md:text-sm">
        <div className="rounded-xl border border-inst-border bg-inst-bg p-4">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-inst-navy">
            Your ATA
          </div>
          <p className="mt-2 break-all leading-relaxed text-inst-navy">
            {userCofreAta?.toBase58() ?? "—"}
          </p>
        </div>
        <div className="rounded-xl border border-inst-border bg-inst-bg p-4">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-inst-navy">
            Vault ATA
          </div>
          <p className="mt-2 break-all leading-relaxed text-inst-navy">
            {cofreShadowUnlocked && vaultCofreAta
              ? vaultCofreAta.toBase58()
              : "— (disclosed after SBED authentication)"}
          </p>
        </div>
      </div>
      <div className="rounded-xl border border-inst-border bg-inst-surface/80 p-4">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="font-medium text-inst-navy">Wallet balance (bunker mint)</span>
          {bunkerUsesUsdc ? (
            <span className="rounded-full border border-inst-border bg-inst-bg px-2 py-0.5 text-[10px] font-medium text-inst-navy">
              Devnet USDC
            </span>
          ) : null}
          <button
            type="button"
            disabled={!userCofreAta || !cofreReady}
            onClick={onRefreshWalletBunkerBalance}
            className="inst-btn !py-1.5 !text-xs disabled:opacity-40"
          >
            {walletBunkerBalanceBusy ? "…" : "Refresh"}
          </button>
        </div>
        {walletBunkerBalance ? (
          <p className="mt-3 text-sm leading-relaxed text-inst-navy">
            {walletBunkerBalance.uiAmount}{" "}
            <span className="text-xs text-inst-muted">
              (raw units: {walletBunkerBalance.rawAmount})
            </span>
          </p>
        ) : (
          <p className="mt-3 text-sm text-inst-muted">
            No token account or zero balance. First deposit may create your ATA.
          </p>
        )}
        <button
          type="button"
          disabled={!walletBunkerBalance || BigInt(walletBunkerBalance.rawAmount) === 0n}
          onClick={onUseMaxWalletRaw}
          className="inst-btn-ghost mt-3 !px-0 !py-1 text-xs text-inst-accent underline-offset-4 hover:underline disabled:opacity-40"
        >
          Use wallet maximum in amount field
        </button>
      </div>
      <label className="block text-sm font-medium text-inst-navy">
        Amount (raw u64) — deposit / withdraw
        <input
          className="inst-input font-sans text-sm"
          value={cofreAmount}
          onChange={(e) => onCofreAmountChange(e.target.value)}
        />
      </label>
      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          disabled={!cofreReady || !vaultCofreAta || !vaultOpsReady}
          onClick={onDeposit}
          className="inst-btn-primary"
        >
          Deposit to vault
        </button>
        <button
          type="button"
          disabled={!cofreReady || !vaultCofreAta || !vaultOpsReady}
          onClick={onWithdraw}
          className="inst-btn"
        >
          Withdraw from vault
        </button>
      </div>
      <p className="text-xs leading-relaxed text-inst-muted">
        Withdrawals require the on-chain vault authority; settled assets return to your associated
        token account.
      </p>
      {cofreShadowUnlocked && bunkerShadowMeta ? (
        <div className="rounded-xl border border-inst-border bg-inst-bg p-4 text-xs text-inst-muted">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-inst-navy">
            Auditable digest
          </div>
          <p className="mt-2 text-sm text-inst-navy">Sequence {bunkerShadowMeta.seq}</p>
          <p className="mt-1 break-all text-[11px] leading-relaxed text-inst-navy/90">
            {bunkerShadowMeta.rootHex}
          </p>
        </div>
      ) : null}
    </section>
  );
}

function ComplianceStatusBadge({
  status,
}: {
  status: "VERIFIED" | "ENCRYPTED";
}) {
  const ok = status === "VERIFIED";
  return (
    <span
      className={`inline-flex items-center rounded border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.06em] ${
        ok
          ? "border-inst-navy/25 bg-inst-navy/[0.06] text-inst-navy"
          : "border-inst-navy/15 bg-inst-surface text-inst-muted"
      }`}
    >
      [ {status} ]
    </span>
  );
}

function usdcUiStringToRawUnits(ui: string, decimals: number): bigint {
  const t = ui.trim();
  if (!t) return 0n;
  if (!/^\d*(\.\d*)?$/.test(t)) return 0n;
  const neg = t.startsWith("-");
  const s = neg ? t.slice(1) : t;
  const [wholePart, fracPart = ""] = s.split(".");
  const whole = wholePart.replace(/^0+/, "") || "0";
  const frac = (fracPart + "0".repeat(decimals)).slice(0, decimals);
  const base = 10n ** BigInt(decimals);
  let v = BigInt(whole) * base + BigInt(frac || "0");
  if (neg) v = -v;
  return v < 0n ? 0n : v;
}

function resolveDepositAmountRaw(
  mode: "shield-ui-usdc" | "raw-field",
  mint: PublicKey,
  shieldUsdc: string,
  depositAmount: string,
): bigint {
  if (mode === "shield-ui-usdc" && isUsdcDevnetMint(mint)) {
    return usdcUiStringToRawUnits(shieldUsdc, USDC_DECIMALS);
  }
  return BigInt(depositAmount.trim() || "0");
}

function InnerConsole() {
  const { connection } = useConnection();
  const w = useWallet();

  const [mintStr, setMintStr] = useState(
    () => (loadBa5qMintFromLs() ?? CONFIGURED_USDC_MINT).toBase58(),
  );
  const [ba5qMint, setBa5qMint] = useState<PublicKey | null>(
    () => loadBa5qMintFromLs() ?? CONFIGURED_USDC_MINT,
  );
  const [chainByte, setChainByte] = useState("7");
  const [lightTreeStr, setLightTreeStr] = useState("");
  const [depositAmount, setDepositAmount] = useState("1000000");
  const [shieldUsdc, setShieldUsdc] = useState("1");
  const [withdrawUsdc, setWithdrawUsdc] = useState("1");
  const [forensicSilenceToast, setForensicSilenceToast] = useState(false);
  const [systemSettingsOpen, setSystemSettingsOpen] = useState(false);
  const [complianceOpen, setComplianceOpen] = useState(false);
  const [cofreAmount, setCofreAmount] = useState("1000000");
  const [auditorPkStr, setAuditorPkStr] = useState("");
  const [requireAttestor, setRequireAttestor] = useState(true);
  const [policyHex, setPolicyHex] = useState("");
  const [lightPoolAtaStr, setLightPoolAtaStr] = useState("");
  const [recipientAtaStr, setRecipientAtaStr] = useState("");

  const [txLog, setTxLog] = useState<
    { label: string; sig: string; kind: "chain" | "audit" }[]
  >([]);
  const [fatalModal, setFatalModal] = useState<string | null>(null);
  const [cofreBalance, setCofreBalance] = useState<{
    uiAmount: string;
    rawAmount: string;
    decimals: number;
    vaultAta58: string;
  } | null>(null);
  const [cofreBalanceBusy, setCofreBalanceBusy] = useState(false);
  const [cofreBalanceHint, setCofreBalanceHint] = useState<string | null>(null);
  const [cofreShadowUnlocked, setCofreShadowUnlocked] = useState(false);
  const [cofreShadowBusy, setCofreShadowBusy] = useState(false);
  const [vaultAuthorityCofre, setVaultAuthorityCofre] = useState<PublicKey | null>(
    null,
  );
  const [bunkerShadowMeta, setBunkerShadowMeta] = useState<{
    seq: string;
    rootHex: string;
  } | null>(null);
  /** SBED: per-wallet-connection nonce; React state only — cleared on disconnect / reload. */
  const [cofreSessionNonceHex, setCofreSessionNonceHex] = useState<string | null>(null);
  const shadowBunkerSessionRef = useRef<{
    signature: Uint8Array;
  } | null>(null);
  const mockPoolRef = useRef(Keypair.generate());

  useEffect(() => {
    try {
      const v = localStorage.getItem(LS_BA5Q_SCHEMA);
      if (v !== BA5Q_LS_SCHEMA) {
        purgeReservedVaultLocalStorage();
        localStorage.setItem(LS_BA5Q_SCHEMA, BA5Q_LS_SCHEMA);
        setBa5qMint(CONFIGURED_USDC_MINT);
        persistBa5qMint(CONFIGURED_USDC_MINT);
        setMintStr(CONFIGURED_USDC_MINT.toBase58());
      }
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    if (!ba5qMint) return;
    setMintStr((prev) => (prev.trim() ? prev : ba5qMint.toBase58()));
  }, [ba5qMint]);

  const cofreVaultAtas = useMemo(() => {
    if (!ba5qMint) return null;
    return deriveCofreVaultAtas(PROGRAM_ID, ba5qMint);
  }, [ba5qMint]);

  const userCofreAta = useMemo(() => {
    if (!w.publicKey || !ba5qMint) return null;
    return getAssociatedTokenAddressSync(
      ba5qMint,
      w.publicKey,
      true,
      TOKEN_PROGRAM_ID,
    );
  }, [w.publicKey, ba5qMint]);

  const [walletBunkerBalance, setWalletBunkerBalance] = useState<{
    uiAmount: string;
    rawAmount: string;
    decimals: number;
  } | null>(null);
  const [walletBunkerBalanceBusy, setWalletBunkerBalanceBusy] =
    useState(false);

  /** Re-fetch vault ProvisionState after initialize_vault. */
  const [vaultBootstrapTick, setVaultBootstrapTick] = useState(0);
  const [treasuryProvision, setTreasuryProvision] = useState<VaultProvisionState>(
    { kind: "no_mint" },
  );
  const [bunkerProvision, setBunkerProvision] = useState<VaultProvisionState>({
    kind: "no_mint",
  });
  const [provisionChecking, setProvisionChecking] = useState(true);

  const refreshWalletBunkerBalance = useCallback(async () => {
    if (!w.publicKey || !ba5qMint) {
      setWalletBunkerBalance(null);
      return;
    }
    setWalletBunkerBalanceBusy(true);
    try {
      const ata = getAssociatedTokenAddressSync(
        ba5qMint,
        w.publicKey,
        true,
        TOKEN_PROGRAM_ID,
      );
      const { value } = await connection.getTokenAccountBalance(ata);
      setWalletBunkerBalance({
        uiAmount: value.uiAmountString ?? String(value.uiAmount ?? "0"),
        rawAmount: value.amount,
        decimals: value.decimals,
      });
    } catch {
      setWalletBunkerBalance(null);
    } finally {
      setWalletBunkerBalanceBusy(false);
    }
  }, [connection, w.publicKey, ba5qMint]);

  useEffect(() => {
    void refreshWalletBunkerBalance();
  }, [refreshWalletBunkerBalance]);

  const pushTx = useCallback((label: string, sig: string) => {
    setTxLog((prev) => [{ label, sig, kind: "chain" }, ...prev]);
  }, []);

  const pushAuditEvent = useCallback((label: string) => {
    setTxLog((prev) => [{ label, sig: "", kind: "audit" }, ...prev]);
  }, []);

  const provider = useMemo(() => {
    const wallet = walletToAnchorWallet(w);
    if (!wallet) return null;
    return new AnchorProvider(connection, wallet, { commitment: "confirmed" });
  }, [connection, w]);

  const program = useMemo(() => {
    if (!provider) return null;
    const prog = new Program(idl, provider);
    (prog as any)._programId = PROGRAM_ID;
    return prog;
  }, [provider]);

  const mint = useMemo(() => {
    if (!mintStr.trim()) return null;
    try {
      return parsePubkey(mintStr, "mint");
    } catch {
      return null;
    }
  }, [mintStr]);

  const assertVaultProvisionedForMint = useCallback(
    async (m: PublicKey, flowLabel: string) => {
      const s = await getVaultProvisionState(connection, PROGRAM_ID, m);
      if (s.kind === "ready") return;
      const extra = formatProvisionBlocker(s);
      throw new Error(
        extra ??
          `${flowLabel}: on-chain vault is not ready (${s.kind}). Use Initialize Institutional Vault in the dashboard.`,
      );
    },
    [connection],
  );

  /** Treasury / bunker provision status for gating UX. */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setProvisionChecking(true);
      const tMint = mint;
      const tState = await getVaultProvisionState(connection, PROGRAM_ID, tMint);
      if (cancelled) return;
      setTreasuryProvision(tState);

      const bMint = ba5qMint;
      if (tMint && bMint && bMint.equals(tMint)) {
        setBunkerProvision(tState);
      } else if (bMint) {
        const bState = await getVaultProvisionState(connection, PROGRAM_ID, bMint);
        if (cancelled) return;
        setBunkerProvision(bState);
      } else {
        setBunkerProvision({ kind: "no_mint" });
      }
      if (!cancelled) setProvisionChecking(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [connection, mint, ba5qMint, vaultBootstrapTick]);

  const logErr = useCallback((e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    setFatalModal(msg);
  }, []);

  const ensureAtaIx = useCallback(
    (
      owner: PublicKey,
      mintPk: PublicKey,
    ): {
      ata: PublicKey;
      ix: ReturnType<typeof createAssociatedTokenAccountInstruction>;
    } => {
      const ata = getAssociatedTokenAddressSync(
        mintPk,
        owner,
        true,
        TOKEN_PROGRAM_ID,
      );
      const ix = createAssociatedTokenAccountInstruction(
        w.publicKey!,
        ata,
        owner,
        mintPk,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      );
      return { ata, ix };
    },
    [w.publicKey],
  );

  const sendPreparedTransaction = useCallback(
    async (label: string, tx: Transaction) => {
      if (!w.publicKey || !w.signTransaction) throw new Error("Wallet");
      const { blockhash, lastValidBlockHeight } =
        await connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;
      tx.feePayer = w.publicKey;
      const signed = await w.signTransaction(tx);
      const sig = await connection.sendRawTransaction(signed.serialize(), {
        skipPreflight: false,
        maxRetries: 3,
      });
      await connection.confirmTransaction(
        { signature: sig, blockhash, lastValidBlockHeight },
        "confirmed",
      );
      pushTx(label, sig);
      return sig;
    },
    [connection, pushTx, w],
  );

  const enforceForensicSilence = useCallback(
    (opts?: { clearShieldAmount?: boolean }) => {
      wipeZkShieldVolatile();
      wipeShadowBunkerSession(shadowBunkerSessionRef);
      setCofreAmount("");
      if (opts?.clearShieldAmount) {
        setDepositAmount("");
        setShieldUsdc("");
        setWithdrawUsdc("");
      }
      setCofreShadowUnlocked(false);
      setCofreBalance(null);
      setBunkerShadowMeta(null);
      setCofreBalanceHint(null);
      setForensicSilenceToast(true);
      pushAuditEvent(
        "[ AUDIT ] Forensic Silence — session + ZK proof buffers purged",
      );
    },
    [pushAuditEvent],
  );

  useEffect(() => {
    if (!forensicSilenceToast) return;
    const t = window.setTimeout(() => setForensicSilenceToast(false), 4200);
    return () => window.clearTimeout(t);
  }, [forensicSilenceToast]);

  const refreshVaultAuthorityCofre = useCallback(async () => {
    if (!program || !ba5qMint) {
      setVaultAuthorityCofre(null);
      return;
    }
    const [vc] = deriveVaultConfig(PROGRAM_ID, ba5qMint);
    try {
      const acc = await (program.account as any).vaultConfig.fetch(vc);
      setVaultAuthorityCofre(acc.authority as PublicKey);
    } catch {
      setVaultAuthorityCofre(null);
    }
  }, [program, ba5qMint]);

  const refreshCofreBalance = useCallback(async () => {
    if (
      !shadowBunkerSessionRef.current ||
      !cofreSessionNonceHex ||
      !ba5qMint
    ) {
      setCofreBalance(null);
      return;
    }
    setCofreBalanceBusy(true);
    setCofreBalanceHint(null);
    try {
      const data = await fetchReservedVaultTokenBalance(
        connection,
        PROGRAM_ID,
        ba5qMint,
      );
      if (!data) {
        setCofreBalance(null);
        setCofreBalanceHint(
          "Could not read vault ATA — initialize the vault/ATA for this bunker mint or run initialize_vault.",
        );
      } else {
        setCofreBalance(data);
      }
    } finally {
      setCofreBalanceBusy(false);
    }
  }, [connection, cofreSessionNonceHex, ba5qMint]);

  useEffect(() => {
    if (!w.connected) {
      wipeShadowBunkerSession(shadowBunkerSessionRef);
      setCofreSessionNonceHex(null);
      setCofreShadowUnlocked(false);
      setCofreBalance(null);
      setBunkerShadowMeta(null);
      return;
    }
    const secret = randomBlinding32();
    const hex = Buffer.from(secret).toString("hex");
    secret.fill(0);
    setCofreSessionNonceHex(hex);
  }, [w.connected]);

  useEffect(() => {
    const flushSbedVolatile = () => {
      wipeShadowBunkerSession(shadowBunkerSessionRef);
      setCofreSessionNonceHex(null);
      setCofreShadowUnlocked(false);
      setCofreBalance(null);
      setBunkerShadowMeta(null);
    };
    const onPageHide = (e: PageTransitionEvent) => {
      if (e.persisted) return;
      flushSbedVolatile();
    };
    window.addEventListener("beforeunload", flushSbedVolatile);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("beforeunload", flushSbedVolatile);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, []);

  useEffect(() => {
    void refreshVaultAuthorityCofre();
  }, [refreshVaultAuthorityCofre]);

  useEffect(() => {
    if (!w.connected || !cofreShadowUnlocked) return;
    if (!shadowBunkerSessionRef.current || !cofreSessionNonceHex) return;
    void refreshCofreBalance();
  }, [
    w.connected,
    cofreShadowUnlocked,
    cofreSessionNonceHex,
    refreshCofreBalance,
  ]);

  const onUnlockCofreShadow = useCallback(async () => {
    if (!program || !w.publicKey || !w.signMessage) return;
    if (!ba5qMint) {
      setFatalModal(
        "Bunker mint required — choose Devnet USDC, test mint, or paste deposit_mint and sync bunker mint in Advanced.",
      );
      return;
    }
    if (!cofreSessionNonceHex) {
      setFatalModal(
        "SBED: no active session nonce. Reconnect your wallet to create one.",
      );
      return;
    }
    setCofreShadowBusy(true);
    try {
      const [vc] = deriveVaultConfig(PROGRAM_ID, ba5qMint);
      const acc = await (program.account as any).vaultConfig.fetch(vc);
      const auth = acc.authority as PublicKey;
      if (!auth.equals(w.publicKey)) {
        setFatalModal(
          "Only the on-chain vault authority can reveal the balance in this console.",
        );
        return;
      }
      const messageUtf8 = `${SHADOW_BALANCE_MESSAGE_BASE}\n\nsession_nonce:${cofreSessionNonceHex}`;
      const messageBytes = new TextEncoder().encode(messageUtf8);
      const sig = new Uint8Array(await w.signMessage(messageBytes));
      messageBytes.fill(0);
      shadowBunkerSessionRef.current = { signature: sig };
      const seq = acc.bunkerShadowSequence;
      const root = acc.bunkerLiquidityRoot as number[];
      setBunkerShadowMeta({
        seq: typeof seq?.toString === "function" ? seq.toString() : String(seq ?? "0"),
        rootHex: Buffer.from(root).toString("hex"),
      });
      setCofreShadowUnlocked(true);
      setCofreBalanceHint(null);
      await refreshCofreBalance();
    } catch (e: unknown) {
      logErr(e);
    } finally {
      setCofreShadowBusy(false);
    }
  }, [
    program,
    w.publicKey,
    w.signMessage,
    ba5qMint,
    cofreSessionNonceHex,
    refreshCofreBalance,
    logErr,
  ]);

  const onLockCofreShadow = useCallback(() => {
    wipeShadowBunkerSession(shadowBunkerSessionRef);
    setCofreShadowUnlocked(false);
    setCofreBalance(null);
    setBunkerShadowMeta(null);
  }, []);

  const onInitVault = async () => {
    if (!program || !mint || !w.publicKey) return;
    try {
      const progInfo = await connection.getAccountInfo(PROGRAM_ID);
      if (!progInfo?.executable) {
        throw new Error(
          `RESERVED program is missing or not executable at ${PROGRAM_ID.toBase58()}. Deploy to this RPC's cluster or set VITE_RESERVED_PROGRAM_ID.`,
        );
      }

      const pre = await getVaultProvisionState(connection, PROGRAM_ID, mint);
      if (pre.kind === "ready") {
        setFatalModal(
          "Institutional vault is already provisioned for this treasury mint.",
        );
        return;
      }
      if (pre.kind === "ata_missing") {
        throw new Error(
          formatProvisionBlocker(pre) ??
            "Vault token account missing while VaultConfig exists.",
        );
      }
      const mintBlocker = formatProvisionBlocker(pre);
      if (pre.kind === "mint_not_found" || pre.kind === "mint_program_mismatch") {
        throw new Error(mintBlocker ?? "Treasury mint is not compatible with initialize_vault.");
      }
      if (pre.kind !== "needs_init") {
        throw new Error(
          mintBlocker ?? `Cannot initialize vault from state: ${pre.kind}`,
        );
      }

      const chainIdHash = bytes32FromHexOrFill("", Number(chainByte) || 7);
      const lightTree = lightTreeStr.trim()
        ? parsePubkey(lightTreeStr, "light_state_tree")
        : Keypair.generate().publicKey;
      const [vaultConfig] = deriveVaultConfig(PROGRAM_ID, mint);
      const [vaultAuthority] = deriveVaultAuthority(PROGRAM_ID, mint);
      const vaultTokenAta = getAssociatedTokenAddressSync(
        mint,
        vaultAuthority,
        true,
        TOKEN_PROGRAM_ID,
      );
      const sig = await program.methods
        .initializeVault(chainIdHash, lightTree)
        .accounts({
          payer: w.publicKey,
          authority: w.publicKey,
          vaultConfig,
          depositMint: mint,
          vaultAuthority,
          vaultTokenAccount: vaultTokenAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      pushTx("initialize_vault", sig);
      setVaultBootstrapTick((x) => x + 1);
      if (ba5qMint && mint.equals(ba5qMint)) await refreshVaultAuthorityCofre();
    } catch (e: unknown) {
      const text = e instanceof Error ? e.message : String(e);
      if (/incorrect program id/i.test(text)) {
        setFatalModal(
          `Transaction failed (${text}). The client invoked a different program ID than the on-chain BPF upgradeable artifact for this RPC. Confirm your deployment matches Program ${PROGRAM_ID.toBase58()} (or override with VITE_RESERVED_PROGRAM_ID). This is unrelated to SPL vs Token-2022 — RESERVED uses legacy SPL Token for deposit_mint.`,
        );
      } else {
        logErr(e);
      }
    }
  };

  const onRegisterNoteHead = async () => {
    if (!program || !mint || !w.publicKey) return;
    try {
      await assertVaultProvisionedForMint(mint, "Register note head");
    } catch (e) {
      logErr(e);
      return;
    }
    const [vaultConfig] = deriveVaultConfig(PROGRAM_ID, mint);
    const [userNoteHead] = deriveUserNoteHead(
      PROGRAM_ID,
      w.publicKey,
      vaultConfig,
    );
    const ivk = bytes32FromHexOrFill("01", 1);
    const ovk = bytes32FromHexOrFill("02", 2);
    const sig = await program.methods
      .registerUserNoteHead(ivk, ovk)
      .accounts({
        payer: w.publicKey,
        spendAuthority: w.publicKey,
        vaultConfig,
        userNoteHead,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    pushTx("register_user_note_head", sig);
  };

  const onUpsertPolicy = async () => {
    if (!program || !mint || !w.publicKey) return;
    try {
      await assertVaultProvisionedForMint(mint, "Auditor policy");
    } catch (e) {
      logErr(e);
      return;
    }
    const [vaultConfig] = deriveVaultConfig(PROGRAM_ID, mint);
    const [auditorPolicy] = deriveAuditorPolicy(PROGRAM_ID, vaultConfig);
    const auditorPubkey = requireAttestor
      ? auditorPkStr.trim().length > 0
        ? parsePubkey(auditorPkStr, "auditor_pubkey")
        : w.publicKey
      : PublicKey.default;
    const commitment = bytes32FromHexOrFill(policyHex, 0x00);
    const unixTs = new BN(Math.floor(Date.now() / 1000));
    const sig = await program.methods
      .upsertAuditorPolicy(auditorPubkey, commitment, unixTs)
      .accounts({
        authority: w.publicKey,
        vaultConfig,
        auditorPolicy,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    pushTx("upsert_auditor_policy", sig);
  };

  const onDepositPublic = async (mode: "shield-ui-usdc" | "raw-field" = "raw-field") => {
    if (!program || !mint || !w.publicKey) return;
    let amountRaw: bigint;
    try {
      amountRaw = resolveDepositAmountRaw(mode, mint, shieldUsdc, depositAmount);
    } catch (e) {
      logErr(e);
      return;
    }
    if (amountRaw <= 0n) {
      setFatalModal(
        mode === "shield-ui-usdc"
          ? "Shield amount must be greater than zero. For USDC, the UI value is converted to raw 6-decimal units before building the proof."
          : "Deposit amount must be greater than zero in raw token units.",
      );
      return;
    }
    try {
      await assertVaultProvisionedForMint(
        mint,
        mode === "shield-ui-usdc" ? "Shield deposit" : "Raw deposit",
      );
    } catch (e) {
      logErr(e);
      return;
    }
    const [vaultConfig] = deriveVaultConfig(PROGRAM_ID, mint);
    const [vaultAuthority] = deriveVaultAuthority(PROGRAM_ID, mint);
    const vaultTokenAccount = getAssociatedTokenAddressSync(
      mint,
      vaultAuthority,
      true,
      TOKEN_PROGRAM_ID,
    );
    const { ata: userAta, ix: createUserAtaIx } = ensureAtaIx(
      w.publicKey,
      mint,
    );

    if (mode === "shield-ui-usdc" && isUsdcDevnetMint(mint)) {
      console.info("[shield-ui] amount normalization", {
        uiAmount: shieldUsdc,
        decimals: USDC_DECIMALS,
        amountRaw: amountRaw.toString(),
      });
      const [userNoteHead] = deriveUserNoteHead(
        PROGRAM_ID,
        w.publicKey,
        vaultConfig,
      );
      const [auditorPolicy] = deriveAuditorPolicy(PROGRAM_ID, vaultConfig);
      try {
        await (program.account as any).userNoteHead.fetch(userNoteHead);
      } catch {
        setFatalModal(
          "Register your note head first (System Settings → Module 1 — Treasury setup → Register note head). Shielded compression requires UserNoteHead.",
        );
        return;
      }
      let policy: { auditorPubkey: PublicKey; policyCommitment: number[] };
      try {
        policy = await (program.account as any).auditorPolicy.fetch(auditorPolicy);
      } catch {
        setFatalModal(
          "Set an on-chain auditor policy before compression shielding (System Settings → Module 2 — Policy engine → Upsert auditor policy). The instruction must pass expected_policy_commitment.",
        );
        return;
      }
      const auditorPk = policy.auditorPubkey as PublicKey;
      if (!auditorPk.equals(PublicKey.default) && !auditorPk.equals(w.publicKey)) {
        setFatalModal(
          `This vault policy names auditor ${auditorPk.toBase58()}. Connect that wallet so it can co-sign shield_into_compressed, or reset policy to SystemProgram default and upsert again.`,
        );
        return;
      }
      const expectedCommitment = new Uint8Array(
        Buffer.from(policy.policyCommitment as number[]),
      );
      if (isBytes32FilledWith(expectedCommitment, 0xaf)) {
        setFatalModal(
          "The on-chain auditor policy still contains the legacy demo filler 0xaf repeated 32 times. Run Upsert auditor policy again with the commitment field blank to store 32 zero bytes, or provide a real 64-hex policy hash before shielding.",
        );
        return;
      }
      try {
        await sendShieldZkTx(
          {
            connection,
            program,
            programId: PROGRAM_ID,
            spendAuthority: w.publicKey,
            feePayer: w.publicKey,
            mint,
            vaultConfig,
            vaultAuthority,
            vaultTokenAccount,
            userNoteHead,
            auditorPolicy,
            expectedPolicyCommitment: expectedCommitment,
            auditorAttestor: w.publicKey,
            amountRaw,
          },
          (tx) => sendPreparedTransaction("shield_into_compressed", tx),
        );
      } catch (e: unknown) {
        logErr(e);
        return;
      } finally {
        wipeZkShieldVolatile();
      }
    } else {
      const cfg = await (program.account as any).vaultConfig.fetch(vaultConfig);
      const chainIdHash = new Uint8Array(Buffer.from(cfg.chainIdHash as number[]));
      const { opening, blinding } = buildBunkerOpening(amountRaw);
      const commitment = await bunkerDepositCommitmentBytes(
        amountRaw,
        blinding,
        w.publicKey,
        vaultConfig,
        mint,
        chainIdHash,
        PROGRAM_ID,
      );
      const tx = new Transaction();
      const info = await connection.getAccountInfo(userAta);
      if (!info) tx.add(createUserAtaIx);
      const ix = await program.methods
        .depositPublic([...commitment], opening)
        .accounts({
          depositor: w.publicKey,
          userTokenAccount: userAta,
          vaultTokenAccount,
          vaultConfig,
          vaultAuthority,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .instruction();
      tx.add(ix);
      await sendPreparedTransaction("deposit_public", tx);
    }

    if (isUsdcDevnetMint(mint)) {
      enforceForensicSilence({ clearShieldAmount: true });
    } else if (ba5qMint && mint.equals(ba5qMint) && cofreShadowUnlocked) {
      await refreshCofreBalance();
    }
  };

  const onDepositCofre = async () => {
    if (!program || !w.publicKey || !ba5qMint) return;
    const m = ba5qMint;
    try {
      await assertVaultProvisionedForMint(m, "Vault deposit (advanced)");
    } catch (e) {
      logErr(e);
      return;
    }
    const [vaultConfig] = deriveVaultConfig(PROGRAM_ID, m);
    const [vaultAuthority] = deriveVaultAuthority(PROGRAM_ID, m);
    const vaultTokenAccount = getAssociatedTokenAddressSync(
      m,
      vaultAuthority,
      true,
      TOKEN_PROGRAM_ID,
    );
    const { ata: userAta, ix: createUserAtaIx } = ensureAtaIx(w.publicKey, m);
    const tx = new Transaction();
    const info = await connection.getAccountInfo(userAta);
    if (!info) tx.add(createUserAtaIx);
    const amountRaw = BigInt(cofreAmount.trim() || "0");
    if (
      walletBunkerBalance &&
      amountRaw > BigInt(walletBunkerBalance.rawAmount)
    ) {
      setFatalModal(
        `Vault: raw amount (${amountRaw}) exceeds wallet balance (${walletBunkerBalance.rawAmount} raw ≈ ${walletBunkerBalance.uiAmount} UI). Refresh balance or reduce the amount.`,
      );
      return;
    }
    const cfg = await (program.account as any).vaultConfig.fetch(vaultConfig);
    const chainIdHash = new Uint8Array(Buffer.from(cfg.chainIdHash as number[]));
    const { opening, blinding } = buildBunkerOpening(amountRaw);
    const commitment = await bunkerDepositCommitmentBytes(
      amountRaw,
      blinding,
      w.publicKey,
      vaultConfig,
      m,
      chainIdHash,
      PROGRAM_ID,
    );
    const ix = await program.methods
      .depositPublic([...commitment], opening)
      .accounts({
        depositor: w.publicKey,
        userTokenAccount: userAta,
        vaultTokenAccount,
        vaultConfig,
        vaultAuthority,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();
    tx.add(ix);
    await sendPreparedTransaction("deposit_public:cofre", tx);
    await refreshWalletBunkerBalance();
    if (isUsdcDevnetMint(m)) {
      enforceForensicSilence({ clearShieldAmount: true });
    } else if (cofreShadowUnlocked) {
      await refreshCofreBalance();
    }
  };

  const onWithdrawCofre = async () => {
    if (!program || !w.publicKey || !ba5qMint) return;
    const m = ba5qMint;
    try {
      await assertVaultProvisionedForMint(m, "Vault withdrawal (advanced)");
    } catch (e) {
      logErr(e);
      return;
    }
    const [vaultConfig] = deriveVaultConfig(PROGRAM_ID, m);
    const [vaultAuthority] = deriveVaultAuthority(PROGRAM_ID, m);
    const vaultTokenAccount = getAssociatedTokenAddressSync(
      m,
      vaultAuthority,
      true,
      TOKEN_PROGRAM_ID,
    );
    const recipientAta = getAssociatedTokenAddressSync(
      m,
      w.publicKey,
      true,
      TOKEN_PROGRAM_ID,
    );
    const tx = new Transaction();
    const recInfo = await connection.getAccountInfo(recipientAta);
    if (!recInfo) tx.add(ensureAtaIx(w.publicKey, m).ix);
    const amountRaw = BigInt(cofreAmount.trim() || "0");
    const cfg = await (program.account as any).vaultConfig.fetch(vaultConfig);
    const chainIdHash = new Uint8Array(Buffer.from(cfg.chainIdHash as number[]));
    const { opening, blinding } = buildBunkerOpening(amountRaw);
    const commitment = await bunkerWithdrawCommitmentBytes(
      amountRaw,
      blinding,
      w.publicKey,
      vaultConfig,
      m,
      chainIdHash,
      PROGRAM_ID,
    );
    const ix = await program.methods
      .withdrawPublic([...commitment], opening)
      .accounts({
        vaultConfig,
        authority: w.publicKey,
        recipientTokenAccount: recipientAta,
        vaultTokenAccount,
        vaultAuthority,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();
    tx.add(ix);
    await sendPreparedTransaction("withdraw_public:cofre", tx);
    await refreshWalletBunkerBalance();
    enforceForensicSilence({ clearShieldAmount: true });
  };

  const onWithdrawMain = async () => {
    if (!program || !mint || !w.publicKey) return;
    if (!isUsdcDevnetMint(mint)) {
      setFatalModal(
        "This withdrawal flow targets Devnet USDC. Configure your treasury mint in System Settings (⚙).",
      );
      return;
    }
    try {
      await assertVaultProvisionedForMint(mint, "USDC withdrawal");
    } catch (e) {
      logErr(e);
      return;
    }
    const [vaultConfig] = deriveVaultConfig(PROGRAM_ID, mint);
    const [vaultAuthority] = deriveVaultAuthority(PROGRAM_ID, mint);
    const vaultTokenAccount = getAssociatedTokenAddressSync(
      mint,
      vaultAuthority,
      true,
      TOKEN_PROGRAM_ID,
    );
    const recipientAta = getAssociatedTokenAddressSync(
      mint,
      w.publicKey,
      true,
      TOKEN_PROGRAM_ID,
    );
    const tx = new Transaction();
    const recInfo = await connection.getAccountInfo(recipientAta);
    if (!recInfo) tx.add(ensureAtaIx(w.publicKey, mint).ix);
    const amountRaw = usdcUiStringToRawUnits(withdrawUsdc, USDC_DECIMALS);
    const cfg = await (program.account as any).vaultConfig.fetch(vaultConfig);
    const chainIdHash = new Uint8Array(Buffer.from(cfg.chainIdHash as number[]));
    const { opening, blinding } = buildBunkerOpening(amountRaw);
    const commitment = await bunkerWithdrawCommitmentBytes(
      amountRaw,
      blinding,
      w.publicKey,
      vaultConfig,
      mint,
      chainIdHash,
      PROGRAM_ID,
    );
    const ix = await program.methods
      .withdrawPublic([...commitment], opening)
      .accounts({
        vaultConfig,
        authority: w.publicKey,
        recipientTokenAccount: recipientAta,
        vaultTokenAccount,
        vaultAuthority,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();
    tx.add(ix);
    await sendPreparedTransaction("withdraw_public", tx);
    await refreshWalletBunkerBalance();
    enforceForensicSilence({ clearShieldAmount: true });
  };

  const onCreateBa5qMockMint = async () => {
    if (!w.publicKey || !w.signTransaction) {
      setFatalModal("Connect your wallet to create a mock mint.");
      return;
    }
    /** Always a new SPL mint (Keypair); Circle USDC and other canonical mints are never created here. */
    const mintKp = Keypair.generate();
    const lamports = await getMinimumBalanceForRentExemptMint(connection);
    const tx = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: w.publicKey,
        newAccountPubkey: mintKp.publicKey,
        space: MINT_SIZE,
        lamports,
        programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeMint2Instruction(
        mintKp.publicKey,
        9,
        w.publicKey,
        null,
        TOKEN_PROGRAM_ID,
      ),
    );
    const { blockhash, lastValidBlockHeight } =
      await connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.feePayer = w.publicKey;
    tx.partialSign(mintKp);
    const signed = await w.signTransaction(tx);
    const sig = await connection.sendRawTransaction(signed.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    });
    await connection.confirmTransaction(
      { signature: sig, blockhash, lastValidBlockHeight },
      "confirmed",
    );
    pushTx("create_ba5q_mock_mint", sig);
    setBa5qMint(mintKp.publicKey);
    persistBa5qMint(mintKp.publicKey);
    setMintStr(mintKp.publicKey.toBase58());
  };

  const onCreatePoolPlaceholderAta = async () => {
    if (!mint || !w.publicKey) return;
    const owner = mockPoolRef.current.publicKey;
    const { ata, ix } = ensureAtaIx(owner, mint);
    const tx = new Transaction();
    const info = await connection.getAccountInfo(ata);
    if (!info) tx.add(ix);
    else {
      setLightPoolAtaStr(ata.toBase58());
      return;
    }
    await sendPreparedTransaction("create_pool_placeholder_ata", tx);
    setLightPoolAtaStr(ata.toBase58());
  };

  const onEgressPreview = async () => {
    if (!program || !mint || !w.publicKey) return;
    const [vaultConfig] = deriveVaultConfig(PROGRAM_ID, mint);
    const [vaultAuthority] = deriveVaultAuthority(PROGRAM_ID, mint);
    const [userNoteHead] = deriveUserNoteHead(
      PROGRAM_ID,
      w.publicKey,
      vaultConfig,
    );
    const [auditorPolicy] = deriveAuditorPolicy(PROGRAM_ID, vaultConfig);
    const vaultTokenAccount = getAssociatedTokenAddressSync(
      mint,
      vaultAuthority,
      true,
      TOKEN_PROGRAM_ID,
    );
    const lightPool = lightPoolAtaStr.trim()
      ? parsePubkey(lightPoolAtaStr, "light_pool_token_account")
      : getAssociatedTokenAddressSync(
          mint,
          mockPoolRef.current.publicKey,
          true,
          TOKEN_PROGRAM_ID,
        );
    let recipient: PublicKey;
    if (recipientAtaStr.trim()) {
      recipient = parsePubkey(recipientAtaStr, "recipient_token_account");
    } else {
      recipient = getAssociatedTokenAddressSync(
        mint,
        w.publicKey,
        false,
        TOKEN_PROGRAM_ID,
      );
    }
    try {
      await program.methods
        .decompressToSplPreview()
        .accounts({
          feePayer: w.publicKey,
          spendAuthority: w.publicKey,
          userNoteHead,
          vaultConfig,
          auditorPolicy,
          vaultTokenAccount,
          vaultAuthority,
          lightPoolTokenAccount: lightPool,
          recipientTokenAccount: recipient,
          mint,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
      enforceForensicSilence({ clearShieldAmount: true });
      setFatalModal(
        "Unexpected success — expected ContractLogicNotYetLive (6017).",
      );
    } catch (e: unknown) {
      const text = e instanceof Error ? e.message : String(e);
      const isExpected =
        text.includes("6017") ||
        text.includes("ContractLogicNotYetLive") ||
        text.includes("Egress logic planned for Phase 2");
      if (isExpected) {
        setFatalModal(
          `EXPECTED BLOCK (Phase 2 preview)\n\n${text}\n\nProgram continues to enforce ContractLogicNotYetLive until egress ships.`,
        );
      } else {
        logErr(e);
      }
    }
  };

  const ready = w.connected && program && mint;

  const treasuryVaultReady = treasuryProvision.kind === "ready";
  const showTreasuryInitializationCta =
    Boolean(
      w.connected && program && mint && isUsdcDevnetMint(mint) && !provisionChecking,
    ) && treasuryProvision.kind === "needs_init";
  const expectedTreasuryVaultConfig =
    treasuryProvision.kind === "needs_init"
      ? treasuryProvision.vaultConfig
      : null;
  /** Main dashboard Shield / Withdraw — only when VaultConfig + vault ATA exist. */
  const showTreasuryMovementRails =
    Boolean(mint && isUsdcDevnetMint(mint)) &&
    !provisionChecking &&
    treasuryVaultReady;
  const treasuryRailGateMessage = formatProvisionBlocker(treasuryProvision);
  const bunkerVaultReady = bunkerProvision.kind === "ready";
  const bunkerVaultGateMessage = formatProvisionBlocker(bunkerProvision);

  const cofreReady = Boolean(program && w.publicKey);

  const bunkerUsesUsdc = Boolean(ba5qMint && isUsdcDevnetMint(ba5qMint));

  const onUseMaxWalletRaw = useCallback(() => {
    if (!walletBunkerBalance) return;
    setCofreAmount(walletBunkerBalance.rawAmount);
  }, [walletBunkerBalance]);

  const ba5qMintDisplay = useMemo(() => {
    if (!ba5qMint) {
      return "— (create mock mint, choose Devnet USDC, or paste deposit_mint in Advanced)";
    }
    const b58 = ba5qMint.toBase58();
    return bunkerUsesUsdc ? `${b58} · USDC (Devnet)` : b58;
  }, [ba5qMint, bunkerUsesUsdc]);

  const complianceReport = useMemo(() => {
    return {
      generatedAt: new Date().toISOString(),
      network: "Solana Devnet",
      environment: "ZK-Compressed (demonstration)",
      rpcEndpoint: connection.rpcEndpoint,
      programId: PROGRAM_ID.toBase58(),
      treasuryMint: mint?.toBase58() ?? "—",
      vaultViewMint: ba5qMint?.toBase58() ?? "—",
      wallet: w.publicKey?.toBase58() ?? "—",
      vaultAuthority: vaultAuthorityCofre?.toBase58() ?? "—",
      walletConnected: w.connected,
      sbedAuthenticated: cofreShadowUnlocked,
      balanceDisclosed: Boolean(cofreShadowUnlocked && cofreBalance),
      disclosedBalanceUi:
        cofreShadowUnlocked && cofreBalance ? cofreBalance.uiAmount : null,
      shadowSequence: cofreShadowUnlocked ? bunkerShadowMeta?.seq ?? null : null,
      liquidityRoot: cofreShadowUnlocked ? bunkerShadowMeta?.rootHex ?? null : null,
      chainTxCount: txLog.filter((t) => t.kind === "chain").length,
      auditCount: txLog.filter((t) => t.kind === "audit").length,
    };
  }, [
    connection,
    mint,
    ba5qMint,
    w.publicKey,
    w.connected,
    vaultAuthorityCofre,
    cofreShadowUnlocked,
    cofreBalance,
    bunkerShadowMeta,
    txLog,
  ]);

  return (
    <div className="flex min-h-screen bg-inst-bg">
      <main className="flex-1 border-r border-inst-border px-6 py-8 sm:px-10 lg:px-14">
        <header className="mb-12 flex flex-col gap-6 border-b border-inst-border pb-8 sm:flex-row sm:items-start sm:justify-between">
          <div className="max-w-2xl leading-relaxed">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-2xl font-semibold tracking-tight text-inst-navy sm:text-[1.75rem]">
                RESERVED <span className="font-normal text-inst-muted">|</span> Institutional Treasury
              </h1>
            </div>
            <span className="mt-4 inline-flex items-center rounded-full border border-inst-border bg-inst-surface px-3 py-1 text-xs font-medium text-inst-navy shadow-sm">
              Solana Devnet · ZK-Compressed
            </span>
            <p className="mt-5 text-sm leading-relaxed text-inst-muted">
              Program <span className="font-mono text-xs text-inst-navy/80">{PROGRAM_ID.toBase58()}</span>
            </p>
          </div>
          <div className="flex flex-shrink-0 flex-wrap items-center gap-3">
            <div className="inst-wallet-adapter">
              <WalletMultiButton className="!rounded-inst !border !border-inst-border !bg-inst-bg !px-4 !py-2.5 !font-sans !text-sm !font-medium !text-inst-navy" />
            </div>
            <button
              type="button"
              onClick={() => setSystemSettingsOpen(true)}
              className={`flex h-11 w-11 items-center justify-center rounded-inst border border-inst-border bg-inst-bg text-lg text-inst-navy shadow-sm transition hover:border-inst-accent/50 hover:bg-inst-surface ${
                showTreasuryInitializationCta ? "opacity-50" : ""
              }`}
              aria-label="System settings"
              title="System settings"
            >
              ⚙️
            </button>
          </div>
        </header>

        {showTreasuryInitializationCta ? (
          <section
            className="mb-8 rounded-inst border border-[#3d5a7a]/35 bg-gradient-to-br from-[#3d5a7a]/[0.07] to-inst-bg px-6 py-8 shadow-inst sm:px-10"
            aria-label="Vault bootstrap"
          >
            <p className="text-xs font-semibold uppercase tracking-widest text-[#3d5a7a]">
              Treasury activation required
            </p>
            <h2 className="mt-3 text-2xl font-semibold tracking-tight text-inst-navy">
              Sovereign vault pending
            </h2>
            <p className="mt-3 max-w-2xl text-sm leading-relaxed text-inst-muted">
              The <span className="font-medium text-inst-navy">VaultConfig</span> PDA for your
              institutional mint ({CONFIGURED_USDC_MINT.toBase58()}) is not on-chain yet. One signed
              transaction provisions VaultConfig and the vault SPL token account — no new tokens are
              minted.
            </p>
            {expectedTreasuryVaultConfig ? (
              <p className="mt-4 break-all font-mono text-[11px] leading-relaxed text-inst-navy/80">
                Expected VaultConfig · {expectedTreasuryVaultConfig.toBase58()}
              </p>
            ) : null}
            <button
              type="button"
              disabled={!ready}
              onClick={() => onInitVault().catch(logErr)}
              className="mt-8 w-full max-w-md rounded-inst bg-[#3d5a7a] px-8 py-4 text-sm font-semibold tracking-tight text-white shadow-inst transition hover:bg-[#355069] disabled:cursor-not-allowed disabled:opacity-45 sm:w-auto"
            >
              Initialize Sovereign Vault
            </button>
            <p className="mt-4 max-w-xl text-xs leading-relaxed text-inst-muted">
              If initialization fails with “Incorrect program id”, the client must match your BPF
              deployment (this build: {PROGRAM_ID.toBase58()}
              {import.meta.env.VITE_RESERVED_PROGRAM_ID
                ? " · from VITE_RESERVED_PROGRAM_ID"
                : ""}
              ). On-chain initializer expects{" "}
              <span className="font-medium text-inst-navy">legacy SPL Token</span> mints — not
              Token-2022.
            </p>
          </section>
        ) : null}

        {!showTreasuryInitializationCta ? (
          <VaultOverviewCard
            cofreReady={cofreReady}
            cofreBalance={cofreBalance}
            cofreBalanceBusy={cofreBalanceBusy}
            cofreBalanceHint={cofreBalanceHint}
            cofreShadowUnlocked={cofreShadowUnlocked}
            cofreShadowBusy={cofreShadowBusy}
            sbedSessionReady={Boolean(cofreSessionNonceHex && w.connected)}
            vaultAuthorityPk={vaultAuthorityCofre}
            onUnlockShadow={() => onUnlockCofreShadow().catch(logErr)}
            onLockShadow={onLockCofreShadow}
            onRefresh={() => refreshCofreBalance().catch(logErr)}
          />
        ) : null}

        {mint && isUsdcDevnetMint(mint) && provisionChecking ? (
          <section className="inst-card mb-8">
            <p className="text-sm font-medium text-inst-navy">Checking institutional vault status…</p>
            <p className="mt-2 text-xs text-inst-muted">
              Verifying treasury mint, VaultConfig PDA, and vault token account on your RPC.
            </p>
          </section>
        ) : showTreasuryMovementRails ? (
          <>
            <section className="inst-card mb-8">
              <p className="text-xs font-semibold uppercase tracking-widest text-inst-accent">
                ZK-shielded deposit
              </p>
              <h2 className="mt-2 text-xl font-semibold text-inst-navy">Shield Assets</h2>
              <p className="mt-3 text-sm leading-relaxed text-inst-muted">
                One transaction: direct SPL transfer (wallet ATA → protocol vault ATA) so escrow is funded, then Reserved{" "}
                <span className="font-medium text-inst-navy">shield_into_compressed</span> moves the same amount vault → Light pool custody and CPIs Light with a client-built validity proof and packed Merkle context (no{" "}
                <span className="font-medium text-inst-navy">deposit_public</span> instruction). Forensic Silence wipes in-memory proof buffers. Requires compression RPC / prover (
                <span className="font-mono text-xs">VITE_LIGHT_COMPRESSION_URL</span>,{" "}
                <span className="font-mono text-xs">VITE_LIGHT_PROVER_URL</span>
                ). Register note head and upsert auditor policy first.
              </p>
              {!mint || !isUsdcDevnetMint(mint) ? (
                <p className="mt-3 text-sm text-amber-800">
                  Treasury mint must be Devnet USDC. Open System Settings (⚙) to restore defaults.
                </p>
              ) : null}
              <label className="mt-6 block text-sm font-medium text-inst-navy">
                Amount (USDC)
                <input
                  inputMode="decimal"
                  className="inst-input max-w-md font-mono text-base"
                  value={shieldUsdc}
                  onChange={(e) => setShieldUsdc(e.target.value)}
                  disabled={!mint || !isUsdcDevnetMint(mint)}
                />
              </label>
              <button
                type="button"
                disabled={!ready || !mint || !isUsdcDevnetMint(mint) || !treasuryVaultReady}
                onClick={() => onDepositPublic("shield-ui-usdc").catch(logErr)}
                className="mt-8 rounded-inst bg-inst-accent px-8 py-3.5 text-sm font-semibold text-white shadow-inst transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-45"
              >
                Execute ZK-Shield Deposit
              </button>
            </section>

            <section className="inst-card mb-8">
              <p className="text-xs font-semibold uppercase tracking-widest text-inst-accent">
                ZK-unshield withdrawal
              </p>
              <h2 className="mt-2 text-xl font-semibold text-inst-navy">Withdrawal</h2>
              <p className="mt-3 text-sm leading-relaxed text-inst-muted">
                Withdraw from the same treasury vault to your wallet. Requires vault authority
                signature. Amounts are entered in USDC; conversion is handled automatically.
              </p>
              <label className="mt-6 block text-sm font-medium text-inst-navy">
                Amount (USDC)
                <input
                  inputMode="decimal"
                  className="inst-input max-w-md font-mono text-base"
                  value={withdrawUsdc}
                  onChange={(e) => setWithdrawUsdc(e.target.value)}
                  disabled={!mint || !isUsdcDevnetMint(mint)}
                />
              </label>
              <button
                type="button"
                disabled={!ready || !mint || !isUsdcDevnetMint(mint) || !treasuryVaultReady}
                onClick={() => onWithdrawMain().catch(logErr)}
                className="mt-8 rounded-inst border-2 border-inst-navy bg-inst-bg px-8 py-3.5 text-sm font-semibold text-inst-navy shadow-sm transition hover:bg-inst-surface disabled:cursor-not-allowed disabled:opacity-45"
              >
                Execute ZK-Unshield Withdrawal
              </button>
            </section>
          </>
        ) : mint && isUsdcDevnetMint(mint) && !showTreasuryInitializationCta ? (
          <section className="inst-card mb-8 border-dashed border-inst-navy/20 bg-inst-surface/60">
            <p className="text-xs font-semibold uppercase tracking-widest text-inst-accent">
              Treasury rails gated
            </p>
            <h2 className="mt-2 text-xl font-semibold text-inst-navy">Shield &amp; withdrawal unavailable</h2>
            <p className="mt-3 max-w-2xl text-sm leading-relaxed text-inst-muted">
              Deposit and withdrawal actions require a live RESERVED VaultConfig and vault token
              account for this treasury mint.{" "}
              {showTreasuryInitializationCta
                ? "Use Initialize Institutional Vault above."
                : "Resolve the condition below or open System Settings (⚙) for sandbox tools."}
            </p>
            {treasuryRailGateMessage ? (
              <p className="mt-4 text-sm leading-relaxed text-amber-900">{treasuryRailGateMessage}</p>
            ) : null}
          </section>
        ) : (
          <>
            <section className="inst-card mb-8">
              <p className="text-xs font-semibold uppercase tracking-widest text-inst-accent">
                ZK-shielded deposit
              </p>
              <h2 className="mt-2 text-xl font-semibold text-inst-navy">Shield Assets</h2>
              <p className="mt-3 text-sm text-amber-800">
                Treasury mint must be Devnet USDC. Open System Settings (⚙) to restore defaults.
              </p>
            </section>
            <section className="inst-card mb-8">
              <p className="text-xs font-semibold uppercase tracking-widest text-inst-accent">
                ZK-unshield withdrawal
              </p>
              <h2 className="mt-2 text-xl font-semibold text-inst-navy">Withdrawal</h2>
              <p className="mt-3 text-sm text-amber-800">
                Treasury mint must be Devnet USDC. Open System Settings (⚙) to restore defaults.
              </p>
            </section>
          </>
        )}

        {!showTreasuryInitializationCta ? (
          <section className="inst-card mb-12">
            <p className="text-xs font-semibold uppercase tracking-widest text-inst-accent">
              Selective disclosure
            </p>
            <h2 className="mt-2 text-xl font-semibold text-inst-navy">Compliance &amp; Audit</h2>
            <p className="mt-3 max-w-2xl text-sm leading-relaxed text-inst-muted">
              Generate a concise, human-readable summary of voluntarily disclosed session state—supporting
              auditability without exposing sensitive UI until you authenticate.
            </p>
            <button
              type="button"
              onClick={() => setComplianceOpen(true)}
              className="mt-8 rounded-inst bg-inst-navy px-6 py-3 text-sm font-semibold text-white shadow-inst transition hover:bg-inst-navy/90"
            >
              Generate Selective Disclosure Report
            </button>
          </section>
        ) : null}

        <footer
          className="border-t border-inst-border pt-14 pb-16 text-center"
          aria-label="Brand"
        >
          <div className="mx-auto max-w-lg px-4">
            <div className="mx-auto mb-8 h-px w-12 bg-inst-seal/25" aria-hidden />
            <div className="space-y-5 font-seal text-inst-seal">
              <p className="text-[1.2rem] font-medium leading-[1.65] tracking-[0.01em] sm:text-[1.35rem]">
                Privacy doesn&apos;t have to be dark.
              </p>
              <p className="text-[0.95rem] font-normal italic leading-relaxed tracking-[0.14em] sm:text-[1.05rem]">
                In Solana we trust.
              </p>
            </div>
          </div>
        </footer>
      </main>

      {systemSettingsOpen ? (
        <>
          <button
            type="button"
            className="fixed inset-0 z-40 bg-inst-navy/15 backdrop-blur-[2px]"
            aria-label="Close system settings"
            onClick={() => setSystemSettingsOpen(false)}
          />
          <div className="fixed inset-y-0 right-0 z-50 flex w-full max-w-2xl flex-col border-l border-inst-border bg-inst-bg shadow-inst-lg">
            <div className="relative flex shrink-0 flex-col gap-1 border-b border-inst-border bg-inst-bg px-6 py-4 pr-24">
              <h2 className="text-lg font-semibold tracking-tight text-inst-navy">System Settings</h2>
              <p className="text-xs leading-relaxed text-inst-muted">
                Infrastructure configuration · program engineering console
              </p>
              <button
                type="button"
                className="inst-btn-ghost absolute right-4 top-4 !py-2"
                onClick={() => setSystemSettingsOpen(false)}
              >
                Close
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-6">
              <div className="space-y-8">
                <section className="inst-card space-y-5 !shadow-none">
                  <h3 className="text-sm font-semibold uppercase tracking-wide text-inst-navy">Global</h3>
                  <label className="block text-sm font-medium text-inst-navy">
                    Deposit mint (SPL · Base58)
                    <input
                      className="inst-input font-sans"
                      value={mintStr}
                      onChange={(e) => setMintStr(e.target.value)}
                      placeholder="Mint address"
                    />
                  </label>
                  <div className="flex flex-wrap gap-3">
                    <button
                      type="button"
                      disabled={!w.connected}
                      onClick={() => {
                        setBa5qMint(CONFIGURED_USDC_MINT);
                        persistBa5qMint(CONFIGURED_USDC_MINT);
                        setMintStr(CONFIGURED_USDC_MINT.toBase58());
                        setCofreAmount("1000000");
                      }}
                      className="inst-btn-primary"
                    >
                      Use Devnet USDC
                    </button>
                    <button
                      type="button"
                      disabled={!w.connected}
                      title="Creates a new SPL test mint on devnet. Does not create or alter Circle USDC."
                      onClick={() => onCreateBa5qMockMint().catch(logErr)}
                      className="inst-btn"
                    >
                      Create test mint
                    </button>
                    <button
                      type="button"
                      disabled={!ba5qMint}
                      onClick={() => {
                        if (ba5qMint) setMintStr(ba5qMint.toBase58());
                      }}
                      className="inst-btn"
                    >
                      Sync vault mint → treasury
                    </button>
                    <button
                      type="button"
                      disabled={!mint}
                      onClick={() => {
                        if (!mint) return;
                        setBa5qMint(mint);
                        persistBa5qMint(mint);
                      }}
                      className="inst-btn"
                    >
                      Sync treasury → vault view
                    </button>
                  </div>
                  <p className="text-xs leading-relaxed text-inst-muted">
                    <span className="font-medium text-inst-navy">USDC</span> uses the official Circle
                    devnet mint; <span className="font-medium">initialize_vault</span> only allocates
                    VaultConfig and the vault ATA for that mint—never mints USDC itself. Use a test mint
                    for parallel sandbox bunkers.
                  </p>
                  <p className="text-xs leading-relaxed text-inst-muted">
                    Run <span className="font-medium text-inst-navy">initialize_vault</span> if the
                    vault is not yet provisioned. Local preferences reset when VaultConfig layout
                    changes (schema <span className="font-mono text-xs">{BA5Q_LS_SCHEMA}</span>).
                  </p>
                  <div className="flex flex-col gap-4 sm:flex-row">
                    <label className="block flex-1 text-sm font-medium text-inst-navy sm:max-w-[8rem]">
                      Chain ID hash (0–255)
                      <input
                        className="inst-input font-sans"
                        value={chainByte}
                        onChange={(e) => setChainByte(e.target.value)}
                      />
                    </label>
                    <label className="block min-w-0 flex-1 text-sm font-medium text-inst-navy">
                      Light state tree (optional pubkey)
                      <input
                        className="inst-input font-sans"
                        value={lightTreeStr}
                        onChange={(e) => setLightTreeStr(e.target.value)}
                        placeholder="Base58 optional"
                      />
                    </label>
                  </div>
                </section>

            <section className="inst-card space-y-5 !shadow-none">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-inst-navy">
                Module 1 — Treasury setup
              </h2>
              <p className="text-xs leading-relaxed text-inst-muted">
                <span className="font-medium text-inst-navy">initialize_vault</span> provisions{" "}
                <span className="font-mono text-[11px] text-inst-navy/90">VaultConfig</span> with
                adequate account space (including bunker shadow fields), avoiding buffer faults with
                production mints. Canonical Devnet USDC:{" "}
                <span className="break-all font-mono text-xs text-inst-navy">
                  {CONFIGURED_USDC_MINT.toBase58()}
                </span>
              </p>
              <div className="flex flex-wrap gap-3">
                <button
                  type="button"
                  disabled={
                    !ready ||
                    provisionChecking ||
                    treasuryProvision.kind !== "needs_init"
                  }
                  onClick={() => onInitVault().catch(logErr)}
                  className="inst-btn-primary"
                >
                  Initialize vault
                </button>
                <button
                  type="button"
                  disabled={!ready || provisionChecking || !treasuryVaultReady}
                  onClick={() => onRegisterNoteHead().catch(logErr)}
                  className="inst-btn"
                >
                  Register note head
                </button>
              </div>
            </section>

            <section className="inst-card space-y-5 !shadow-none">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-inst-navy">
                Module 2 — Policy engine
              </h2>
              <label className="flex items-center gap-3 text-sm text-inst-navy">
                <input
                  type="checkbox"
                  checked={requireAttestor}
                  onChange={(e) => setRequireAttestor(e.target.checked)}
                  className="h-4 w-4 rounded border-inst-border text-inst-navy"
                />
                Require explicit auditor public key
              </label>
              <label className="block text-sm font-medium text-inst-navy">
                Auditor public key (Base58)
                <input
                  className="inst-input font-sans"
                  value={auditorPkStr}
                  onChange={(e) => setAuditorPkStr(e.target.value)}
                  placeholder="When enabled above"
                />
              </label>
              <label className="block text-sm font-medium text-inst-navy">
                Policy commitment (64 hex chars, or leave blank for 32 zero bytes)
                <input
                  className="inst-input font-sans"
                  value={policyHex}
                  onChange={(e) => setPolicyHex(e.target.value)}
                />
              </label>
              <button
                type="button"
                disabled={!ready || provisionChecking || !treasuryVaultReady}
                onClick={() => onUpsertPolicy().catch(logErr)}
                className="inst-btn"
              >
                Upsert auditor policy
              </button>
            </section>

            <section className="inst-card space-y-5 !shadow-none">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-inst-navy">
                Module 3 — Shield rail (raw)
              </h2>
              <p className="text-xs leading-relaxed text-inst-muted">
                For non-USDC assets or scripted precision: instruction carries a cryptographic{" "}
                <span className="font-medium text-inst-navy">commitment</span> and{" "}
                <span className="font-medium text-inst-navy">opening</span> (not a public{" "}
                <span className="font-mono text-xs">u64</span> in the IDL). For USDC, prefer the main
                Shield workflow; Forensic Silence still applies after confirmation.
              </p>
              <label className="block text-sm font-medium text-inst-navy">
                Amount (raw token units)
                <input
                  className="inst-input font-sans"
                  value={depositAmount}
                  onChange={(e) => setDepositAmount(e.target.value)}
                />
              </label>
              <button
                type="button"
                disabled={!ready || provisionChecking || !treasuryVaultReady}
                onClick={() => onDepositPublic("raw-field").catch(logErr)}
                className="inst-btn-primary"
              >
                Execute deposit (raw field)
              </button>
            </section>

            <VaultAdvancedCofrePanel
              cofreReady={cofreReady}
              cofreShadowUnlocked={cofreShadowUnlocked}
              bunkerShadowMeta={bunkerShadowMeta}
              cofreAmount={cofreAmount}
              onCofreAmountChange={setCofreAmount}
              userCofreAta={userCofreAta}
              vaultCofreAta={cofreVaultAtas?.vaultTokenAccount ?? null}
              ba5qMintDisplay={ba5qMintDisplay}
              onDeposit={() => onDepositCofre().catch(logErr)}
              onWithdraw={() => onWithdrawCofre().catch(logErr)}
              walletBunkerBalance={walletBunkerBalance}
              walletBunkerBalanceBusy={walletBunkerBalanceBusy}
              onRefreshWalletBunkerBalance={() =>
                refreshWalletBunkerBalance().catch(logErr)
              }
              onUseMaxWalletRaw={onUseMaxWalletRaw}
              bunkerUsesUsdc={bunkerUsesUsdc}
              vaultOpsReady={bunkerVaultReady}
              vaultOpsHint={
                bunkerVaultGateMessage ??
                (!ba5qMint
                  ? "Select or create a bunker mint first."
                  : bunkerProvision.kind === "needs_init"
                    ? `Initialize Institutional Vault from the dashboard (or Run initialize_vault below) before bunker deposits. Expected VaultConfig: ${deriveVaultConfig(PROGRAM_ID, ba5qMint)[0].toBase58()}.`
                    : null)
              }
            />

            <section className="inst-card space-y-5 !shadow-none">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-inst-navy">
                Egress — Phase 2 preview
              </h2>
              <p className="text-xs leading-relaxed text-inst-muted">
                Engineering preview: expects program abort <span className="font-mono">6017</span>{" "}
                (ContractLogicNotYetLive) until egress is production-ready.
              </p>
              <button
                type="button"
                disabled={!ready}
                onClick={() => onCreatePoolPlaceholderAta().catch(logErr)}
                className="inst-btn"
              >
                Initialize pool placeholder ATA
              </button>
              <label className="block text-sm font-medium text-inst-navy">
                Light pool token account (optional override)
                <input
                  className="inst-input font-sans"
                  value={lightPoolAtaStr}
                  onChange={(e) => setLightPoolAtaStr(e.target.value)}
                />
              </label>
              <label className="block text-sm font-medium text-inst-navy">
                Recipient token account (optional override)
                <input
                  className="inst-input font-sans"
                  value={recipientAtaStr}
                  onChange={(e) => setRecipientAtaStr(e.target.value)}
                />
              </label>
              <button
                type="button"
                disabled={!ready}
                onClick={() => onEgressPreview().catch(logErr)}
                className="inst-btn-destructive"
              >
                Run egress preview (expected abort)
              </button>
            </section>
              </div>
            </div>
          </div>
        </>
      ) : null}

      <aside className="w-[380px] shrink-0 overflow-y-auto border-l border-inst-border bg-inst-surface/30 p-6">
        <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-inst-navy">
          Ledger &amp; audit log
        </h2>
        {txLog.length === 0 ? (
          <p className="text-sm leading-relaxed text-inst-muted">No entries yet.</p>
        ) : (
          <ul className="space-y-3 text-xs leading-relaxed">
            {txLog.map((t, idx) => (
              <li
                key={`${idx}-${t.kind}-${t.label}-${t.sig}`}
                className={`break-all rounded-inst border border-inst-border bg-inst-bg p-3 shadow-sm ${
                  t.kind === "audit" ? "border-l-4 border-l-inst-accent" : ""
                }`}
              >
                <div
                  className={
                    t.kind === "audit"
                      ? "font-medium text-inst-navy"
                      : "text-inst-navy"
                  }
                >
                  {t.label}
                </div>
                {t.kind === "chain" ? (
                  <a
                    href={solscanTx(t.sig)}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-1 inline-block font-mono text-[11px] text-inst-accent underline"
                  >
                    {t.sig}
                  </a>
                ) : (
                  <div className="mt-1 text-[10px] uppercase tracking-wide text-inst-muted">
                    audit · no on-chain signature
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </aside>

      {complianceOpen ? (
        <div className="fixed inset-0 z-[55] flex items-center justify-center bg-inst-navy/25 p-4 backdrop-blur-sm">
          <div
            className="max-h-[90vh] w-full max-w-2xl overflow-hidden rounded-inst border border-inst-border bg-inst-bg shadow-inst-lg"
            role="dialog"
            aria-modal="true"
            aria-labelledby="compliance-doc-title"
          >
            <div className="border-b border-inst-border bg-inst-surface/50 px-8 py-6">
              <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-inst-muted">
                Confidential · selective disclosure
              </p>
              <h2
                id="compliance-doc-title"
                className="mt-2 text-xl font-semibold tracking-tight text-inst-navy"
              >
                RESERVED <span className="font-normal text-inst-muted">|</span> Proof of Assets
                &amp; Compliance
              </h2>
              <p className="mt-2 text-xs text-inst-muted">
                Generated {complianceReport.generatedAt} · {complianceReport.network}
              </p>
            </div>

            <div className="max-h-[calc(90vh-14rem)] overflow-auto px-8 py-6">
              <table className="w-full border-collapse text-left text-sm">
                <thead>
                  <tr className="bg-inst-navy text-white">
                    <th className="rounded-tl-lg px-4 py-3 font-semibold">Subject</th>
                    <th className="rounded-tr-lg px-4 py-3 font-semibold">Record</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-inst-border text-inst-navy">
                  <tr className="bg-white">
                    <td className="px-4 py-3 text-inst-muted">Wallet session</td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <ComplianceStatusBadge
                          status={complianceReport.walletConnected ? "VERIFIED" : "ENCRYPTED"}
                        />
                        <span className="break-all text-xs">{complianceReport.wallet}</span>
                      </div>
                    </td>
                  </tr>
                  <tr className="bg-inst-surface/40">
                    <td className="px-4 py-3 text-inst-muted">SBED authentication</td>
                    <td className="px-4 py-3">
                      <ComplianceStatusBadge
                        status={complianceReport.sbedAuthenticated ? "VERIFIED" : "ENCRYPTED"}
                      />
                    </td>
                  </tr>
                  <tr className="bg-white">
                    <td className="px-4 py-3 text-inst-muted">Custodied balance (disclosed)</td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <ComplianceStatusBadge
                          status={complianceReport.balanceDisclosed ? "VERIFIED" : "ENCRYPTED"}
                        />
                        <span>
                          {complianceReport.disclosedBalanceUi ?? "— withheld pending authentication"}
                        </span>
                      </div>
                    </td>
                  </tr>
                  <tr className="bg-inst-surface/40">
                    <td className="px-4 py-3 text-inst-muted">Treasury mint</td>
                    <td className="break-all px-4 py-3 text-xs">{complianceReport.treasuryMint}</td>
                  </tr>
                  <tr className="bg-white">
                    <td className="px-4 py-3 text-inst-muted">Vault audit mint</td>
                    <td className="break-all px-4 py-3 text-xs">{complianceReport.vaultViewMint}</td>
                  </tr>
                  <tr className="bg-inst-surface/40">
                    <td className="px-4 py-3 text-inst-muted">On-chain vault authority</td>
                    <td className="break-all px-4 py-3 text-xs">{complianceReport.vaultAuthority}</td>
                  </tr>
                  <tr className="bg-white">
                    <td className="px-4 py-3 text-inst-muted">Program</td>
                    <td className="break-all px-4 py-3 text-xs">{complianceReport.programId}</td>
                  </tr>
                  <tr className="bg-inst-surface/40">
                    <td className="px-4 py-3 text-inst-muted">RPC endpoint</td>
                    <td className="break-all px-4 py-3 text-xs">{complianceReport.rpcEndpoint}</td>
                  </tr>
                  <tr className="bg-white">
                    <td className="px-4 py-3 text-inst-muted">Environment</td>
                    <td className="px-4 py-3">{complianceReport.environment}</td>
                  </tr>
                  <tr className="bg-inst-navy">
                    <td colSpan={2} className="px-4 py-2.5 text-xs font-semibold text-white">
                      Ledger activity (session)
                    </td>
                  </tr>
                  <tr className="bg-inst-surface/40">
                    <td className="px-4 py-3 text-inst-muted">On-chain transactions logged</td>
                    <td className="px-4 py-3 font-medium tabular-nums">{complianceReport.chainTxCount}</td>
                  </tr>
                  <tr className="bg-white">
                    <td className="px-4 py-3 text-inst-muted">Audit events logged</td>
                    <td className="px-4 py-3 font-medium tabular-nums">{complianceReport.auditCount}</td>
                  </tr>
                </tbody>
              </table>

              {complianceReport.liquidityRoot ? (
                <div className="mt-6 rounded-xl border border-inst-border bg-inst-surface/60 p-4">
                  <h3 className="text-[10px] font-semibold uppercase tracking-wider text-inst-navy">
                    Bunker anchor (authenticated session)
                  </h3>
                  <dl className="mt-3 space-y-2 text-xs">
                    <div className="flex justify-between gap-4">
                      <dt className="text-inst-muted">Sequence</dt>
                      <dd className="font-medium text-inst-navy">{complianceReport.shadowSequence}</dd>
                    </div>
                    <div>
                      <dt className="text-inst-muted">Liquidity root</dt>
                      <dd className="mt-1 break-all font-sans text-[11px] leading-relaxed text-inst-navy">
                        {complianceReport.liquidityRoot}
                      </dd>
                    </div>
                  </dl>
                </div>
              ) : null}

              <p className="mt-6 border-t border-inst-border pt-4 text-center text-[11px] leading-relaxed text-inst-muted">
                This document summarizes voluntarily disclosed UI state for demonstration purposes
                only. It is not legal, regulatory, or accounting advice.
              </p>
            </div>

            <div className="flex justify-end border-t border-inst-border bg-inst-surface/30 px-8 py-4">
              <button
                type="button"
                className="inst-btn"
                onClick={() => setComplianceOpen(false)}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {forensicSilenceToast ? (
        <div
          className="inst-toast pointer-events-none fixed bottom-8 left-1/2 z-[60] max-w-md -translate-x-1/2 rounded-inst border border-inst-border bg-inst-bg px-5 py-4 text-center shadow-inst-lg"
          role="status"
        >
          <span className="text-xs font-semibold uppercase tracking-wider text-inst-accent">
            [ AUDIT ]
          </span>{" "}
          <span className="text-sm leading-relaxed text-inst-navy">
            Forensic Silence Enforced: session and ZK proof buffers purged.
          </span>
        </div>
      ) : null}

      {fatalModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-inst-navy/40 p-4 backdrop-blur-sm">
          <div
            className={`max-h-[80vh] w-full max-w-lg overflow-auto rounded-inst border p-6 font-mono text-sm shadow-inst-lg ${
              fatalModal.startsWith("EXPECTED")
                ? "border-amber-400/50 bg-inst-bg text-amber-900"
                : "border-red-300 bg-inst-bg text-red-800"
            }`}
          >
            <div className="mb-2 font-semibold">
              {fatalModal.startsWith("EXPECTED")
                ? "[ ROADMAP CONFIRMED ]"
                : "[ RUNTIME ERROR ]"}
            </div>
            <pre className="whitespace-pre-wrap break-words">{fatalModal}</pre>
            <button
              type="button"
              className="mt-4 rounded-inst border border-inst-border px-4 py-2 text-sm font-medium hover:bg-inst-surface"
              onClick={() => setFatalModal(null)}
            >
              Dismiss
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function App() {
  const endpoint = DEVNET_RPC;
  const wallets = useMemo(
    () => [new PhantomWalletAdapter(), new SolflareWalletAdapter()],
    [],
  );
  return (
    <RootConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <InnerConsole />
        </WalletModalProvider>
      </WalletProvider>
    </RootConnectionProvider>
  );
}
