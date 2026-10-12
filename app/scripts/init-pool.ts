import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";

const DEFAULT_PROGRAM_ID = "BA5QxMGYW132ELKZ58jJ7hDjKNHSPB52hfmuwiYGDNYR";
const DEFAULT_USDC_DEVNET_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const DEFAULT_RPC_URL = "https://api.devnet.solana.com";
const SEED_LIGHT_POOL_CUSTODY = new TextEncoder().encode("light_pool_custody");

function readEnvFile(filePath: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(filePath)) return out;
  const raw = readFileSync(filePath, "utf8");
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

function envValue(fileEnv: Map<string, string>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const fromProcess = process.env[key]?.trim();
    if (fromProcess) return fromProcess;
    const fromFile = fileEnv.get(key)?.trim();
    if (fromFile) return fromFile;
  }
  return undefined;
}

function loadKeypair(filePath: string): Keypair {
  const secret = JSON.parse(readFileSync(filePath, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

function mintToSeedBytes(mint: PublicKey): Uint8Array {
  return new Uint8Array(mint.toBytes());
}

function deriveLightPoolCustodyAta(
  programId: PublicKey,
  depositMint: PublicKey,
): { poolAuthority: PublicKey; poolAta: PublicKey } {
  const [poolAuthority] = PublicKey.findProgramAddressSync(
    [SEED_LIGHT_POOL_CUSTODY, mintToSeedBytes(depositMint)],
    programId,
  );
  const poolAta = getAssociatedTokenAddressSync(
    depositMint,
    poolAuthority,
    true,
    TOKEN_PROGRAM_ID,
  );
  return { poolAuthority, poolAta };
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
  const connection = new Connection(rpcUrl, "confirmed");

  const { poolAuthority, poolAta } = deriveLightPoolCustodyAta(programId, mint);

  const existing = await connection.getAccountInfo(poolAta, "confirmed");
  if (existing) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          status: "already_exists",
          rpcUrl,
          programId: programId.toBase58(),
          mint: mint.toBase58(),
          poolAuthority: poolAuthority.toBase58(),
          poolAta: poolAta.toBase58(),
        },
        null,
        2,
      ),
    );
    return;
  }

  const ix = createAssociatedTokenAccountIdempotentInstruction(
    payer.publicKey,
    poolAta,
    poolAuthority,
    mint,
    TOKEN_PROGRAM_ID,
  );
  const tx = new Transaction().add(ix);
  const sig = await sendAndConfirmTransaction(connection, tx, [payer], {
    commitment: "confirmed",
  });

  console.log(
    JSON.stringify(
      {
        ok: true,
        status: "created",
        signature: sig,
        rpcUrl,
        programId: programId.toBase58(),
        mint: mint.toBase58(),
        poolAuthority: poolAuthority.toBase58(),
        poolAta: poolAta.toBase58(),
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
