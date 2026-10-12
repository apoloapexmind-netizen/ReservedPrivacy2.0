import { BN, type Idl, type Program } from "@coral-xyz/anchor";
import {
  PackedAccounts,
  SystemAccountMetaConfig,
  createBN254,
} from "@lightprotocol/stateless.js";
import type { Rpc } from "@lightprotocol/stateless.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey, Transaction } from "@solana/web3.js";

import type { StoredCompressedNoteV1 } from "./noteStore";
import { withLightRpcRetries } from "./utils/reconnection";

function hexToBytes(hex: string): Uint8Array {
  const trimmed = hex.trim().replace(/^0x/i, "").toLowerCase();
  if (trimmed.length % 2 !== 0 || /[^0-9a-f]/.test(trimmed)) {
    throw new Error(`Invalid hex string: ${hex}`);
  }
  const out = new Uint8Array(trimmed.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(trimmed.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
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
  return arr;
}

function validityProofForAnchor(proof: {
  a: number[];
  b: number[];
  c: number[];
} | null): { "0": { a: number[]; b: number[]; c: number[] } | null } {
  return { "0": proof };
}

function indexOfPubkey(
  metas: readonly { pubkey: PublicKey }[],
  key: PublicKey,
): number {
  const index = metas.findIndex((meta) => meta.pubkey.equals(key));
  if (index < 0 || index > 255) {
    throw new Error(`Packed account index out of range for ${key.toBase58()}`);
  }
  return index;
}

async function fetchBurnProof(
  connection: Parameters<typeof withLightRpcRetries<Rpc>>[0],
  note: StoredCompressedNoteV1,
) {
  return withLightRpcRetries(connection, async (rpc: Rpc) => {
    const address = createBN254(hexToBytes(note.compressedAddressHex));
    const account = await rpc.getCompressedAccount(address);
    if (!account) {
      throw new Error(
        `Compressed note ${note.compressedAddressHex} is no longer indexed as active on Light RPC.`,
      );
    }
    const proofCtx = await rpc.getValidityProofV2([account], []);
    const compressed = proofCtx.compressedProof;
    if (!compressed) {
      throw new Error("Light RPC returned no compressed proof for the selected note.");
    }
    if (compressed.a.length !== 32 || compressed.b.length !== 64 || compressed.c.length !== 32) {
      throw new Error("Light validity proof has an invalid shape for unshield.");
    }
    const rootIndex = proofCtx.rootIndices?.[0];
    if (rootIndex == null) {
      throw new Error("Light validity proof did not include a root index for the selected note.");
    }
    return { account, compressed, rootIndex };
  });
}

export type UnshieldZkParams = {
  connection: Parameters<typeof withLightRpcRetries<Rpc>>[0];
  program: Program<Idl>;
  programId: PublicKey;
  feePayer: PublicKey;
  spendAuthority: PublicKey;
  vaultConfig: PublicKey;
  auditorPolicy: PublicKey;
  expectedPolicyCommitment: Uint8Array;
  auditorAttestor: PublicKey;
  mint: PublicKey;
  lightPoolTokenAccount: PublicKey;
  lightPoolCustody: PublicKey;
  recipientTokenAccount: PublicKey;
  note: StoredCompressedNoteV1;
};

export async function buildUnshieldZkTx(
  params: UnshieldZkParams,
): Promise<Transaction> {
  const {
    connection,
    program,
    programId,
    feePayer,
    spendAuthority,
    vaultConfig,
    auditorPolicy,
    expectedPolicyCommitment,
    auditorAttestor,
    mint,
    lightPoolTokenAccount,
    lightPoolCustody,
    recipientTokenAccount,
    note,
  } = params;

  const { account, compressed, rootIndex } = await fetchBurnProof(connection, note);

  const packedAccts = PackedAccounts.newWithSystemAccounts(
    SystemAccountMetaConfig.new(programId),
  );
  packedAccts.insertOrGetConfig(account.treeInfo.tree, false, true);
  packedAccts.insertOrGetConfig(account.treeInfo.queue, false, true);

  const { remainingAccounts, systemStart, packedStart } = packedAccts.toAccountMetas();
  const cpiSystemAccounts = remainingAccounts.slice(systemStart, packedStart).map((meta) => ({
    pubkey: meta.pubkey,
    isSigner: false,
    isWritable: meta.isWritable,
  }));
  const treeAccounts = remainingAccounts.slice(packedStart).map((meta) => ({
    pubkey: meta.pubkey,
    isSigner: false,
    isWritable: meta.isWritable,
  }));
  const treeIndex = indexOfPubkey(treeAccounts, account.treeInfo.tree);
  const queueIndex = account.treeInfo.tree.equals(account.treeInfo.queue)
    ? treeIndex
    : indexOfPubkey(treeAccounts, account.treeInfo.queue);
  const lightRemainingAccounts = [...cpiSystemAccounts, ...treeAccounts];

  const amountRaw = BigInt(note.amountRaw);
  const ovkBindingHex = note.ovkBindingHex?.trim();
  if (!ovkBindingHex) {
    throw new Error("Selected note is missing ovkBindingHex in local storage.");
  }

  const ix = await program.methods
    .unshieldZk(
      new BN(amountRaw.toString()),
      toFixedNumberArray("expectedPolicyCommitment", expectedPolicyCommitment, 32),
      {
        treeInfo: {
          rootIndex: rootIndex & 0xffff,
          proveByIndex: account.proveByIndex,
          merkleTreePubkeyIndex: treeIndex,
          queuePubkeyIndex: queueIndex,
          leafIndex: account.leafIndex,
        },
        address: toFixedNumberArray("address", hexToBytes(note.compressedAddressHex), 32),
      },
      {
        owner: new PublicKey(note.owner),
        amountCommitment: toFixedNumberArray(
          "amountCommitment",
          hexToBytes(note.amountCommitmentHex),
          32,
        ),
        noteSequence: new BN(note.noteSequence),
        ovkBinding: toFixedNumberArray("ovkBinding", hexToBytes(ovkBindingHex), 32),
      },
      validityProofForAnchor(compressed),
    )
    .accounts({
      feePayer,
      spendAuthority,
      vaultConfig,
      auditorPolicy,
      lightPoolTokenAccount,
      lightPoolCustody,
      recipientTokenAccount,
      mint,
      tokenProgram: TOKEN_PROGRAM_ID,
      auditorAttestor,
    })
    .remainingAccounts(lightRemainingAccounts)
    .instruction();

  const tx = new Transaction();
  tx.add(ix);
  return tx;
}

export async function sendUnshieldZkTx(
  params: UnshieldZkParams,
  signSend: (tx: Transaction) => Promise<string>,
): Promise<string> {
  const tx = await buildUnshieldZkTx(params);
  return signSend(tx);
}
