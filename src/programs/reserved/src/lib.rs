//! RESERVED Protocol - auditable privacy on Solana (Zcash-style IVK/OVK roles; institutional audit rails).
//!
//! Architectural contract
//!
//! Ingress (public leg): SPL still flows into `vault_token_account` under a PDA vault_authority.
//! `deposit_public` / `withdraw_public` now authenticate economic amount via hash openings +
//! `amount_commitment` (no cleartext `u64` in the Anchor IDL). SPL CPI amounts remain visible to
//! observers who decode Token instructions. `VaultConfig::bunker_liquidity_root` stores a
//! commitment-only rolling digest; compressed twin layout: `ReservedBunkerShadowLeaf`.
//!
//! User binding: UserNoteHead stores ivk_binding and ovk_binding derived off-chain from
//! hierarchical secrets. The spend authorization is only spend_authority: Pubkey signatures.
//! IVK/OVK never appear as cleartext ledger fields -- mirroring Sapling separation between
//! ask/nsk (spend path secrets) and ivk (incoming scan key) except that Solana binds spends to
//! ed25519 keys suitable for program invocation rather than embedded redDSA in a single UTXO proof.
//!
//! Selective disclosure: AuditorPolicy pins auditor_pubkey for institutional visibility of
//! ciphertext / opened attributes under policy policy_commitment. This is orthogonal to
//! spending: auditors verify flows without inheriting spend_authority.
//!
//! Egress to compressed state: shield_into_compressed moves SPL from the escrow ATA toward
//! the Light pool token account, then CPIs the Light System Program with a client ValidityProof
//! and remaining_accounts built via light_sdk CpiAccounts::new.
//!
//! `sync_bunker_shadow` publishes [`ReservedBunkerShadowLeaf`] (liquidity commitment + sequence) to the
//! compressed forest using the same CPI family — **sin transferencia SPL**; firma `vault_config.authority`.

#![allow(clippy::too_many_arguments)]

pub mod bunker;
pub mod constants;
pub mod errors;
pub mod instructions;
pub mod state;

// Re-export for #[program] module visibility.
pub use instructions::*;

use anchor_lang::prelude::*;
use light_sdk::{derive_light_cpi_signer, CpiSigner, LightDiscriminator};

/// Program ID for this build - must match keys/reserved-final.json used at deploy.
declare_id!("BA5QxMGYW132ELKZ58jJ7hDjKNHSPB52hfmuwiYGDNYR");

pub const LIGHT_CPI_SIGNER: CpiSigner =
    derive_light_cpi_signer!("BA5QxMGYW132ELKZ58jJ7hDjKNHSPB52hfmuwiYGDNYR");

#[derive(Clone, Debug, Default, LightDiscriminator, AnchorSerialize, AnchorDeserialize)]
pub struct ReservedShieldLeaf {
    pub owner: Pubkey,
    pub amount_commitment: [u8; 32],
    pub note_sequence: u64,
    pub ovk_binding: [u8; 32],
}

/// Compressed-state shadow of `VaultConfig::bunker_liquidity_root` (Light CPI / `sync_bunker_shadow`).
#[derive(Clone, Debug, Default, LightDiscriminator, AnchorSerialize, AnchorDeserialize)]
pub struct ReservedBunkerShadowLeaf {
    pub vault_config: Pubkey,
    pub deposit_mint: Pubkey,
    pub liquidity_root: [u8; 32],
    pub sync_sequence: u64,
}

#[program]
pub mod reserved {
    use super::*;
    use crate::instructions::*;

    pub fn initialize_vault(
        ctx: Context<InitializeVault>,
        chain_id_hash: [u8; 32],
        light_state_tree: Pubkey,
    ) -> Result<()> {
        initialize_vault_handler(ctx, chain_id_hash, light_state_tree)
    }

    pub fn register_user_note_head(
        ctx: Context<RegisterUserNoteHead>,
        ivk_binding: [u8; 32],
        ovk_binding: [u8; 32],
    ) -> Result<()> {
        register_user_note_head_handler(ctx, ivk_binding, ovk_binding)
    }

    pub fn deposit_public(
        ctx: Context<DepositPublic>,
        amount_commitment: [u8; 32],
        amount_opening: Vec<u8>,
    ) -> Result<()> {
        deposit_public_handler(ctx, amount_commitment, amount_opening)
    }

    pub fn withdraw_public(
        ctx: Context<WithdrawPublic>,
        amount_commitment: [u8; 32],
        amount_opening: Vec<u8>,
    ) -> Result<()> {
        withdraw_public_handler(ctx, amount_commitment, amount_opening)
    }

    pub fn upsert_auditor_policy(
        ctx: Context<UpsertAuditorPolicy>,
        auditor_pubkey: Pubkey,
        policy_commitment: [u8; 32],
        unix_ts: i64,
    ) -> Result<()> {
        upsert_auditor_policy_handler(ctx, auditor_pubkey, policy_commitment, unix_ts)
    }

    pub fn shield_into_compressed<'info>(
        ctx: Context<'_, '_, '_, 'info, ShieldIntoCompressed<'info>>,
        amount: u64,
        amount_commitment: [u8; 32],
        next_anchor_hint: [u8; 32],
        expected_policy_commitment: [u8; 32],
        output_tree_index: u8,
        address_seed: [u8; 32],
        compressed_address: [u8; 32],
        address_merkle_tree_pubkey_index: u8,
        address_tree_info: light_sdk::instruction::PackedAddressTreeInfo,
        proof: light_sdk::instruction::ValidityProof,
    ) -> Result<()> {
        shield_into_compressed_handler(
            ctx,
            amount,
            amount_commitment,
            next_anchor_hint,
            expected_policy_commitment,
            output_tree_index,
            address_seed,
            compressed_address,
            address_merkle_tree_pubkey_index,
            address_tree_info,
            proof,
        )
    }

    pub fn sync_bunker_shadow<'info>(
        ctx: Context<'_, '_, '_, 'info, SyncBunkerShadow<'info>>,
        next_anchor_hint: [u8; 32],
        expected_policy_commitment: [u8; 32],
        output_tree_index: u8,
        address_tree_info: light_sdk::instruction::PackedAddressTreeInfo,
        proof: light_sdk::instruction::ValidityProof,
    ) -> Result<()> {
        sync_bunker_shadow_handler(
            ctx,
            next_anchor_hint,
            expected_policy_commitment,
            output_tree_index,
            address_tree_info,
            proof,
        )
    }

    /// Phase 2 egress preview: accounts fixed in IDL; returns `ContractLogicNotYetLive` until live.
    pub fn decompress_to_spl_preview(ctx: Context<DecompressToSplPreview>) -> Result<()> {
        decompress_to_spl_preview_handler(ctx)
    }
}
