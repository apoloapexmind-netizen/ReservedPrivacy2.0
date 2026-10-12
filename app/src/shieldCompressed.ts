import type { Idl, Program } from "@coral-xyz/anchor";
import * as BNLib from "bn.js";
import {
  createTransferInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { ComputeBudgetProgram, Connection, PublicKey, Transaction } from "@solana/web3.js";
import { keccak_256 } from "@noble/hashes/sha3";
import {
  createBN254,
  defaultTestStateTreeAccounts,
  DerivationMode,
  deriveAddressLegacy,
  deriveAddressSeedV2,
  deriveAddressV2,
  PackedAccounts,
  selectStateTreeInfo,
  SystemAccountMetaConfig,
  TreeType,
  type Rpc,
  type TreeInfo,
  type ValidityProofWithContext,
} from "@lightprotocol/stateless.js";
import { withLightRpcRetries } from "./utils/reconnection";
const BN = (BNLib as any).default || BNLib;
const LIGHT_SYSTEM_PROGRAM_ID = "SySTEM1eSU2p4BGQfQpimFEWWSC1XDFeun3Nqzz3rT7";
const SHIELD_COMPUTE_UNIT_LIMIT = 800_000;
const LIGHT_SYNC_COMMITMENT = "confirmed";
const LIGHT_INDEXER_MAX_POLLS = 8;
const LIGHT_INDEXER_BASE_DELAY_MS = 250;
const LIGHT_INDEXER_MAX_DELAY_MS = 2_000;

function indexOfPubkeyInLightTreeAccounts(
  metas: readonly { pubkey: PublicKey }[],
  key: PublicKey,
): number {
  const i = metas.findIndex((m) => m.pubkey.equals(key));
  if (i < 0 || i > 255) {
    throw new Error("");
  }
  return i;
}

/** Drops consecutive duplicate metas (same pubkey + flags). */
function collapseAdjacentDuplicateMetas<
  T extends { pubkey: PublicKey; isSigner: boolean; isWritable: boolean },
>(metas: T[]): T[] {
  const out: T[] = [];
  for (const m of metas) {
    const prev = out[out.length - 1];
    if (
      prev &&
      prev.pubkey.equals(m.pubkey) &&
      prev.isSigner === m.isSigner &&
      prev.isWritable === m.isWritable
    ) {
      continue;
    }
    out.push(m);
  }
  return out;
}

function dropRepeatPubkey<T extends { pubkey: PublicKey }>(ms: T[], k: PublicKey): T[] {
  let u = false;
  return ms.filter((m) => {
    if (!m.pubkey.equals(k)) return true;
    if (!u) {
      u = true;
      return true;
    }
    return false;
  });
}

type IndexedMeta = {
  pubkey: PublicKey;
  isSigner: boolean;
  isWritable: boolean;
  section: "system" | "tree";
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withConfirmedCommitment(connection: Connection): Connection {
  if (connection.commitment === LIGHT_SYNC_COMMITMENT) {
    return connection;
  }
  return new Connection(connection.rpcEndpoint, LIGHT_SYNC_COMMITMENT);
}

async function awaitLightIndexerSync(
  connection: Connection,
  rpc: Rpc,
  label: string,
): Promise<{
  targetConfirmedSlot: number;
  initialIndexerSlot: number;
  finalIndexerSlot: number;
}> {
  const targetConfirmedSlot = await connection.getSlot(LIGHT_SYNC_COMMITMENT);
  let initialIndexerSlot = await rpc.getIndexerSlot();
  let finalIndexerSlot = initialIndexerSlot;

  if (finalIndexerSlot < targetConfirmedSlot) {
    try {
      const indexed = await rpc.confirmTransactionIndexed(targetConfirmedSlot);
      if (indexed) {
        finalIndexerSlot = await rpc.getIndexerSlot();
      }
    } catch {
      // Some providers do not support index-confirm polling reliably; fall back to explicit slot polling.
    }
  }

  for (
    let poll = 0;
    finalIndexerSlot < targetConfirmedSlot && poll < LIGHT_INDEXER_MAX_POLLS;
    poll += 1
  ) {
    const lag = targetConfirmedSlot - finalIndexerSlot;
    const delayMs = Math.min(
      LIGHT_INDEXER_MAX_DELAY_MS,
      LIGHT_INDEXER_BASE_DELAY_MS + lag * 25,
    );
    await sleep(delayMs);
    finalIndexerSlot = await rpc.getIndexerSlot();
  }

  console.info("[shield] Light indexer sync", {
    label,
    commitment: LIGHT_SYNC_COMMITMENT,
    rpcEndpoint: connection.rpcEndpoint,
    targetConfirmedSlot,
    initialIndexerSlot,
    finalIndexerSlot,
    lag: targetConfirmedSlot - finalIndexerSlot,
  });

  if (finalIndexerSlot < targetConfirmedSlot) {
    throw new Error(
      `Light indexer is behind confirmed RPC for ${label}: confirmed=${targetConfirmedSlot}, indexer=${finalIndexerSlot}`,
    );
  }

  return {
    targetConfirmedSlot,
    initialIndexerSlot,
    finalIndexerSlot,
  };
}

/**
 * ZK validity proofs and Merkle witnesses are obtained via `@lightprotocol/stateless.js`
 * (`getValidityProofV2` + prover RPC). A package `@light-protocol/zk-compression-pkgs`
 * is not published on npm at this time.
 */

const AMOUNT_COMMITMENT_SCHEMA_V1 = new TextEncoder().encode(
  "RESV/amount_leaf:v1",
);
const SEED_LIGHT_POOL_CUSTODY = new TextEncoder().encode("light_pool_custody");
// Keep this as exact ASCII bytes so the client seed matches Rust `b"reserved_shield"` bit-for-bit.
const SEED_RESERVED_SHIELD = Uint8Array.from([
  0x72, 0x65, 0x73, 0x65, 0x72, 0x76, 0x65, 0x64,
  0x5f, 0x73, 0x68, 0x69, 0x65, 0x6c, 0x64,
]);
const MAX_U64 = (1n << 64n) - 1n;
const NETWORK_EXPECTED_COMPRESSED_ADDRESS_PREFIX_HEX = "00b8d9bd";

/** In-memory copies for Forensic Silence purge (wallet popup / abandoned builds). */
const zkVolatile = {
  proofA: null as Uint8Array | null,
  proofB: null as Uint8Array | null,
  proofC: null as Uint8Array | null,
  addressSeed: null as Uint8Array | null,
  amountCommitment: null as Uint8Array | null,
  nextAnchorHint: null as Uint8Array | null,
};

function wipeBytes(b: Uint8Array | null): null {
  if (b) b.fill(0);
  return null;
}

/** Zero-fill volatile ZK artifacts. */
export function wipeZkShieldVolatile(): void {
  zkVolatile.proofA = wipeBytes(zkVolatile.proofA);
  zkVolatile.proofB = wipeBytes(zkVolatile.proofB);
  zkVolatile.proofC = wipeBytes(zkVolatile.proofC);
  zkVolatile.addressSeed = wipeBytes(zkVolatile.addressSeed);
  zkVolatile.amountCommitment = wipeBytes(zkVolatile.amountCommitment);
  zkVolatile.nextAnchorHint = wipeBytes(zkVolatile.nextAnchorHint);
}

function captureZkVolatile(args: {
  compressed: { a: number[]; b: number[]; c: number[] };
  addressSeed: Uint8Array;
  amountCommitment: Uint8Array;
  nextAnchorHint: Uint8Array;
}): void {
  wipeZkShieldVolatile();
  zkVolatile.proofA = Uint8Array.from(args.compressed.a);
  zkVolatile.proofB = Uint8Array.from(args.compressed.b);
  zkVolatile.proofC = Uint8Array.from(args.compressed.c);
  zkVolatile.addressSeed = Uint8Array.from(args.addressSeed);
  zkVolatile.amountCommitment = Uint8Array.from(args.amountCommitment);
  zkVolatile.nextAnchorHint = Uint8Array.from(args.nextAnchorHint);
}

function u64Le(n: bigint): Uint8Array {
  if (n < 0n || n > MAX_U64) {
    throw new Error(`u64Le expects an unsigned 64-bit value (got ${n.toString()})`);
  }
  const b = new Uint8Array(8);
  let x = n;
  for (let i = 0; i < 8; i++) {
    b[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return b;
}

function concatParts(parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function hashvToBn254FieldSizeBeCompat(parts: readonly Uint8Array[]): Uint8Array {
  // Mirrors Light Rust `hashv_to_bn254_field_size_be_const_array`:
  // Keccak(input_0 || ... || input_n || 0xff), then force the top byte to zero
  // so the result fits in the BN254 field.
  const hasher = keccak_256.create();
  for (const part of parts) {
    hasher.update(part);
  }
  hasher.update(Uint8Array.from([0xff]));
  const out = Uint8Array.from(hasher.digest());
  out[0] = 0;
  return out;
}

/** Mirrors `public_amount_commitment_v1` in `light_shield.rs` (Solana `hashv` = SHA-256 of concatenation). */
export async function publicAmountCommitmentV1(
  amount: bigint,
  vaultCfg: PublicKey,
  noteSequence: bigint,
  depositMint: PublicKey,
  chainIdHash: Uint8Array,
  spendAuthority: PublicKey,
  programId: PublicKey,
): Promise<Uint8Array> {
  if (chainIdHash.length !== 32) {
    throw new Error("");
  }
  const preimage = concatParts([
    AMOUNT_COMMITMENT_SCHEMA_V1,
    u64Le(amount),
    new Uint8Array(vaultCfg.toBytes()),
    u64Le(noteSequence),
    new Uint8Array(depositMint.toBytes()),
    chainIdHash,
    new Uint8Array(spendAuthority.toBytes()),
    new Uint8Array(programId.toBytes()),
  ]);
  const digest = await crypto.subtle.digest("SHA-256", preimage);
  return new Uint8Array(digest);
}

function deriveLightPoolCustodyAta(
  programId: PublicKey,
  depositMint: PublicKey,
): PublicKey {
  const [custodyPda] = PublicKey.findProgramAddressSync(
    [Buffer.from(SEED_LIGHT_POOL_CUSTODY), mintToBuffer(depositMint)],
    programId,
  );
  return getAssociatedTokenAddressSync(
    depositMint,
    custodyPda,
    true,
    TOKEN_PROGRAM_ID,
  );
}

function mintToBuffer(m: PublicKey): Buffer {
  return Buffer.from(m.toBytes());
}

/**
 * `PackedAccounts` dedupes by pubkey: if state and address Merkle (or queues) match, Light CPI
 * ends up with 3 writable tree accounts instead of 4 → discriminator errors (e.g. 6042).
 */
function pickDistinctStateTreeForShield(
  trees: TreeInfo[],
  addressTree: TreeInfo,
): TreeInfo {
  const stateV2 = trees.filter((t) => t.treeType === TreeType.StateV2);
  const distinct = stateV2.filter(
    (t) =>
      !t.tree.equals(addressTree.tree) && !t.queue.equals(addressTree.queue),
  );
  if (distinct.length > 0) {
    return selectStateTreeInfo(distinct, TreeType.StateV2, false);
  }
  const fallback = selectStateTreeInfo(trees, TreeType.StateV2, false);
  if (
    fallback.tree.equals(addressTree.tree) ||
    fallback.queue.equals(addressTree.queue)
  ) {
    throw new Error("");
  }
  return fallback;
}

/**
 * `ValidityProof` in the IDL is a tuple-like struct (single unnamed field). Anchor encodes that field as `"0"`.
 * The field type is `Option<CompressedProof>`; `Some(x)` is passed as `x`, not wrapped.
 */
function validityProofForAnchor(proof: {
  a: number[];
  b: number[];
  c: number[];
} | null): { "0": { a: number[]; b: number[]; c: number[] } | null } {
  return { "0": proof ? normalizeCompressedProof(proof) : null };
}

/** Groth16-ish `ValidityProof`: expect 32 + 64 + 32 bytes; reject empty / all-zero (InvalidAddressProof / prover). */
function assertUsableCompressedProof(proof: {
  a: number[];
  b: number[];
  c: number[];
}): void {
  if (proof.a.length !== 32 || proof.b.length !== 64 || proof.c.length !== 32) {
    throw new Error("");
  }
  const anyNonZero = [...proof.a, ...proof.b, ...proof.c].some((x) => x !== 0);
  if (!anyNonZero) {
    throw new Error("");
  }
}

function toFixedNumberArray(
  name: string,
  bytes: Uint8Array | readonly number[],
  expectedLen: number,
): number[] {
  const arr = Array.from(bytes);
  if (arr.length !== expectedLen) {
    throw new Error(`${name} must be exactly ${expectedLen} bytes (got ${arr.length})`);
  }
  if (!arr.every((v) => Number.isInteger(v) && v >= 0 && v <= 255)) {
    throw new Error(`${name} must contain only u8 values`);
  }
  return arr;
}

function bytesToHex(bytes: Uint8Array | readonly number[]): string {
  return Buffer.from(Array.from(bytes)).toString("hex");
}

function pubkeyBytes32(name: string, key: PublicKey): Uint8Array {
  const bytes = new Uint8Array(key.toBytes());
  if (bytes.length !== 32) {
    throw new Error(`${name} must serialize to exactly 32 bytes (got ${bytes.length})`);
  }
  return bytes;
}

function summarizeSeedParts(parts: readonly Uint8Array[]) {
  return parts.map((part, index) => ({
    index,
    length: part.length,
    hex: bytesToHex(part),
  }));
}

function deriveCompressedAddressCompat(
  addressSeed: Uint8Array,
  addressTree: PublicKey,
  programId: PublicKey,
): PublicKey {
  return new PublicKey(
    hashvToBn254FieldSizeBeCompat([
      addressSeed,
      new Uint8Array(addressTree.toBytes()),
      new Uint8Array(programId.toBytes()),
    ]),
  );
}

function deriveCompressedAddressLegacyCompat(
  addressSeed: Uint8Array,
  addressTree: PublicKey,
): PublicKey {
  return new PublicKey(
    hashvToBn254FieldSizeBeCompat([
      new Uint8Array(addressTree.toBytes()),
      addressSeed,
    ]),
  );
}

function summarizeSeedVariantDiagnostics(args: {
  spendAuthorityBytes: Uint8Array;
  vaultConfigBytes: Uint8Array;
  noteSequenceLe: Uint8Array;
  addressTree: PublicKey;
  outputStateTree: PublicKey;
  programId: PublicKey;
}) {
  const variants: Array<{ label: string; parts: Uint8Array[] }> = [
    {
      label: "canonical_prefix_spend_vault_seq",
      parts: [
        SEED_RESERVED_SHIELD,
        args.spendAuthorityBytes,
        args.vaultConfigBytes,
        args.noteSequenceLe,
      ],
    },
    {
      label: "prefix_spend_seq_vault",
      parts: [
        SEED_RESERVED_SHIELD,
        args.spendAuthorityBytes,
        args.noteSequenceLe,
        args.vaultConfigBytes,
      ],
    },
    {
      label: "prefix_vault_spend_seq",
      parts: [
        SEED_RESERVED_SHIELD,
        args.vaultConfigBytes,
        args.spendAuthorityBytes,
        args.noteSequenceLe,
      ],
    },
    {
      label: "prefix_seq_spend_vault",
      parts: [
        SEED_RESERVED_SHIELD,
        args.noteSequenceLe,
        args.spendAuthorityBytes,
        args.vaultConfigBytes,
      ],
    },
    {
      label: "prefix_spend_seq",
      parts: [SEED_RESERVED_SHIELD, args.spendAuthorityBytes, args.noteSequenceLe],
    },
    {
      label: "prefix_seq_spend",
      parts: [SEED_RESERVED_SHIELD, args.noteSequenceLe, args.spendAuthorityBytes],
    },
    {
      label: "prefix_vault_seq",
      parts: [SEED_RESERVED_SHIELD, args.vaultConfigBytes, args.noteSequenceLe],
    },
  ];
  return variants.map(({ label, parts }) => {
    const addressSeed = hashvToBn254FieldSizeBeCompat(parts);
    const compressedAddress = deriveCompressedAddressCompat(
      addressSeed,
      args.addressTree,
      args.programId,
    );
    const compressedAddressHex = bytesToHex(compressedAddress.toBytes());
    const legacyCompressedAddress = deriveCompressedAddressLegacyCompat(
      addressSeed,
      args.addressTree,
    );
    const legacyCompressedAddressHex = bytesToHex(legacyCompressedAddress.toBytes());
    const outputStateTreeCompressedAddress = deriveCompressedAddressCompat(
      addressSeed,
      args.outputStateTree,
      args.programId,
    );
    const outputStateTreeCompressedAddressHex = bytesToHex(
      outputStateTreeCompressedAddress.toBytes(),
    );
    return {
      label,
      seedHex: bytesToHex(addressSeed),
      compressedAddressHex,
      compressedAddressBase58: compressedAddress.toBase58(),
      matchesExpectedCompressedPrefix: compressedAddressHex.startsWith(
        NETWORK_EXPECTED_COMPRESSED_ADDRESS_PREFIX_HEX,
      ),
      legacyCompressedAddressHex,
      legacyCompressedAddressBase58: legacyCompressedAddress.toBase58(),
      legacyMatchesExpectedCompressedPrefix: legacyCompressedAddressHex.startsWith(
        NETWORK_EXPECTED_COMPRESSED_ADDRESS_PREFIX_HEX,
      ),
      outputStateTreeCompressedAddressHex,
      outputStateTreeCompressedAddressBase58: outputStateTreeCompressedAddress.toBase58(),
      outputStateTreeMatchesExpectedCompressedPrefix:
        outputStateTreeCompressedAddressHex.startsWith(
          NETWORK_EXPECTED_COMPRESSED_ADDRESS_PREFIX_HEX,
        ),
      seedParts: summarizeSeedParts(parts),
    };
  });
}

function deriveShieldAddressMaterial(args: {
  spendAuthority: PublicKey;
  vaultConfig: PublicKey;
  noteSequence: bigint;
  addressTree: PublicKey;
  addressTreeType: TreeType;
  outputStateTree: PublicKey;
  programId: PublicKey;
}): {
  seedParts: Uint8Array[];
  noteSequenceLe: Uint8Array;
  addressSeed: Uint8Array;
  compressedAddress: PublicKey;
  sdkAddressSeed: Uint8Array;
  sdkCompressedAddress: PublicKey;
  spendAuthorityBytes: Uint8Array;
  vaultConfigBytes: Uint8Array;
  variantDiagnostics: Array<{
    label: string;
    seedHex: string;
    compressedAddressHex: string;
    compressedAddressBase58: string;
    matchesExpectedCompressedPrefix: boolean;
    legacyCompressedAddressHex: string;
    legacyCompressedAddressBase58: string;
    legacyMatchesExpectedCompressedPrefix: boolean;
    outputStateTreeCompressedAddressHex: string;
    outputStateTreeCompressedAddressBase58: string;
    outputStateTreeMatchesExpectedCompressedPrefix: boolean;
    seedParts: ReturnType<typeof summarizeSeedParts>;
  }>;
} {
  // Seed derivation stays canonical across tree versions:
  // 1. address_seed = H(["reserved_shield", spend_authority, vault_config, note_sequence_le_u64])
  // 2. compressed_address uses AddressV1 legacy hashing for legacy trees, otherwise V2 hashing.
  const noteSequenceLe = u64Le(args.noteSequence);
  const spendAuthorityBytes = pubkeyBytes32("spendAuthority", args.spendAuthority);
  const vaultConfigBytes = pubkeyBytes32("vaultConfig", args.vaultConfig);
  const seedParts: Uint8Array[] = [
    SEED_RESERVED_SHIELD,
    spendAuthorityBytes,
    vaultConfigBytes,
    noteSequenceLe,
  ];
  const sdkAddressSeed = new Uint8Array(deriveAddressSeedV2(seedParts));
  const addressSeed = hashvToBn254FieldSizeBeCompat(seedParts);
  const sdkCompressedAddress = deriveAddressV2(
    sdkAddressSeed,
    args.addressTree,
    args.programId,
  );
  const sdkCompressedAddressEffective =
    args.addressTreeType === TreeType.AddressV1
      ? deriveAddressLegacy(sdkAddressSeed, args.addressTree)
      : sdkCompressedAddress;
  const compressedAddress =
    args.addressTreeType === TreeType.AddressV1
      ? deriveCompressedAddressLegacyCompat(addressSeed, args.addressTree)
      : deriveCompressedAddressCompat(
          addressSeed,
          args.addressTree,
          args.programId,
        );
  if (bytesToHex(sdkAddressSeed) !== bytesToHex(addressSeed)) {
    throw new Error("Light address seed mismatch between SDK TS and local Rust-compatible derivation");
  }
  if (!sdkCompressedAddressEffective.equals(compressedAddress)) {
    throw new Error(
      "Light compressed address mismatch between SDK TS and local Rust-compatible derivation",
    );
  }
  return {
    seedParts,
    noteSequenceLe,
    addressSeed,
    compressedAddress,
    sdkAddressSeed,
    sdkCompressedAddress: sdkCompressedAddressEffective,
    spendAuthorityBytes,
    vaultConfigBytes,
    variantDiagnostics: summarizeSeedVariantDiagnostics({
      spendAuthorityBytes,
      vaultConfigBytes,
      noteSequenceLe,
      addressTree: args.addressTree,
      outputStateTree: args.outputStateTree,
      programId: args.programId,
    }),
  };
}

function assertPubkeysEqual(name: string, actual: PublicKey, expected: PublicKey): void {
  if (!actual.equals(expected)) {
    throw new Error(
      `${name} mismatch: expected ${expected.toBase58()}, got ${actual.toBase58()}`,
    );
  }
}

function normalizeCompressedProof(proof: {
  a: number[];
  b: number[];
  c: number[];
}): { a: number[]; b: number[]; c: number[] } {
  return {
    a: toFixedNumberArray("proof.a", proof.a, 32),
    b: toFixedNumberArray("proof.b", proof.b, 64),
    c: toFixedNumberArray("proof.c", proof.c, 32),
  };
}

function assertExactBytes(name: string, bytes: Uint8Array, expectedLen: number): void {
  if (bytes.length !== expectedLen) {
    throw new Error(`${name} must be exactly ${expectedLen} bytes (got ${bytes.length})`);
  }
}

function assertLightRemainingAlignment(
  metas: readonly { pubkey: PublicKey }[],
  addressTree: TreeInfo,
  outputStateTree: TreeInfo,
): void {
  const required = [
    ["outputStateTree.tree", outputStateTree.tree],
    ["outputStateTree.queue", outputStateTree.queue],
    ["addressTree.tree", addressTree.tree],
    ["addressTree.queue", addressTree.queue],
  ] as const;
  const missing = required
    .filter(([, pubkey]) => !metas.some((meta) => meta.pubkey.equals(pubkey)))
    .map(([label]) => label);
  if (missing.length > 0) {
    throw new Error(
      `Light remainingAccounts is missing required Merkle accounts: ${missing.join(", ")}`,
    );
  }
}

function summarizeIndexedMetas(metas: readonly IndexedMeta[]) {
  return metas.map((meta, idx) => ({
    index: idx,
    section: meta.section,
    pubkey: meta.pubkey.toBase58(),
    isSigner: meta.isSigner,
    isWritable: meta.isWritable,
  }));
}

function proofContextEntryForTree(
  proofCtx: ValidityProofWithContext,
  tree: TreeInfo,
): {
  matchedProofIndex: number;
  rootIndex: number;
  rootHex: string;
  leafIndex: number | undefined;
  proveByIndex: boolean | undefined;
  treeInfo: TreeInfo;
} {
  const treeInfos = proofCtx.treeInfos ?? [];
  const rootIndices = proofCtx.rootIndices ?? [];
  const roots = proofCtx.roots ?? [];
  const leafIndices = proofCtx.leafIndices ?? [];
  const proveByIndices = proofCtx.proveByIndices ?? [];
  if (
    treeInfos.length === 0 ||
    treeInfos.length !== rootIndices.length ||
    treeInfos.length !== roots.length
  ) {
    throw new Error("");
  }
  let idx = treeInfos.findIndex(
    (ti) => ti.tree.equals(tree.tree) && ti.queue.equals(tree.queue),
  );
  if (idx < 0) {
    idx = treeInfos.findIndex((ti) => ti.tree.equals(tree.tree));
  }
  if (idx < 0) {
    throw new Error("");
  }
  const rootIndex = rootIndices[idx];
  const root = roots[idx];
  if (
    rootIndex === undefined ||
    !Number.isFinite(rootIndex) ||
    root === undefined ||
    typeof (root as { toString?: unknown }).toString !== "function"
  ) {
    throw new Error("");
  }
  return {
    matchedProofIndex: idx,
    rootIndex,
    rootHex: `0x${root.toString(16).padStart(64, "0")}`,
    leafIndex: leafIndices[idx],
    proveByIndex: proveByIndices[idx],
    treeInfo: treeInfos[idx],
  };
}

function summarizeProofContext(proofCtx: ValidityProofWithContext) {
  const treeInfos = proofCtx.treeInfos ?? [];
  const roots = proofCtx.roots ?? [];
  const rootIndices = proofCtx.rootIndices ?? [];
  const leafIndices = proofCtx.leafIndices ?? [];
  const proveByIndices = proofCtx.proveByIndices ?? [];
  return treeInfos.map((treeInfo, idx) => ({
    proofIndex: idx,
    tree: treeInfo.tree.toBase58(),
    queue: treeInfo.queue.toBase58(),
    treeType: TreeType[treeInfo.treeType] ?? String(treeInfo.treeType),
    rootIndex: rootIndices[idx],
    rootHex:
      roots[idx] && typeof (roots[idx] as { toString?: unknown }).toString === "function"
        ? `0x${roots[idx].toString(16).padStart(64, "0")}`
        : null,
    leafIndex: leafIndices[idx],
    proveByIndex: proveByIndices[idx],
  }));
}

/**
 * Pick `root_index` for instruction data from the prover row matching the **same** `TreeInfo`
 * used in `getValidityProofV2` (shield: always the **address** tree; output still lands in state tree).
 */
function rootIndexForTreeFromProof(
  proofCtx: ValidityProofWithContext,
  tree: TreeInfo,
): number {
  return proofContextEntryForTree(proofCtx, tree).rootIndex;
}

/**
 * Fetch validity proof for the new shield address. **`treeInfo` must be an Address Tree**
 * (Helius / prover 500 on state tree). Output account still uses a separate **state** tree on-chain.
 *
 * **`derivedAddressRaw32`** must be the **raw 32-byte** derived address material (same as
 * `PublicKey.toBytes()` / on-chain `compressed_address`), not a BN254 hash or other digest.
 * `getMultipleNewAddressProofs` runs only for `TreeType.AddressV1` to catch root drift.
 *
 * **`ownerProgramId`**: Reserved deploy ID — forwarded to the prover body when supported so the
 * validity circuit matches {@link deriveAddress} (same program the CPI uses).
 */
export async function fetchFreshAddressValidityProof(
  connection: Connection,
  derivedAddressRaw32: Uint8Array,
  proofTreeInfo: TreeInfo,
  ownerProgramId: PublicKey,
): Promise<ValidityProofWithContext> {
  if (derivedAddressRaw32.length !== 32) {
    throw new Error("");
  }
  const newAddrForProver = {
    address: new Uint8Array(derivedAddressRaw32),
    treeInfo: proofTreeInfo,
    programId: ownerProgramId.toBase58(),
  };
  return withLightRpcRetries(connection, async (rpc: Rpc) => {
    const sync = await awaitLightIndexerSync(connection, rpc, "validity-proof");
    console.info("[shield] Light proof request", {
      programId: ownerProgramId.toBase58(),
      commitment: LIGHT_SYNC_COMMITMENT,
      targetConfirmedSlot: sync.targetConfirmedSlot,
      addressTree: proofTreeInfo.tree.toBase58(),
      addressQueue: proofTreeInfo.queue.toBase58(),
      addressTreeType: TreeType[proofTreeInfo.treeType] ?? String(proofTreeInfo.treeType),
    });
    let ctx = await rpc.getValidityProofV2(
      [],
      [newAddrForProver as any],
      DerivationMode.standard,
    );
    let proofRoot = rootIndexForTreeFromProof(ctx, proofTreeInfo);
    try {
      if (proofTreeInfo.treeType === TreeType.AddressV1) {
        const addrBn = createBN254(new Uint8Array(derivedAddressRaw32));
        const nap = await rpc.getMultipleNewAddressProofs([addrBn]);
        const indexerRoot = nap[0]?.rootIndex;
        if (
          indexerRoot !== undefined &&
          indexerRoot !== proofRoot
        ) {
          await awaitLightIndexerSync(connection, rpc, "validity-proof-refetch");
          ctx = await rpc.getValidityProofV2(
            [],
            [newAddrForProver as any],
            DerivationMode.standard,
          );
          proofRoot = rootIndexForTreeFromProof(ctx, proofTreeInfo);
        }
      }
    } catch {
      // Some RPC tiers omit getMultipleNewAddressProofs; validity proof alone is enough.
    }
    return ctx;
  });
}

export type ShieldZkParams = {
  connection: Connection;
  program: Program<Idl>;
  programId: PublicKey;
  spendAuthority: PublicKey;
  feePayer: PublicKey;
  mint: PublicKey;
  vaultConfig: PublicKey;
  vaultAuthority: PublicKey;
  vaultTokenAccount: PublicKey;
  userNoteHead: PublicKey;
  auditorPolicy: PublicKey;
  expectedPolicyCommitment: Uint8Array;
  auditorAttestor: PublicKey;
  /** Raw token units only (example: 1 USDC => 1_000_000). */
  amountRaw: bigint;
};

export type ShieldZkTxPayload = {
  transaction: Transaction;
  addressTree: TreeInfo;
  outputStateTree: TreeInfo;
  derivedAddressPk: PublicKey;
  noteDraft: ShieldCompressedNoteDraft;
};

export type ShieldCompressedNoteDraft = {
  spendAuthority: string;
  owner: string;
  vaultConfig: string;
  mint: string;
  amountRaw: string;
  noteSequence: string;
  addressSeedHex: string;
  compressedAddressHex: string;
  amountCommitmentHex: string;
  ovkBindingHex: string | null;
  blindingHex: string | null;
  addressTree: string;
  addressQueue: string;
  addressTreeType: "AddressV1" | "AddressV2" | "Unknown";
  outputStateTree: string;
  outputStateQueue: string;
};

/**
 * Build shield ZK tx, then sign/send **once** (single user signature).
 */
export async function sendShieldZkTx(
  params: ShieldZkParams,
  signSend: (tx: Transaction) => Promise<string>,
): Promise<{ signature: string; noteDraft: ShieldCompressedNoteDraft }> {
  const { transaction, noteDraft } = await buildShieldZkTxPayload(params);
  const signature = await signSend(transaction);
  return { signature, noteDraft };
}

/**
 * Real ZK shield: funds the vault with a **direct SPL transfer** (not `deposit_public`),
 * then `shield_into_compressed` (vault escrow → Light pool + Light CPI).
 */
export async function buildShieldZkTxPayload(
  params: ShieldZkParams,
): Promise<ShieldZkTxPayload> {
  const {
    connection: rawConnection,
    program,
    programId,
    spendAuthority,
    mint,
    vaultConfig,
    vaultAuthority,
    vaultTokenAccount,
    userNoteHead,
    auditorPolicy,
    expectedPolicyCommitment,
    auditorAttestor,
    amountRaw,
  } = params;
  const connection = withConfirmedCommitment(rawConnection);

  /** Reserved `program_id` for `deriveAddress` / `derive_address` (not Light System / token program). */
  const reservedProgramId = program.programId as PublicKey;
  if (!reservedProgramId.equals(programId)) {
    throw new Error("");
  }
  if (reservedProgramId.toBase58() === LIGHT_SYSTEM_PROGRAM_ID) {
    throw new Error("");
  }

  if (amountRaw <= 0n) {
    throw new Error("");
  }
  console.info("[shield] amount raw", {
    mint: mint.toBase58(),
    amountRaw: amountRaw.toString(),
  });
  if (expectedPolicyCommitment.length !== 32) {
    throw new Error("");
  }

  wipeZkShieldVolatile();

  const headAcc = await (
    program.account as { userNoteHead: { fetch: (k: PublicKey) => Promise<any> } }
  ).userNoteHead.fetch(userNoteHead);
  const noteSeq = BigInt(headAcc.noteSequence.toString());
  const canonicalSpendAuthority = headAcc.spendAuthority as PublicKey;

  const cfg = await (
    program.account as { vaultConfig: { fetch: (k: PublicKey) => Promise<any> } }
  ).vaultConfig.fetch(vaultConfig);
  const canonicalDepositMint = cfg.depositMint as PublicKey;
  const chainIdHash = new Uint8Array(Buffer.from(cfg.chainIdHash as number[]));
  assertPubkeysEqual("vaultConfig.depositMint", canonicalDepositMint, mint);
  assertPubkeysEqual("userNoteHead.spendAuthority", canonicalSpendAuthority, spendAuthority);

  console.info("[shield] amount commitment preimage", {
    amountRaw: amountRaw.toString(),
    vaultConfig: vaultConfig.toBase58(),
    noteSequence: noteSeq.toString(),
    depositMint: canonicalDepositMint.toBase58(),
    chainIdHashHex: bytesToHex(chainIdHash),
    spendAuthority: canonicalSpendAuthority.toBase58(),
    programId: reservedProgramId.toBase58(),
  });

  const amountCommitment = await publicAmountCommitmentV1(
    amountRaw,
    vaultConfig,
    noteSeq,
    canonicalDepositMint,
    chainIdHash,
    canonicalSpendAuthority,
    reservedProgramId,
  );
  assertExactBytes("amountCommitment", amountCommitment, 32);

  const useLocalDefaultLightTrees =
    typeof import.meta !== "undefined" &&
    import.meta.env.VITE_LIGHT_USE_LOCAL_DEFAULT_TREES === "true";

  const { addressTree, outputStateTree, addressSeed, derivedAddressPk } =
    await withLightRpcRetries(connection, async (rpc: Rpc) => {
      const sync = await awaitLightIndexerSync(connection, rpc, "tree-selection");
      let addr: TreeInfo;
      let outTree: TreeInfo;

      if (useLocalDefaultLightTrees) {
        // Localnet: use `defaultTestStateTreeAccounts` address pair (amt1 + aq1). `getDefaultAddressTreeInfo()`
        // in V2 maps both tree and queue to the same batchAddressTree pubkey — PackedAccounts would dedupe.
        const tst = defaultTestStateTreeAccounts();
        addr = {
          tree: tst.addressTree,
          queue: tst.addressQueue,
          treeType: TreeType.AddressV1,
          cpiContext: undefined,
          nextTreeInfo: null,
        };
        outTree = {
          tree: tst.merkleTree,
          queue: tst.nullifierQueue,
          treeType: TreeType.StateV2,
          cpiContext: undefined,
          nextTreeInfo: null,
        };
        if (
          outTree.tree.equals(addr.tree) ||
          outTree.queue.equals(addr.queue)
        ) {
          throw new Error("");
        }
      } else {
        addr = await rpc.getAddressTreeInfoV2();
        const trees = await rpc.getStateTreeInfos();
        outTree = pickDistinctStateTreeForShield(trees, addr);
      }
      console.info("[shield] Light tree selection", {
        commitment: LIGHT_SYNC_COMMITMENT,
        targetConfirmedSlot: sync.targetConfirmedSlot,
        programId: reservedProgramId.toBase58(),
        addressTree: addr.tree.toBase58(),
        addressQueue: addr.queue.toBase58(),
        addressTreeType: TreeType[addr.treeType] ?? String(addr.treeType),
        outputStateTree: outTree.tree.toBase58(),
        outputStateQueue: outTree.queue.toBase58(),
        outputStateType: TreeType[outTree.treeType] ?? String(outTree.treeType),
      });

      const {
        seedParts,
        noteSequenceLe,
        addressSeed,
        compressedAddress: derivedAddressPk,
        sdkAddressSeed,
        sdkCompressedAddress,
        spendAuthorityBytes,
        vaultConfigBytes,
        variantDiagnostics,
      } = deriveShieldAddressMaterial({
        spendAuthority: canonicalSpendAuthority,
        vaultConfig,
        noteSequence: noteSeq,
        addressTree: addr.tree,
        addressTreeType: addr.treeType,
        outputStateTree: outTree.tree,
        programId: reservedProgramId,
      });
      console.info("[shield] address derivation", {
        derivationMode: addr.treeType === TreeType.AddressV1 ? "address-v1-legacy" : "v2-explicit",
        ownerProgramId: reservedProgramId.toBase58(),
        addressTree: addr.tree.toBase58(),
        addressTreeType: TreeType[addr.treeType] ?? String(addr.treeType),
        noteSequence: noteSeq.toString(),
        noteSequenceLeHex: bytesToHex(noteSequenceLe),
        reservedShieldPrefixHex: bytesToHex(SEED_RESERVED_SHIELD),
        reservedShieldPrefixAscii: "reserved_shield",
        spendAuthoritySeedHex: bytesToHex(spendAuthorityBytes),
        vaultConfigSeedHex: bytesToHex(vaultConfigBytes),
        addressSeedHex: bytesToHex(addressSeed),
        compressedAddressHex: bytesToHex(derivedAddressPk.toBytes()),
        sdkAddressSeedHex: bytesToHex(sdkAddressSeed),
        sdkCompressedAddressHex: bytesToHex(sdkCompressedAddress.toBytes()),
        sdkSeedMatchesCompat: bytesToHex(sdkAddressSeed) === bytesToHex(addressSeed),
        sdkAddressMatchesCompat: sdkCompressedAddress.equals(derivedAddressPk),
        seedParts: summarizeSeedParts(seedParts),
        targetCompressedPrefixHex: NETWORK_EXPECTED_COMPRESSED_ADDRESS_PREFIX_HEX,
        variantDiagnostics,
      });

      return {
        addressTree: addr,
        outputStateTree: outTree,
        addressSeed,
        derivedAddressPk,
      };
    });

  const derivedAddressRaw32 = derivedAddressPk.toBytes();
  assertExactBytes("addressSeed", addressSeed, 32);
  assertExactBytes("derivedAddressRaw32", derivedAddressRaw32, 32);

  if (
    addressTree.tree.equals(outputStateTree.tree) ||
    addressTree.queue.equals(outputStateTree.queue)
  ) {
    throw new Error("");
  }

  const lightPoolAta = deriveLightPoolCustodyAta(reservedProgramId, mint);
  const userAta = getAssociatedTokenAddressSync(
    mint,
    spendAuthority,
    true,
    TOKEN_PROGRAM_ID,
  );

  const proofCtx = await fetchFreshAddressValidityProof(
    connection,
    derivedAddressRaw32,
    addressTree,
    reservedProgramId,
  );
  const proofEntry = proofContextEntryForTree(proofCtx, addressTree);

  const compressed = proofCtx.compressedProof;
  if (!compressed) {
    throw new Error("");
  }
  assertUsableCompressedProof(compressed);
  const proofWrapped = validityProofForAnchor(compressed);

  const nextAnchorHint = new Uint8Array(32);
  crypto.getRandomValues(nextAnchorHint);
  assertExactBytes("nextAnchorHint", nextAnchorHint, 32);
  assertExactBytes("expectedPolicyCommitment", expectedPolicyCommitment, 32);
  const amountCommitmentArg = toFixedNumberArray("amountCommitment", amountCommitment, 32);
  const nextAnchorHintArg = toFixedNumberArray("nextAnchorHint", nextAnchorHint, 32);
  const expectedPolicyCommitmentArg = toFixedNumberArray(
    "expectedPolicyCommitment",
    expectedPolicyCommitment,
    32,
  );
  const addressSeedArg = toFixedNumberArray("addressSeed", addressSeed, 32);
  const compressedAddressArg = toFixedNumberArray(
    "compressedAddress",
    derivedAddressRaw32,
    32,
  );

  captureZkVolatile({
    compressed,
    addressSeed,
    amountCommitment,
    nextAnchorHint,
  });

  const packedAccts = PackedAccounts.newWithSystemAccounts(
    SystemAccountMetaConfig.new(reservedProgramId),
  );

  packedAccts.insertOrGetConfig(
    outputStateTree.tree,
    false,
    true,
  );
  packedAccts.insertOrGetConfig(outputStateTree.queue, false, true);

  packedAccts.insertOrGetConfig(
    addressTree.tree,
    false,
    true,
  );
  if (!addressTree.tree.equals(addressTree.queue)) {
    packedAccts.insertOrGetConfig(addressTree.queue, false, true);
  }

  const { remainingAccounts, systemStart, packedStart } = packedAccts.toAccountMetas();
  const cpiSystemAccountCount = packedStart - systemStart;
  if (cpiSystemAccountCount < 0) {
    throw new Error("PackedAccounts returned invalid offsets");
  }
  const cpiSystemAccounts = remainingAccounts
    .slice(systemStart, packedStart)
    .map((meta): IndexedMeta => ({
      pubkey: meta.pubkey,
      isSigner: false,
      isWritable: meta.isWritable,
      section: "system",
    }));
  let T = collapseAdjacentDuplicateMetas(
    remainingAccounts.slice(packedStart).map((meta): IndexedMeta => {
      return {
        pubkey: meta.pubkey,
        isSigner: false,
        isWritable: meta.isWritable,
        section: "tree",
      };
    }),
  );
  if (addressTree.tree.equals(addressTree.queue)) {
    T = dropRepeatPubkey(T, addressTree.tree);
  }
  const M = [...cpiSystemAccounts, ...T];
  assertLightRemainingAlignment(T, addressTree, outputStateTree);

  const o = indexOfPubkeyInLightTreeAccounts(T, outputStateTree.tree);
  const a = indexOfPubkeyInLightTreeAccounts(T, addressTree.tree);
  const q = addressTree.tree.equals(addressTree.queue)
    ? a
    : indexOfPubkeyInLightTreeAccounts(T, addressTree.queue);

  const r = proofEntry.rootIndex & 0xffff;
  const P = {
    addressMerkleTreePubkeyIndex: a,
    addressQueuePubkeyIndex: q,
    rootIndex: r,
  };
  const resolvedOutputTree = T[o]?.pubkey;
  const resolvedAddressTree = T[a]?.pubkey;
  const resolvedAddressQueue = T[q]?.pubkey;
  if (!resolvedOutputTree || !resolvedAddressTree || !resolvedAddressQueue) {
    throw new Error("Resolved Light tree account is missing after CPI index packing");
  }
  const lightSystemProgramId = new PublicKey(LIGHT_SYSTEM_PROGRAM_ID);
  const diagReservedAddress = deriveAddressV2(addressSeed, resolvedAddressTree, reservedProgramId);
  const diagLegacyAddress = deriveAddressLegacy(addressSeed, resolvedAddressTree);
  const diagLightSystemAddress = deriveAddressV2(
    addressSeed,
    resolvedAddressTree,
    lightSystemProgramId,
  );
  const diagQueueReservedAddress = deriveAddressV2(
    addressSeed,
    resolvedAddressQueue,
    reservedProgramId,
  );

  console.info("[shield] Light proof roots", {
    selectedAddressTree: {
      tree: addressTree.tree.toBase58(),
      queue: addressTree.queue.toBase58(),
      type: TreeType[addressTree.treeType] ?? String(addressTree.treeType),
    },
    outputStateTree: {
      tree: outputStateTree.tree.toBase58(),
      queue: outputStateTree.queue.toBase58(),
      type: TreeType[outputStateTree.treeType] ?? String(outputStateTree.treeType),
    },
    selectedProofEntry: {
      proofIndex: proofEntry.matchedProofIndex,
      proofTree: proofEntry.treeInfo.tree.toBase58(),
      proofQueue: proofEntry.treeInfo.queue.toBase58(),
      rootIndex: proofEntry.rootIndex,
      rootHex: proofEntry.rootHex,
      leafIndex: proofEntry.leafIndex,
      proveByIndex: proofEntry.proveByIndex,
    },
    proofEntries: summarizeProofContext(proofCtx),
  });

  console.info("[shield] remainingAccounts indexed", {
    originalRemainingAccounts: remainingAccounts.map((meta, idx) => ({
      index: idx,
      section:
        idx < systemStart ? "pre" : idx < packedStart ? "system" : "packed",
      pubkey: meta.pubkey.toBase58(),
      isSigner: meta.isSigner,
      isWritable: meta.isWritable,
    })),
    cpiAccounts: summarizeIndexedMetas(M),
    treeAccounts: summarizeIndexedMetas(T),
    systemStart,
    packedStart,
    cpiSystemAccountCount,
  });

  console.info("[shield] address tree CPI alignment", {
    selectedAddressTree: addressTree.tree.toBase58(),
    selectedAddressQueue: addressTree.queue.toBase58(),
    selectedOutputStateTree: outputStateTree.tree.toBase58(),
    resolvedAddressTreeFromIndex: resolvedAddressTree.toBase58(),
    resolvedAddressQueueFromIndex: resolvedAddressQueue.toBase58(),
    resolvedOutputTreeFromIndex: resolvedOutputTree.toBase58(),
    addressTreeIndex: a,
    addressQueueIndex: q,
    outputTreeIndex: o,
    addressTreeMatchesResolved: resolvedAddressTree.equals(addressTree.tree),
    addressQueueMatchesResolved: resolvedAddressQueue.equals(addressTree.queue),
    outputTreeMatchesResolved: resolvedOutputTree.equals(outputStateTree.tree),
    addressTreeType: TreeType[addressTree.treeType] ?? String(addressTree.treeType),
    derivedAddressLegacyBase58: diagLegacyAddress.toBase58(),
    derivedAddressLegacyHex: bytesToHex(diagLegacyAddress.toBytes()),
    derivedAddressReservedBase58: diagReservedAddress.toBase58(),
    derivedAddressReservedHex: bytesToHex(diagReservedAddress.toBytes()),
    derivedAddressLightSystemBase58: diagLightSystemAddress.toBase58(),
    derivedAddressLightSystemHex: bytesToHex(diagLightSystemAddress.toBytes()),
    derivedAddressQueueReservedBase58: diagQueueReservedAddress.toBase58(),
    derivedAddressQueueReservedHex: bytesToHex(diagQueueReservedAddress.toBytes()),
  });

  console.info("[shield] Light proof config", {
    computeUnitLimit: SHIELD_COMPUTE_UNIT_LIMIT,
    amountRaw: amountRaw.toString(),
    amountCommitmentBytes: amountCommitment.length,
    nextAnchorHintBytes: nextAnchorHint.length,
    expectedPolicyCommitmentBytes: expectedPolicyCommitment.length,
    addressSeedBytes: addressSeed.length,
    compressedAddressBytes: derivedAddressRaw32.length,
    remainingAccounts: M.length,
    treeAccounts: T.length,
    outputTreeIndex: o,
    addressTreeIndex: a,
    addressQueueIndex: q,
    selectedRootIndex: r,
    selectedRootHex: proofEntry.rootHex,
    addressSeedHex: bytesToHex(addressSeedArg),
    compressedAddressHex: bytesToHex(compressedAddressArg),
    amountCommitmentHex: bytesToHex(amountCommitmentArg),
    nextAnchorHintHex: bytesToHex(nextAnchorHintArg),
    expectedPolicyCommitmentHex: bytesToHex(expectedPolicyCommitmentArg),
    proofShape: proofWrapped["0"]
      ? {
          a: proofWrapped["0"].a.length,
          b: proofWrapped["0"].b.length,
          c: proofWrapped["0"].c.length,
        }
      : null,
  });

  const shieldIx = await program.methods
    .shieldIntoCompressed(
      new BN(amountRaw.toString()),
      amountCommitmentArg,
      nextAnchorHintArg,
      expectedPolicyCommitmentArg,
      o,
      addressSeedArg,
      compressedAddressArg,
      a,
      P,
      proofWrapped,
    )
    .accounts({
      feePayer: spendAuthority,
      spendAuthority,
      userNoteHead,
      vaultConfig,
      auditorPolicy,
      vaultTokenAccount,
      vaultAuthority,
      lightPoolTokenAccount: lightPoolAta,
      mint,
      tokenProgram: TOKEN_PROGRAM_ID,
      auditorAttestor,
    })
    .remainingAccounts(M)
    .instruction();

  const tx = new Transaction();
  tx.add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: SHIELD_COMPUTE_UNIT_LIMIT }),
  );

  tx.add(
    createTransferInstruction(
      userAta,
      vaultTokenAccount,
      spendAuthority,
      amountRaw,
      [],
      TOKEN_PROGRAM_ID,
    ),
  );

  tx.add(shieldIx);

  return {
    transaction: tx,
    addressTree,
    outputStateTree,
    derivedAddressPk,
    noteDraft: {
      spendAuthority: canonicalSpendAuthority.toBase58(),
      owner: canonicalSpendAuthority.toBase58(),
      vaultConfig: vaultConfig.toBase58(),
      mint: mint.toBase58(),
      amountRaw: amountRaw.toString(),
      noteSequence: noteSeq.toString(),
      addressSeedHex: bytesToHex(addressSeed),
      compressedAddressHex: bytesToHex(derivedAddressRaw32),
      amountCommitmentHex: bytesToHex(amountCommitment),
      ovkBindingHex: headAcc.ovkBinding
        ? bytesToHex(new Uint8Array(Buffer.from(headAcc.ovkBinding as number[])))
        : null,
      blindingHex: null,
      addressTree: addressTree.tree.toBase58(),
      addressQueue: addressTree.queue.toBase58(),
      addressTreeType:
        addressTree.treeType === TreeType.AddressV1
          ? "AddressV1"
          : addressTree.treeType === TreeType.AddressV2
            ? "AddressV2"
            : "Unknown",
      outputStateTree: outputStateTree.tree.toBase58(),
      outputStateQueue: outputStateTree.queue.toBase58(),
    },
  };
}

export async function buildShieldZkTx(
  params: ShieldZkParams,
): Promise<Transaction> {
  const { transaction } = await buildShieldZkTxPayload(params);
  return transaction;
}
