import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import * as anchor from "@coral-xyz/anchor";
import BN from "bn.js";
import { PublicKey } from "@solana/web3.js";

const DEFAULT_PROGRAM_ID = "BA5QxMGYW132ELKZ58jJ7hDjKNHSPB52hfmuwiYGDNYR";
const DEFAULT_USDC_DEVNET_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const DEFAULT_RPC_URL = "https://api.devnet.solana.com";
const SEED_VAULT = Buffer.from("vault_cfg");
const SEED_AUDIT = Buffer.from("audit_pol");

function readEnvFile(filePath) {
  const out = new Map();
  if (!fs.existsSync(filePath)) return out;
  const raw = fs.readFileSync(filePath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out.set(key, value);
  }
  return out;
}

function envValue(fileEnv, ...keys) {
  for (const key of keys) {
    const fromProcess = process.env[key]?.trim();
    if (fromProcess) return fromProcess;
    const fromFile = fileEnv.get(key)?.trim();
    if (fromFile) return fromFile;
  }
  return undefined;
}

function loadKeypair(filePath) {
  const secret = JSON.parse(fs.readFileSync(filePath, "utf8"));
  return anchor.web3.Keypair.fromSecretKey(Uint8Array.from(secret));
}

function deriveVaultConfig(programId, mint) {
  return PublicKey.findProgramAddressSync([SEED_VAULT, mint.toBuffer()], programId)[0];
}

function deriveAuditorPolicy(programId, vaultConfig) {
  return PublicKey.findProgramAddressSync([SEED_AUDIT, vaultConfig.toBuffer()], programId)[0];
}

async function main() {
  const root = process.cwd();
  const appEnv = readEnvFile(path.join(root, "app", ".env"));

  const rpcUrl =
    envValue(appEnv, "RPC_URL", "SOLANA_RPC_URL", "VITE_SOLANA_RPC_URL", "VITE_RPC_URL") ??
    DEFAULT_RPC_URL;
  const programId = new PublicKey(
    envValue(appEnv, "PROGRAM_ID", "VITE_RESERVED_PROGRAM_ID") ?? DEFAULT_PROGRAM_ID,
  );
  const mint = new PublicKey(
    envValue(appEnv, "USDC_MINT", "VITE_USDC_MINT") ?? DEFAULT_USDC_DEVNET_MINT,
  );
  const walletPath =
    envValue(appEnv, "ANCHOR_WALLET", "SOLANA_KEYPAIR", "PAYER_KEYPAIR") ??
    path.join(homedir(), ".config", "solana", "id.json");

  const payer = loadKeypair(walletPath);
  const wallet = new anchor.Wallet(payer);
  const connection = new anchor.web3.Connection(rpcUrl, "confirmed");
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  anchor.setProvider(provider);

  const idlPath = path.join(root, "app", "src", "idl", "reserved.json");
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf8"));
  const program = new anchor.Program(idl, provider);

  const vaultConfig = deriveVaultConfig(program.programId, mint);
  const auditorPolicy = deriveAuditorPolicy(program.programId, vaultConfig);
  const zeroPolicy = Array(32).fill(0);
  const unixTs = new BN(Math.floor(Date.now() / 1000));

  const before = await program.account.auditorPolicy.fetchNullable(auditorPolicy);
  const vault = await program.account.vaultConfig.fetch(vaultConfig);
  const requiredAuthority = vault.authority.toBase58();

  if (!vault.authority.equals(wallet.publicKey)) {
    throw new Error(
      `Local wallet ${wallet.publicKey.toBase58()} is not the vault authority. ` +
        `Vault ${vaultConfig.toBase58()} requires ${requiredAuthority} to sign the sovereign policy upsert.`,
    );
  }

  const signature = await program.methods
    .upsertAuditorPolicy(PublicKey.default, zeroPolicy, unixTs)
    .accounts({
      authority: wallet.publicKey,
      vaultConfig,
      auditorPolicy,
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .rpc();

  const after = await program.account.auditorPolicy.fetch(auditorPolicy);

  console.log(
    JSON.stringify(
      {
        ok: true,
        rpcUrl,
        programId: program.programId.toBase58(),
        mint: mint.toBase58(),
        authority: wallet.publicKey.toBase58(),
        vaultConfig: vaultConfig.toBase58(),
        auditorPolicy: auditorPolicy.toBase58(),
        before: before
          ? {
              authority: before.authority.toBase58(),
              auditorPubkey: before.auditorPubkey.toBase58(),
              policyCommitmentHex: Buffer.from(before.policyCommitment).toString("hex"),
              lastRotationTs: before.lastRotationTs.toString(),
            }
          : null,
        signature,
        after: {
          authority: after.authority.toBase58(),
          auditorPubkey: after.auditorPubkey.toBase58(),
          policyCommitmentHex: Buffer.from(after.policyCommitment).toString("hex"),
          lastRotationTs: after.lastRotationTs.toString(),
        },
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(JSON.stringify({ ok: false, error: message }, null, 2));
  process.exit(1);
});
