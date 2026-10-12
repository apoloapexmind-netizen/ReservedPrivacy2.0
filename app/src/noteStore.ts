export const NOTE_STORE_CHANGED_EVENT = "reserved:compressed-notes-changed";

const DB_NAME = "reserved_vault_db";
const DB_VERSION = 2;
const NOTES_STORE = "notes";
const VOUCHER_KIND = "reserved-compressed-note-v1";
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE58_MAP = new Map(BASE58_ALPHABET.split("").map((char, index) => [char, index]));

export type StoredNoteStatus =
  | "pending_index"
  | "active"
  | "spending"
  | "spent"
  | "orphaned";

export type StoredAddressTreeType = "AddressV1" | "AddressV2" | "Unknown";

export type StoredCompressedNoteV1 = {
  schemaVersion: 1;
  noteId: string;
  cluster: "devnet" | "mainnet-beta" | "localnet";
  programId: string;
  spendAuthority: string;
  owner: string;
  vaultConfig: string;
  mint: string;
  decimals: number;
  amountRaw: string;
  noteSequence: string;
  addressSeedHex: string;
  compressedAddressHex: string;
  amountCommitmentHex: string;
  blindingHex?: string | null;
  ovkBindingHex?: string | null;
  addressTree: string;
  addressQueue: string;
  addressTreeType: StoredAddressTreeType;
  outputStateTree: string;
  outputStateQueue: string;
  shieldTxSig: string;
  shieldSlot?: number | null;
  createdAt: string;
  updatedAt: string;
  leafHashHex?: string | null;
  dataHashHex?: string | null;
  rootIndex?: number | null;
  rootHex?: string | null;
  leafIndex?: number | null;
  proveByIndex?: boolean | null;
  status: StoredNoteStatus;
  spendTxSig?: string | null;
  spentAt?: string | null;
  recipientTokenAccount?: string | null;
  nullifierHex?: string | null;
  lastIndexedAt?: string | null;
};

export type PendingCompressedNoteInput = {
  cluster: StoredCompressedNoteV1["cluster"];
  programId: string;
  spendAuthority: string;
  owner?: string;
  vaultConfig: string;
  mint: string;
  decimals: number;
  amountRaw: string;
  noteSequence: string;
  addressSeedHex: string;
  compressedAddressHex: string;
  amountCommitmentHex: string;
  blindingHex?: string | null;
  ovkBindingHex?: string | null;
  addressTree: string;
  addressQueue: string;
  addressTreeType: StoredAddressTreeType;
  outputStateTree: string;
  outputStateQueue: string;
  shieldTxSig: string;
  shieldSlot?: number | null;
};

export type ExportedCompressedVoucherV1 = {
  schemaVersion: 1;
  kind: typeof VOUCHER_KIND;
  note: Omit<
    StoredCompressedNoteV1,
    | "noteId"
    | "spendAuthority"
    | "status"
    | "spendTxSig"
    | "spentAt"
    | "recipientTokenAccount"
    | "createdAt"
    | "updatedAt"
    | "lastIndexedAt"
  >;
};

export type CompressedNoteQuery = {
  spendAuthority?: string;
  mint?: string;
  programId?: string;
  statuses?: StoredNoteStatus[];
};

let dbPromise: Promise<IDBDatabase> | null = null;

function hasIndexedDb(): boolean {
  return typeof indexedDB !== "undefined";
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeHex32(hex: string): string {
  const trimmed = hex.trim().replace(/^0x/i, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(trimmed)) {
    throw new Error(`Expected 32-byte hex string, got "${hex}"`);
  }
  return trimmed;
}

function base58Encode(bytes: Uint8Array): string {
  if (bytes.length === 0) {
    return "";
  }
  let value = 0n;
  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte);
  }
  let encoded = "";
  while (value > 0n) {
    const mod = Number(value % 58n);
    encoded = BASE58_ALPHABET[mod] + encoded;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    encoded = `1${encoded}`;
  }
  return encoded || "1";
}

function base58Decode(value: string): Uint8Array {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("Voucher is empty.");
  }
  let decoded = 0n;
  for (const char of trimmed) {
    const digit = BASE58_MAP.get(char);
    if (digit == null) {
      throw new Error(`Voucher contains invalid Base58 character "${char}".`);
    }
    decoded = decoded * 58n + BigInt(digit);
  }
  const out: number[] = [];
  while (decoded > 0n) {
    out.push(Number(decoded % 256n));
    decoded /= 256n;
  }
  out.reverse();
  let leadingZeroes = 0;
  for (const char of trimmed) {
    if (char !== "1") break;
    leadingZeroes += 1;
  }
  return Uint8Array.from([
    ...new Array(leadingZeroes).fill(0),
    ...out,
  ]);
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

