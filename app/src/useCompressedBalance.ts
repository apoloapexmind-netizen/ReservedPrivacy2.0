import { createBN254 } from "@lightprotocol/stateless.js";
import type { Connection, PublicKey } from "@solana/web3.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  type StoredCompressedNoteV1,
  listCompressedNotes,
  patchCompressedNote,
  subscribeCompressedNotes,
} from "./noteStore";
import { withLightRpcRetries } from "./utils/reconnection";

type BnLike = {
  toArrayLike: (
    ctor: Uint8ArrayConstructor,
    endian: "be" | "le",
    length: number,
  ) => Uint8Array;
};

export type UseCompressedBalanceResult = {
  notes: StoredCompressedNoteV1[];
  spendableNotes: StoredCompressedNoteV1[];
  totalRaw: bigint;
  totalUi: string;
  pendingRaw: bigint;
  pendingUi: string;
  activeNoteCount: number;
  pendingNoteCount: number;
  loading: boolean;
  error: string | null;
  lastSyncedAt: string | null;
  refresh: () => Promise<void>;
};

type UseCompressedBalanceParams = {
  connection: Connection;
  spendAuthority: PublicKey | null;
  mint: PublicKey | null;
  programId: PublicKey;
  enabled?: boolean;
};

function hexToBytes(hex: string): Uint8Array {
  const trimmed = hex.trim().replace(/^0x/i, "").toLowerCase();
  if (trimmed.length % 2 !== 0 || /[^0-9a-f]/.test(trimmed)) {
    throw new Error(`Invalid hex: ${hex}`);
  }
  const out = new Uint8Array(trimmed.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(trimmed.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bnLikeToHex(value: BnLike | null | undefined): string | null {
  if (!value) {
    return null;
  }
  return bytesToHex(value.toArrayLike(Uint8Array, "be", 32));
}

function formatRawAmount(raw: bigint, decimals: number): string {
  const neg = raw < 0n;
  const abs = neg ? -raw : raw;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const fraction = abs % base;
  if (fraction === 0n) {
    return `${neg ? "-" : ""}${whole.toString()}`;
  }
  const paddedFraction = fraction
    .toString()
    .padStart(decimals, "0")
    .replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole.toString()}.${paddedFraction}`;
}

function sumAmounts(notes: readonly StoredCompressedNoteV1[]): bigint {
  return notes.reduce((acc, note) => acc + BigInt(note.amountRaw), 0n);
}

async function loadLocalNotes(
  spendAuthority: PublicKey,
  mint: PublicKey,
  programId: PublicKey,
): Promise<StoredCompressedNoteV1[]> {
  return listCompressedNotes({
    spendAuthority: spendAuthority.toBase58(),
    mint: mint.toBase58(),
    programId: programId.toBase58(),
  });
}

export function useCompressedBalance({
  connection,
  spendAuthority,
  mint,
  programId,
  enabled = true,
}: UseCompressedBalanceParams): UseCompressedBalanceResult {
  const [notes, setNotes] = useState<StoredCompressedNoteV1[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const suppressStoreRefreshRef = useRef(false);

  const refresh = useCallback(async () => {
    if (!enabled || !spendAuthority || !mint) {
      setNotes([]);
      setError(null);
      setLastSyncedAt(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const localNotes = await loadLocalNotes(spendAuthority, mint, programId);
      if (localNotes.length === 0) {
        setNotes([]);
        setLastSyncedAt(new Date().toISOString());
        return;
      }
      suppressStoreRefreshRef.current = true;
      const reconciled = await withLightRpcRetries(connection, async (rpc) => {
        return Promise.all(
          localNotes.map(async (note) => {
            if (note.status === "spent" || note.status === "orphaned") {
              return note;
            }
            const address = createBN254(hexToBytes(note.compressedAddressHex));
            const account = await rpc.getCompressedAccount(address).catch(() => null);
            if (!account) {
              return note;
            }
            const proof = await rpc.getCompressedAccountProof(account.hash).catch(() => null);
            const nextStatus = note.status === "pending_index" ? "active" : note.status;
            const next = await patchCompressedNote(note.noteId, {
              status: nextStatus,
              leafHashHex: bnLikeToHex(account.hash as unknown as BnLike),
              dataHashHex: account.data?.dataHash
                ? bytesToHex(Uint8Array.from(account.data.dataHash))
                : note.dataHashHex ?? null,
              leafIndex: account.leafIndex,
              proveByIndex: account.proveByIndex,
              rootIndex: proof?.rootIndex ?? note.rootIndex ?? null,
              rootHex: bnLikeToHex((proof?.root ?? null) as unknown as BnLike),
              lastIndexedAt: new Date().toISOString(),
            });
            return next ?? note;
          }),
        );
      });
      setNotes(reconciled);
      setLastSyncedAt(new Date().toISOString());
    } catch (e) {
      const localNotes =
        spendAuthority && mint
          ? await loadLocalNotes(spendAuthority, mint, programId).catch(() => [])
          : [];
      setNotes(localNotes);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      suppressStoreRefreshRef.current = false;
      setLoading(false);
    }
  }, [connection, enabled, mint, programId, spendAuthority]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    return subscribeCompressedNotes(() => {
      if (suppressStoreRefreshRef.current) {
        return;
      }
      void refresh();
    });
  }, [refresh]);

  const spendableNotes = useMemo(
    () => notes.filter((note) => note.status === "active"),
    [notes],
  );
  const pendingNotes = useMemo(
    () => notes.filter((note) => note.status === "pending_index"),
    [notes],
  );
  const decimals = notes[0]?.decimals ?? 0;
  const totalRaw = useMemo(() => sumAmounts(spendableNotes), [spendableNotes]);
  const pendingRaw = useMemo(() => sumAmounts(pendingNotes), [pendingNotes]);

  return {
    notes,
    spendableNotes,
    totalRaw,
    totalUi: formatRawAmount(totalRaw, decimals),
    pendingRaw,
    pendingUi: formatRawAmount(pendingRaw, decimals),
    activeNoteCount: spendableNotes.length,
    pendingNoteCount: pendingNotes.length,
    loading,
    error,
    lastSyncedAt,
    refresh,
  };
}
