#!/usr/bin/env node
/**
 * Verifies instruction discriminators in target/idl/reserved.json match Anchor:
 *   sha256("global:<snake_case_name>")[0..8]
 *
 * Usage: node scripts/verify-idl-discriminators.mjs
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const idlPath = join(__dirname, "..", "target", "idl", "reserved.json");

function disc(name) {
  const h = createHash("sha256").update(`global:${name}`).digest();
  return [...h.subarray(0, 8)];
}

const idl = JSON.parse(readFileSync(idlPath, "utf8"));
let ok = true;
for (const ix of idl.instructions) {
  const expected = disc(ix.name);
  const got = ix.discriminator;
  const match =
    Array.isArray(got) &&
    got.length === 8 &&
    got.every((b, i) => b === expected[i]);
  if (!match) {
    ok = false;
    console.error("MISMATCH:", ix.name, { expected, got });
  } else {
    console.log("OK:", ix.name, got.join(","));
  }
}
if (!ok) process.exit(1);
console.log("All instruction discriminators match Anchor global:* convention.");
