//! On-chain state mirrors *roles* from Zcash-style UTXO privacy, adapted to Solana accounts:
//!
//! - **Spend authority** maps to Solana `Pubkey` signatures over instructions that `burn` public SPL
//!   or authorize compressed-to-public exits. It is intentionally **not** the viewing key.
//! - **Viewing key material (IVK / OVK)** never lives in plaintext on-chain. We store only
//!   **commitments** (`*_binding`) so the user proves consistency in zero-knowledge or uses
//!   off-chain wallets to trial-decrypt, while spend keys stay air-gapped from observation keys.
//! - **Auditor pubkey** is a *policy* knob for selective disclosure (corporate audit / regulator):
//!   it does not grant spend rights; it defines who may receive openings or wrapped ciphertexts
//!   per your off-chain / L2 proving system.

use anchor_lang::prelude::*;

/// Global configuration + public-ingres vault linkage.
#[account]
pub struct VaultConfig {
    /// Admin rotation (governance / protocol multisig).
    pub authority: Pubkey,
    /// SPL mint accepted in the public deposit phase (plain Token / Token-2022 via SPL program).
    pub deposit_mint: Pubkey,
    /// Bump for `vault_config` PDA.
    pub bump_vault: u8,
    /// Bump for public escrow authority PDA (`SEED_PUBLIC_ESCROW` + mint).
    pub bump_escrow: u8,
    /// Incremented on each structural change (auditor rotation, tree migration).
    pub version: u64,
    /// Optional: Light Protocol **state tree** / compressed account root reference for shielded notes.
    /// Exact type evolves with `light-sdk` CPI layout — keep opaque until CPI is pinned.
    pub light_state_tree: Pubkey,
    /// Chain metadata for IVK/OVK binding (prevents cross-cluster replay of commitments).
    pub chain_id_hash: [u8; 32],
    /// Commitment-only bunker liquidity digest (no public `u64` balance field). Updated on each
    /// `deposit_public` / `withdraw_public`; mirrored in compressed leaves as [`crate::ReservedBunkerShadowLeaf`]
    /// when [`crate::instructions::sync_bunker_shadow`] runs.
    pub bunker_liquidity_root: [u8; 32],
    /// Monotonic sequence for compressed address seeds (`reserved_bunker_shadow` || vault || le64(seq)).
    pub bunker_shadow_sequence: u64,
}

impl VaultConfig {
    /// Borsh payload only (excludes Anchor’s 8-byte `account` discriminator).
    /// Includes `[u8;32] bunker_liquidity_root` + `u64 bunker_shadow_sequence` among other fields — keep in sync with struct layout for `ACCOUNT_INIT_SPACE`.
    pub const PAYLOAD_LEN: usize = 32 + 32 + 1 + 1 + 8 + 32 + 32 + 32 + 8;

    /// **`init` / realloc space** — always `8 + payload` so future field additions change one place only.
    pub const ACCOUNT_INIT_SPACE: usize = 8 + Self::PAYLOAD_LEN;

    /// Back-compat name used across the codebase; equals [`Self::ACCOUNT_INIT_SPACE`].
    pub const SIZE: usize = Self::ACCOUNT_INIT_SPACE;
}

/// Per-user (or per-spend-authority) head record. Links public deposits to shielding workflow.
#[account]
pub struct UserNoteHead {
    /// Must sign any operation that spends shielded value back to public SOL/SPL.
    pub spend_authority: Pubkey,
    /// Pedersen / Poseidon-style binding commitment to **incoming viewing key**-derived root.
    /// Actual IVK never stored — Zcash Sapling-inspired separation from spend secret.
    pub ivk_binding: [u8; 32],
    /// Binding to **outgoing viewing key** material (ovk.commitment) — used for auditable
    /// ciphertext outputs without revealing spend paths to observers who lack IVK.
    pub ovk_binding: [u8; 32],
    /// Monotonic nonce for note nullifier domain (prevents replay; details in proving system).
    pub note_sequence: u64,
    /// Points to latest compressed leaf index or anchor (filled when Light bridge executes).
    pub latest_compressed_anchor: [u8; 32],
    pub bump: u8,
}

impl UserNoteHead {
    pub const SIZE: usize = 8 + 32 * 4 + 8 + 32 + 1;
}

/// Institutional selective disclosure: holds the **auditor ElGamal / policy pubkey** slot.
/// Token-2022 confidential extension uses a similar *auditor ElGamal pubkey* pattern for third-party
/// review of encrypted balances — we generalize at protocol level for treasury workflows.
#[account]
pub struct AuditorPolicy {
    /// Who last rotated this record.
    pub authority: Pubkey,
    /// Optional auditor viewing key encoded for on-chain policy checks (32-byte compact encoding or hash of full key).
    pub auditor_pubkey: Pubkey,
    /// Hash of off-chain policy document / SLA (IPFS CID commitment, etc.).
    pub policy_commitment: [u8; 32],
    /// Unix timestamp of last rotation (rough ordering for compliance logs).
    pub last_rotation_ts: i64,
    pub bump: u8,
}

impl AuditorPolicy {
    pub const SIZE: usize = 8 + 32 * 2 + 32 + 8 + 1;
}