function createNotesObjectStore(db: IDBDatabase, tx: IDBTransaction): void {
  const store = db.objectStoreNames.contains(NOTES_STORE)
    ? tx.objectStore(NOTES_STORE)
    : db.createObjectStore(NOTES_STORE, { keyPath: "noteId" });
  if (!store.indexNames.contains("bySpendAuthority")) {
    store.createIndex("bySpendAuthority", "spendAuthority", { unique: false });
  }
  if (!store.indexNames.contains("byCompressedAddress")) {
    store.createIndex("byCompressedAddress", "compressedAddressHex", { unique: true });
  }
  if (!store.indexNames.contains("byShieldTxSig")) {
    store.createIndex("byShieldTxSig", "shieldTxSig", { unique: false });
  }
  if (!store.indexNames.contains("byProgramMintStatus")) {
    store.createIndex("byProgramMintStatus", ["programId", "mint", "status"], { unique: false });
  }
  if (!store.indexNames.contains("byWalletMintStatus")) {
    store.createIndex("byWalletMintStatus", ["spendAuthority", "mint", "status"], { unique: false });
  }
}

function openDb(version?: number): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = version == null ? indexedDB.open(DB_NAME) : indexedDB.open(DB_NAME, version);
    request.onupgradeneeded = () => {
      createNotesObjectStore(request.result, request.transaction!);
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    request.onerror = () => reject(request.error ?? new Error("Unable to open IndexedDB"));
    request.onblocked = () => reject(new Error("IndexedDB open blocked by another tab"));
  });
}

async function openNotesDb(): Promise<IDBDatabase> {
  if (!hasIndexedDb()) {
    throw new Error("IndexedDB is not available in this browser context.");
  }
  if (dbPromise) {
    return dbPromise;
  }
  dbPromise = (async () => {
    let db = await openDb(DB_VERSION);
    if (!db.objectStoreNames.contains(NOTES_STORE)) {
      const nextVersion = db.version + 1;
      db.close();
      db = await openDb(nextVersion);
    }
    if (!db.objectStoreNames.contains(NOTES_STORE)) {
      throw new Error(`IndexedDB store "${NOTES_STORE}" is missing after initialization.`);
    }
    return db;
  })();
  try {
    return await dbPromise;
  } catch (error) {
    dbPromise = null;
    throw error;
  }
}

export async function initNoteStore(): Promise<void> {
  await openNotesDb();
}

function emitNotesChanged(): void {
  if (typeof window === "undefined") {
    return;
  }
  window.dispatchEvent(new CustomEvent(NOTE_STORE_CHANGED_EVENT));
}

export function subscribeCompressedNotes(onChange: () => void): () => void {
  if (typeof window === "undefined") {
    return () => {};
  }
  const listener = () => onChange();
  window.addEventListener(NOTE_STORE_CHANGED_EVENT, listener);
  return () => window.removeEventListener(NOTE_STORE_CHANGED_EVENT, listener);
}

export function inferClusterFromEndpoint(endpoint: string): StoredCompressedNoteV1["cluster"] {
  const normalized = endpoint.trim().toLowerCase();
  if (normalized.includes("mainnet")) {
    return "mainnet-beta";
  }
  if (normalized.includes("devnet")) {
    return "devnet";
  }
  return "localnet";
}

export function buildCompressedNoteId(args: {
  cluster: StoredCompressedNoteV1["cluster"];
  programId: string;
  compressedAddressHex: string;
}): string {
  return `${args.cluster}:${args.programId}:${normalizeHex32(args.compressedAddressHex)}`;
}

