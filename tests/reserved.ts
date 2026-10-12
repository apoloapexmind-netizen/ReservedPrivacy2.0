/**
 * Smoke: `initialize_vault` round-trip against local-validator + deployed program (`anchor test`).
 */
import * as anchor from "@coral-xyz/anchor";
import type { Idl } from "@coral-xyz/anchor";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createMint,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { Keypair, PublicKey } from "@solana/web3.js";
import fs from "fs";
import path from "path";
import { assert } from "chai";

describe("reserved", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const idlJson = fs.readFileSync(
    path.join(__dirname, "../target/idl/reserved.json"),
    "utf8",
  );
  const idl = JSON.parse(idlJson) as Idl;
  const program = new anchor.Program(idl, provider);

  const wallet = provider.wallet as anchor.Wallet;

  it("initialize_vault", async () => {
    // `deposit_mint` es `Account<Mint>` no-init: el mint debe existir antes (aquí createMint).
    const mint = await createMint(
      provider.connection,
      wallet.payer as anchor.web3.Signer,
      wallet.publicKey,
      wallet.publicKey,
      9,
    );
    const mintInfo = await provider.connection.getAccountInfo(mint);
    if (!mintInfo) {
      throw new Error("createMint failed: mint account not initialized");
    }

    const chainIdHash: number[] = Array(32).fill(11);
    const lightStateTree = Keypair.generate().publicKey;

    const [vaultConfig] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault_cfg"), mint.toBuffer()],
      program.programId,
    );
    const [vaultAuthority] = PublicKey.findProgramAddressSync(
      [Buffer.from("pub_escrow"), mint.toBuffer()],
      program.programId,
    );
    const vaultTokenAccount = getAssociatedTokenAddressSync(
      mint,
      vaultAuthority,
      true,
      TOKEN_PROGRAM_ID,
    );

    const txSig = await program.methods
      .initializeVault(chainIdHash, lightStateTree)
      .accounts({
        payer: wallet.publicKey,
        authority: wallet.publicKey,
        vaultConfig,
        depositMint: mint,
        vaultAuthority,
        vaultTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    assert(txSig.length > 20);
    const vaultConfigAcct = (
      program.account as unknown as {
        vaultConfig: { fetch: (k: PublicKey) => Promise<{ depositMint: PublicKey }> };
      }
    ).vaultConfig;
    const fetched = await vaultConfigAcct.fetch(vaultConfig);
    assert.strictEqual(String(fetched.depositMint), String(mint));
  });
});
