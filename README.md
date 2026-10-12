# RESERVED Protocol

**Auditable privacy on Solana** — public SPL treasury rails, selective disclosure under policy, and **ZK-compressed** note state via [Light Protocol](https://www.lightprotocol.com/) **v0.23** (stateless validity proofs + Merkle-compressed accounts).

This repository (`./reserved-protocol/` layout: program under `src/programs/reserved/`) is written for **passive institutional review**: the on-chain surface encodes explicit economic and custody invariants, and policy is bound to human-readable attestations where required. The Solana package name remains **`reserved`** for Anchor and `cargo` tooling compatibility.

---

## Technical thesis: why Light Protocol v0.23 (ZK-compression)

**Problem.** Classic “privacy” stacks often force a binary choice: **full opacity** (hard to supervise) or **full transparency** (hard to protect legitimate confidentiality).

**Light v0.23** targets **verifiable compression**: account data and state transitions are committed under succinct proofs and Merkle trees, so the base layer stores **roots and compressed deltas** instead of duplicating every user field in traditional account slots. For a protocol that must justify **funds flow, policy, and auditability** in the same breath as **confidentiality**, compression provides:

- **Anchored state** — commitments live in trees with cryptographic consistency checks, not ad-hoc off-chain indices.
- **Executable integrity** — CPI boundaries can require validity proofs that tie instruction data to tree state.
- **Operational realism** — long-term growth is dominated by **state rent and lookup cost**; compression shifts marginal cost from “one full account per user action” toward **proof verification + tree updates**, which is the right axis for institutional throughput planning.

RESERVED Protocol uses this stack where the **economic leg** (SPL movement) must match the **registered leaf** so reviewers see a single coherent story: *what moved on the ledger is what was committed in compressed form.*

---

## Audit architecture: `AuditorPolicy`, viewing keys, and “auditable privacy”

| Concept | Role | On-chain artifact |
|--------|------|-------------------|
| **Spend authority** | Authorizes state transitions that move value | `Signer` / PDA flows in instructions |
| **IVK binding** | Incoming viewing / scan capability (Zcash-style *incoming* semantics) | `UserNoteHead.ivk_binding` (commitment only) |
| **OVK binding** | Outgoing / disclosure envelope key material | `ReservedShieldLeaf.ovk_binding` |
| **`AuditorPolicy`** | Institutional visibility under signed policy | `auditor_pubkey`, `policy_commitment`, timestamps |

**Why this is not a generic mixer.** Mixer designs optimize for **unlinkability** among equal participants, often at the cost of **explainable attribution** and **policy hooks**. RESERVED Protocol separates:

1. **Treasury-grade public ingress** — SPL deposits that are intentionally observable for reconciliation.
2. **Compressed note registration** — leaves carry commitments and viewing-key bindings suitable for **selective disclosure** to an auditor bound by `policy_commitment`.
3. **Optional co-attestation** — when `auditor_pubkey` is set, shielding can require an **auditor signature**, aligning on-chain execution with **off-chain controls**.

Auditors verify **flows under policy** without becoming **spend authorities**; spend remains tied to the user’s signing keys, mirroring the separation between **compliance visibility** and **custody of funds**.

---

## ⚖️ Privacy & Compliance

**Selective auditability — not total anonymity.** RESERVED is architected on ***Confidentiality with Accountability*** (the same principle restated throughout this section: **auditable privacy**, not a disclaimer of all traceability on transparent SPL rails). The protocol intentionally separates **what the public ledger must prove** (integrity of flows, adherence to policy, and cryptographic binding to commitments) from **what remains under the control of the vault owner and designated auditors** (selective visibility into economic detail where the architecture allows).

**Private, not lawless.** RESERVED is **not** positioned as permissionless opacity. Where SPL or L1 semantics remain observable by design, that is documented transparently. Where the system uses commitments, compressed state, and viewing-key bindings, the objective is **operational confidentiality with an audit trail**: institutions can show *that* rules were enforced and *that* state transitions are consistent, while **granular amount disclosure** is gated by **vault governance** (`VaultConfig.authority`), **policy commitment** (`AuditorPolicy`), and **explicit co-attestation** when configured—not by anonymous endpoints scraping a UI.

**Selective auditability.** The **vault authority** and, where applicable, an **auditor bound by `policy_commitment`**, are the parties for whom the design reserves **auditable** insight: shield bindings, bunker liquidity commitments, compressed bunker sync (`sync_bunker_shadow`), and optional attestor signatures. This is **selective disclosure** in the compliance sense: confidentiality for operations and counterparties, **accountability** to governance and policy.

**Regulatory framing (not legal advice).** This repository describes **technical mechanisms** only. It does **not** constitute legal, regulatory, licensing, or tax advice. Deployers remain solely responsible for **AML/CFT**, sanctions, reporting, and any obligations in their jurisdictions. The narrative here supports **prestige and legal review** with **precise, non-misleading claims**: the stack targets **private execution with owner-controlled and policy-bound auditability**—not a guarantee of undetectability on public Solana state where base-layer token accounts or instructions remain legible.

**IDL / bytecode hygiene.** Before mainnet or institutional sign-off, run **`anchor build`** and confirm the generated IDL’s **8-byte instruction discriminators** match `sha256("global:<instruction_name>")[0..8]` for every exported handler (including **`sync_bunker_shadow`**). You can re-check the checked-in IDL with: `node scripts/verify-idl-discriminators.mjs`.

### Confidential, not anonymous

**RESERVED is *confidential*, not *anonymous*.** The architecture assumes identifiable **vault governance** (`VaultConfig.authority`), **policy-bound audit hooks** (`AuditorPolicy`), and **cryptographic attribution** where the protocol requires signatures—not a promise of unlinkable pseudonymity against lawful process or against all public-chain analysis. **The owner can audit** flows tied to bunker commitments, compressed leaves, and institutional policy through the same authority and attestation surface the program enforces on-chain. Framing the system as **confidential with accountability** (rather than “anonymous treasury”) protects **operator reputation** and supports **accurate legal and regulatory narratives**: privacy features are **selective and governed**, not a blanket disclaimer of traceability on transparent SPL rails where the base layer remains legible.

## 🚀 SBED: Forensic Hygiene

**Session-Based Ephemeral Decryption (SBED)** is how the **Caja de Seguridad Digital** (reference ops console) keeps *presentation* aligned with *policy*: **decrypted or sensitive read paths exist only in an active, authorized session**. ZK-compression and bunker commitments live on-chain under **Light Protocol** and `VaultConfig`; the client combines **volatile session nonces** with **explicit authority signatures** so that idle UI state does not casually retain spendable context—within ordinary browser and OS limits.

**Forensic Silence** is the console’s deliberate **post-sensitive-operation** step (e.g. after a **USDC Devnet** shield or vault deposit): it **wipes** the retained SBED signature material, **clears** amount fields and cofre shadow displays, and records an **audit log line** (`SBED: Forensic Silence Enforced`) so operators see that the UI has returned to a **post-commitment posture**. This reinforces **auditable privacy**—users feel a vault-grade lockstep—not a claim of full anonymity on every L1 observable.

**How SBED is applied in the shipped ops console (`app/src/App.tsx`):**

| Element | Role |
|---------|------|
| **`session_nonce`** | Generated with CSPRNG when the wallet **connects**; stored **only in ephemeral React state** (no `localStorage` / `sessionStorage` for this secret). |
| **Authority bind** | The vault **authority** must **sign** the base challenge string concatenated with the active `session_nonce`. |
| **Volatile wipe** | On **wallet disconnect**, **`beforeunload`**, and **`pagehide`** (non-bfcache), the console **clears** nonce state, balance UI state, bunker meta, and **zero-fills** the retained ed25519 signature bytes in memory. A full **page reload** destroys the React tree and its state. |
| **Forensic Silence** | After confirmed **USDC** shield or cofre deposit, **`enforceForensicSilence`** unifies wipe + UI reset + audit log entry (see implementation). |
| **On-chain alignment** | **`sync_bunker_shadow`** (IDL: `sync_bunker_shadow`, `VaultConfig.bunker_liquidity_root`, `VaultConfig.bunker_shadow_sequence`) publishes **`ReservedBunkerShadowLeaf`** under **vault authority + auditor policy**, pairing **client SBED** discipline with **compressed-root** accountability. |

**Non-claims.** SBED and Forensic Silence do **not** guarantee secrecy against malware, browser extensions, or physical memory forensics; they **do** encode a **professional posture** for **auditable privacy**: short-lived client disclosure keyed to session and owner signatures, with long-run commitments under **ZK-backed** and policy-bound on-chain surfaces.

### Sapling-lite key model — off-chain sovereignty

RESERVED adopts a **Sapling-inspired role split** adapted to Solana accounts (not Sapling cryptography on-chain):

- **IVK / OVK material never appears in cleartext on-chain.** `UserNoteHead` stores **`ivk_binding`** and **`ovk_binding`** only — compact commitments/hash encodings adequate for linkage checks and auditor-facing disclosure envelopes. **Possession of the underlying viewing/sealing keys stays entirely client-side.** On-chain reviewers see *that* commitments were registered under a vault and authority, never the keys themselves.

- **`spend_authority` is orthogonal** — it maps to ordinary **ed25519** invocations suited to SPL and program CPI flows. Zcash-era spend paths bundled ask/nsk with different roles; here, **privacy semantics** (scanning/disclosure payloads) attach to bindings, **while spend authorization remains explicit Solana signers.**

This framing is deliberate for **institutional protocol review**: auditors and risk teams can bound *what state exists* and *who can move funds*, without implying that auditors hold user viewing secrets.

---

## Institutional differentiator: `NewAddressParamsAssignedPacked` (v2 address standard)

Light Protocol **v2** introduces explicit **assignment** of new compressed addresses to **queue indices** in the CPI batch. RESERVED Protocol uses **`into_new_address_params_assigned_packed`** (from `PackedAddressTreeInfo`) so that:

- The **address seed** is derived deterministically for reviewers (`derive_address` domain).
- The **assigned output index** (`Some(...)`) matches the **address-queue account ordering** the client encoded in `remaining_accounts` and the validity proof — eliminating ambiguous “default queue slot” behavior that complicates third-party verification.

This is a **security-relevant v2 convention**: reviewers can correlate instruction packing, proof public inputs, and tree updates **without guessing** which queue entry was intended.

---

## Economic loop completeness & egress roadmap (`decompress_to_spl`)

**Shipped leg (this repository snapshot).** The on-chain MVP closes **public SPL ingress → escrow → audited shield into Light-compressed leaf** (`shield_into_compressed`), with treasury and policy anchors suitable for demos and reviewer walkthroughs. A companion **`decompress_to_spl_preview`** instruction publishes the egress account layout in the IDL and reliably returns **`ContractLogicNotYetLive`** until Phase 2 (nullifiers + Light proofs) lands—this is deliberate interface stability, not a silent fork.

**Planned egress leg — `decompress_to_spl` (roadmap name).** A future instruction completes the economic round trip: **consumption or opening of compressed note state**, validation against the Light **state/tree root**, **release of SPL** to an allowed public destination ATA (subject to vault + policy guards), analogous to exiting shielded funds to transparent rails in Sapling-era designs.

Technical commitments for that phase (architecture review / Colosseum Q&A baseline):

| Mechanism | Purpose |
|-----------|---------|
| **Nullifier set (or epoch’d nullifier PDA/account map)** | After a compressed note leaf is deemed spent toward an SPL egress, publish a **nullifier** keyed by derivation material unique to that note lifecycle. Inclusion of a duplicate nullifier **must abort**. This is the canonical countermeasure for **double spend** across tree updates once multiple spends are allowed. Exact account layout (`system program` vs registrar PDA vs Light-native nullifier bookkeeping) stays versioned explicitly in the roadmap doc per Light’s spend model. |
| **Light Protocol v2 Merkle / validity proofs** | Egress must prove **well-formedness and inclusion** of the compressed state being consumed under the **current root** (or authorized root history) before debiting pool custody and crediting public SPL. This mirrors **inbound** `ValidityProof` discipline: **Merkle membership + transition validity** are not hand-waved—they are enforced at the CPI boundary the same way shielding already ties SPL debits to a new compressed leaf assignment. |

**Judge-facing clarity.** Documenting egress as roadmap + explicit nullifiers + Light proofs preempts “half-a-protocol” critiques: RESERVED does not claim anonymity *of the public SPL leg today*; it claims **deterministic treasury accounting**, **compression with validity proofs**, and a **planned, cryptographically sane exit** consistent with audited stablecoin treasury semantics.

---

## Compute efficiency (placeholder)

Representative **CU / rent** comparison — replace with measurements from your cluster and transaction profiler.

| Operation | Traditional full accounts (illustrative) | RESERVED Protocol + compressed state (illustrative) |
|-----------|------------------------------------------|-------------------------------------------|
| Register user note head | _TBD CU_ · _TBD rent/byte_ | _TBD CU_ · _TBD rent/byte_ |
| Public deposit | _TBD CU_ | _TBD CU_ |
| Shield into compressed leaf | N/A (no tree) | _TBD CU_ (proof + CPI + SPL) |
| Long-run state growth | Linear in touched accounts | Sublinear vs full account duplication (tree growth) |

**Methodology note:** Publish CU from `simulate`-style traces and rent from **post-state account sizes** after benchmark transactions.

---

## Security analysis: cryptographic bindings (on-chain)

The shield instruction **enforces** the following **integrity constraints** in English for reviewers and tooling authors:

1. **Amount–commitment link (v1 schema) — SHA-256 by design.**  
   The SPL `amount` transferred in the shield instruction must match the preimage committed as **`amount_commitment`** on the compressed leaf. The program recomputes a **SHA-256 (Merkle–Damgård) digest** over the **v1 domain-separated preimage**:

   `schema_v1 || amount_le || vault_config_pubkey || note_sequence (pre-increment) || deposit_mint || chain_id_hash || spend_authority || program_id`

   and **rejects** the instruction if it does not match the supplied `amount_commitment`. This closes **decoupling** attacks (*X* tokens moved vs *Y* registered on the leaf).

   **Judge / auditor interpretation (not optional spin).** v1 binds the **economically observable SPL leg** to the compressed registration **before** richer anonymity inside the compressed tree. SHA-256 on a structured preimage is deliberately **transparent to anyone who verifies the preimage** → it is an **audit and reconciliation feature** (treasury-grade 1:1 accounting between escrow movement and compressed commitment), **not** a promise of amount-hiding inside that binding. Hidden note amounts Pedersen-style belong to a future **explicit schema bump** with its own domain tag and proof obligations—never silent substitution of v1.

   **Protocol positioning:** treat public `amount` + v1 commitment as **institutional rail integrity**; treat **compressed state + Light validity proofs** as the layer where **capacity and proof-carrying anonymity arguments** escalate—without pretending v1 magically hides payroll figures on the transparent SPL ingress.

2. **Light pool custody.**  
   `light_pool_token_account.owner` must be one of the **canonical Light program IDs** from `light-sdk` (system, compressed token, account compression) **or** a **protocol custodian PDA** derived under `SEED_LIGHT_POOL_CUSTODY` for the vault mint. Arbitrary third-party ATAs cannot serve as the shield destination.

3. **Policy binding.**  
   Callers pass `expected_policy_commitment`; the program checks equality against `AuditorPolicy.policy_commitment`, and enforces **auditor co-signing** when an auditor pubkey is configured.

4. **Address derivation binding.**  
   Leaf initialization uses `derive_address` over a fixed domain (`reserved_shield`, user, vault, sequence) so compressed addresses are **not** free-form at CPI time.

**Client responsibility:** Off-chain builders must supply `amount_commitment` consistent with the same v1 preimage the program verifies; document any future migration to hidden Pedersen-style note amounts as a **new schema version** with an explicit domain tag.

---

## Repository layout

At the repo root (clone path agnostic), program sources live under:

- `src/programs/reserved/` — Anchor program: vault, note head registration, auditor policy, **shield → Light v2 CPI**.

---

## Build

```bash
$ cargo check -p reserved
```

Run the command from the repository root (any local path, e.g. `./reserved-protocol/`).

**Integration smoke:** after `npm install`, `anchor test` runs an embedded **Localnet** validator (see **Deploy readiness § Technical compliance**) and executes `tests/reserved.ts` (`initialize_vault`). `npx tsc -p tsconfig.json --noEmit` typechecks TS without a chain.

IDL generation and local validator steps follow standard Anchor workflows for your toolchain version.

---

## Future compatibility & technical sovereignty (`vendor/`, Cargo pins)

ZK-compressed CPI on **today’s** toolchain is not a Cargo “semver happy path” yet: **`light-sdk` and adjacent crates evolve with the compression programs**, while **Anchor 0.31** and Solana **SBF/host Rust** constrain which compiler features and transitive versions compile cleanly together.

**Why `vendor/` and `[patch.crates-io]` exist.** RESERVED treats this as **technical sovereignty**:

- **`vendor/`** holds **narrow, auditable deltas** needed to reconcile upstream crates with the **rustc effective for Solana BPF/SBF builds** (and with stable macro/syn surfaces under Anchor-generated code)—without waiting on a crates.io semver line that temporarily lags Solana releases.
- **Workspace pins / `[workspace.dependencies]`** lock **transitives** (`blake3`, `pinocchio`, …) known good under **Anchor 0.31** profiles so CI and deploy machines reproduce the same bytecode story.

These are deliberate **supply-chain guardrails**, not improvisation: reviewers can inspect every changed line beside upstream.

**“Patch-less” end state.** The protocol is structured so that **`vendor/` disappears as soon as upstream Light + Rust toolchain + Anchor stack catch up**: path overrides revert to crates.io semver, pins narrow to ordinary dependency hygiene, and the **on-chain CPI surface** stays the contractual boundary. Framed plainly for judges: RESERVED is integrating **ZK-compression** at the frontier of **today’s** SVM; the patches are **pre-integration scaffolding** aligned with **where SVM tooling is consolidating**—not surrender to bitrot.

**Operational honesty (one line auditors respect).** Each removal of `vendor/` remains a **versioned migration** (regression tests + proof clients + Light program IDs). Narrative shields do not waive that work—they schedule it honestly once ecosystem maturity crosses the parity line **this architecture assumes**.

---

## Deploy readiness (Anchor)

From a **documentation and program surface** perspective, RESERVED is framed as **institutional-grade** in the narrow sense defined above (explicit treasury invariants, policy binding, Sapling-lite key separation on-chain). **Operational deploy** remains your toolchain’s responsibility:

| Check | Intent |
|-------|--------|
| `cargo check -p reserved` | Host-side parity with patched Light / Anchor pins |
| `anchor build` (+ IDL generation if desired) | SBF artefact matches `declare_id` and `Anchor.toml` cluster targets |
| `anchor deploy …` against devnet/localnet | Funded-deployer key + cluster RPC healthy |

### Technical compliance

Note: This deployment utilizes the sovereign patched environment (see **Future compatibility & technical sovereignty** above) to enable ZK-compression features on Anchor 0.31.

`Anchor.toml` defaults `provider.cluster = Localnet` so `anchor test` runs an embedded validator without devnet SOL. For Devnet uploads use e.g. `anchor deploy --provider.cluster devnet` (matching `[programs.devnet]` / `declare_id`).

This README commits the **narrativa técnica** for judges (egress roadmap, SHA-256 v1 rationale, off-chain sovereign viewing keys); it does **not** replace executing the build and simulation on hardware you control before competition demos.

---

## License

See project license file if present; default to terms specified by the repository owner.