export function createPendingCompressedNote(
  input: PendingCompressedNoteInput,
): StoredCompressedNoteV1 {
  const timestamp = nowIso();
  const compressedAddressHex = normalizeHex32(input.compressedAddressHex);
  return {
    schemaVersion: 1,
    noteId: buildCompressedNoteId({
      cluster: input.cluster,
      programId: input.programId,
      compressedAddressHex,
    }),
    cluster: input.cluster,
    programId: input.programId,
    spendAuthority: input.spendAuthority,
    owner: input.owner ?? input.spendAuthority,
    vaultConfig: input.vaultConfig,
    mint: input.mint,
    decimals: input.decimals,
    amountRaw: input.amountRaw,
    noteSequence: input.noteSequence,
    addressSeedHex: normalizeHex32(input.addressSeedHex),
    compressedAddressHex,
    amountCommitmentHex: normalizeHex32(input.amountCommitmentHex),
    blindingHex: input.blindingHex ?? null,
    ovkBindingHex: input.ovkBindingHex ?? null,
    addressTree: input.addressTree,
    addressQueue: input.addressQueue,
    addressTreeType: input.addressTreeType,
    outputStateTree: input.outputStateTree,
    outputStateQueue: input.outputStateQueue,
    shieldTxSig: input.shieldTxSig,
    shieldSlot: input.shieldSlot ?? null,
    createdAt: timestamp,
    updatedAt: timestamp,
    leafHashHex: null,
    dataHashHex: null,
    rootIndex: null,
    rootHex: null,
    leafIndex: null,
    proveByIndex: null,
    status: "pending_index",
    spendTxSig: null,
    spentAt: null,
    recipientTokenAccount: null,
    nullifierHex: null,
    lastIndexedAt: null,
  };
}

export function exportCompressedNoteVoucher(note: StoredCompressedNoteV1): string {
  const voucher: ExportedCompressedVoucherV1 = {
    schemaVersion: 1,
    kind: VOUCHER_KIND,
    note: {
      schemaVersion: 1,
      cluster: note.cluster,
      programId: note.programId,
      owner: note.owner,
      vaultConfig: note.vaultConfig,
      mint: note.mint,
      decimals: note.decimals,
      amountRaw: note.amountRaw,
      noteSequence: note.noteSequence,
      addressSeedHex: note.addressSeedHex,
      compressedAddressHex: note.compressedAddressHex,
      amountCommitmentHex: note.amountCommitmentHex,
      blindingHex: note.blindingHex ?? null,
      ovkBindingHex: note.ovkBindingHex ?? null,
      addressTree: note.addressTree,
      addressQueue: note.addressQueue,
      addressTreeType: note.addressTreeType,
      outputStateTree: note.outputStateTree,
      outputStateQueue: note.outputStateQueue,
      shieldTxSig: note.shieldTxSig,
      shieldSlot: note.shieldSlot ?? null,
      leafHashHex: note.leafHashHex ?? null,
      dataHashHex: note.dataHashHex ?? null,
      rootIndex: note.rootIndex ?? null,
      rootHex: note.rootHex ?? null,
      leafIndex: note.leafIndex ?? null,
      proveByIndex: note.proveByIndex ?? null,
      nullifierHex: note.nullifierHex ?? null,
    },
  };
  return base58Encode(new TextEncoder().encode(JSON.stringify(voucher)));
}

export function importCompressedNoteVoucher(
  voucherCode: string,
  localSpendAuthority: string,
): StoredCompressedNoteV1 {
  const decoded = new TextDecoder().decode(base58Decode(voucherCode));
  let parsed: ExportedCompressedVoucherV1;
  try {
    parsed = JSON.parse(decoded) as ExportedCompressedVoucherV1;
  } catch {
    throw new Error("Voucher payload is not valid JSON.");
  }
  if (parsed.kind !== VOUCHER_KIND || parsed.schemaVersion !== 1) {
    throw new Error("Voucher schema is not supported by this client.");
  }
  const note = parsed.note;
  const timestamp = nowIso();
  return {
    schemaVersion: 1,
    noteId: buildCompressedNoteId({
      cluster: note.cluster,
      programId: note.programId,
      compressedAddressHex: note.compressedAddressHex,
    }),
    cluster: note.cluster,
    programId: note.programId,
    spendAuthority: localSpendAuthority,
    owner: note.owner,
    vaultConfig: note.vaultConfig,
    mint: note.mint,
    decimals: note.decimals,
    amountRaw: note.amountRaw,
    noteSequence: note.noteSequence,
    addressSeedHex: normalizeHex32(note.addressSeedHex),
    compressedAddressHex: normalizeHex32(note.compressedAddressHex),
    amountCommitmentHex: normalizeHex32(note.amountCommitmentHex),
    blindingHex: note.blindingHex ?? null,
    ovkBindingHex: note.ovkBindingHex ?? null,
    addressTree: note.addressTree,
    addressQueue: note.addressQueue,
    addressTreeType: note.addressTreeType,
    outputStateTree: note.outputStateTree,
    outputStateQueue: note.outputStateQueue,
    shieldTxSig: note.shieldTxSig,
    shieldSlot: note.shieldSlot ?? null,
    createdAt: timestamp,
    updatedAt: timestamp,
    leafHashHex: note.leafHashHex ?? null,
    dataHashHex: note.dataHashHex ?? null,
    rootIndex: note.rootIndex ?? null,
    rootHex: note.rootHex ?? null,
    leafIndex: note.leafIndex ?? null,
    proveByIndex: note.proveByIndex ?? null,
    status:
      note.leafHashHex || note.leafIndex != null || note.rootIndex != null
        ? "active"
        : "pending_index",
    spendTxSig: null,
    spentAt: null,
    recipientTokenAccount: null,
    nullifierHex: note.nullifierHex ?? null,
    lastIndexedAt: timestamp,
  };
}

function sortNewestFirst(notes: StoredCompressedNoteV1[]): StoredCompressedNoteV1[] {
  return [...notes].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function matchesQuery(note: StoredCompressedNoteV1, query: CompressedNoteQuery): boolean {
  if (query.spendAuthority && note.spendAuthority !== query.spendAuthority) {
    return false;
  }
  if (query.mint && note.mint !== query.mint) {
    return false;
  }
  if (query.programId && note.programId !== query.programId) {
    return false;
  }
  if (query.statuses && !query.statuses.includes(note.status)) {
    return false;
  }
  return true;
}

export async function putCompressedNote(note: StoredCompressedNoteV1): Promise<void> {
  const db = await openNotesDb();
  const tx = db.transaction(NOTES_STORE, "readwrite");
  tx.objectStore(NOTES_STORE).put({
    ...note,
    compressedAddressHex: normalizeHex32(note.compressedAddressHex),
    addressSeedHex: normalizeHex32(note.addressSeedHex),
    amountCommitmentHex: normalizeHex32(note.amountCommitmentHex),
    updatedAt: nowIso(),
  } satisfies StoredCompressedNoteV1);
  await transactionDone(tx);
  emitNotesChanged();
}

export async function getCompressedNoteById(
  noteId: string,
): Promise<StoredCompressedNoteV1 | null> {
  const db = await openNotesDb();
  const tx = db.transaction(NOTES_STORE, "readonly");
  const note = await requestToPromise<StoredCompressedNoteV1 | undefined>(
    tx.objectStore(NOTES_STORE).get(noteId),
  );
  await transactionDone(tx);
  return note ?? null;
}

export async function getCompressedNoteByAddressHex(
  compressedAddressHex: string,
): Promise<StoredCompressedNoteV1 | null> {
  const db = await openNotesDb();
  const tx = db.transaction(NOTES_STORE, "readonly");
  const index = tx.objectStore(NOTES_STORE).index("byCompressedAddress");
  const note = await requestToPromise<StoredCompressedNoteV1 | undefined>(
    index.get(normalizeHex32(compressedAddressHex)),
  );
  await transactionDone(tx);
  return note ?? null;
}

export async function listCompressedNotes(
  query: CompressedNoteQuery = {},
): Promise<StoredCompressedNoteV1[]> {
  const db = await openNotesDb();
  const tx = db.transaction(NOTES_STORE, "readonly");
  const notes = await requestToPromise<StoredCompressedNoteV1[]>(
    tx.objectStore(NOTES_STORE).getAll(),
  );
  await transactionDone(tx);
  return sortNewestFirst(notes.filter((note) => matchesQuery(note, query)));
}

export async function patchCompressedNote(
  noteId: string,
  patch: Partial<StoredCompressedNoteV1>,
): Promise<StoredCompressedNoteV1 | null> {
  const existing = await getCompressedNoteById(noteId);
  if (!existing) {
    return null;
  }
  const next: StoredCompressedNoteV1 = {
    ...existing,
    ...patch,
    noteId: existing.noteId,
    schemaVersion: 1,
    updatedAt: nowIso(),
  };
  await putCompressedNote(next);
  return next;
}

export async function removeCompressedNote(noteId: string): Promise<void> {
  const db = await openNotesDb();
  const tx = db.transaction(NOTES_STORE, "readwrite");
  tx.objectStore(NOTES_STORE).delete(noteId);
  await transactionDone(tx);
  emitNotesChanged();
}
