//! **`sync_bunker_shadow`:** empuja [`crate::ReservedBunkerShadowLeaf`] al árbol comprimido global vía CPI a
//! Light System Program (misma familia que `shield_into_compressed`), **sin** movimiento SPL.
//!
//! - Solo **`vault_config.authority`** puede invocar: `has_one = authority` en `vault_config` + firma del signer `authority`.
//! - **`bunker_shadow_sequence`** solo aumenta en este handler **después** de un CPI Light exitoso; ninguna otra instrucción lo escribe (manipulación vía programa excluida salvo upgrade).
//! - Réplica de las comprobaciones de **`AuditorPolicy`** que usa el shield para trazabilidad auditable.
//! - Los campos de la hoja se toman del estado on-chain (`bunker_liquidity_root`, `deposit_mint`, etc.):
//!   el cliente no puede fijar un `liquidity_root` arbitrario en este CPI.

use crate::constants::{SEED_AUDITOR_POLICY, SEED_VAULT_CONFIG};
use crate::errors::ReservedError;
use crate::state::{AuditorPolicy, VaultConfig};
use crate::{ReservedBunkerShadowLeaf, LIGHT_CPI_SIGNER};
use anchor_lang::prelude::*;
use light_sdk::account::LightAccount;
use light_sdk::address::v2::derive_address;
use light_sdk::cpi::invoke::InvokeLightSystemProgram;
use light_sdk::cpi::v2::{CpiAccounts, LightSystemProgramCpi};
use light_sdk::instruction::{PackedAddressTreeInfo, ValidityProof};
use light_sdk::LightCpiInstruction;
use light_sdk::PackedAddressTreeInfoExt;

#[derive(Accounts)]
#[instruction(
    next_anchor_hint: [u8; 32],
    expected_policy_commitment: [u8; 32],
    output_tree_index: u8,
)]
pub struct SyncBunkerShadow<'info> {
    #[account(mut)]
    pub fee_payer: Signer<'info>,
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [SEED_VAULT_CONFIG, vault_config.deposit_mint.as_ref()],
        bump = vault_config.bump_vault,
        has_one = authority @ ReservedError::UnauthorizedSpend,
    )]
    pub vault_config: Account<'info, VaultConfig>,
    #[account(
        seeds = [SEED_AUDITOR_POLICY, vault_config.key().as_ref()],
        bump = auditor_policy.bump,
    )]
    pub auditor_policy: Account<'info, AuditorPolicy>,
    /// When `auditor_policy.auditor_pubkey` is non-default, this account must sign and match it.
    /// CHECK: optional co-signer for institutional attestation (igual que en shield).
    pub auditor_attestor: UncheckedAccount<'info>,
}

pub fn sync_bunker_shadow_handler<'info>(
    ctx: Context<'_, '_, '_, 'info, SyncBunkerShadow<'info>>,
    next_anchor_hint: [u8; 32],
    expected_policy_commitment: [u8; 32],
    output_tree_index: u8,
    address_tree_info: PackedAddressTreeInfo,
    proof: ValidityProof,
) -> Result<()> {
    let ap = &ctx.accounts.auditor_policy;
    require!(
        expected_policy_commitment == ap.policy_commitment,
        ReservedError::AuditorPolicyMismatch
    );
    if ap.auditor_pubkey != Pubkey::default() {
        require!(
            ctx.accounts.auditor_attestor.is_signer,
            ReservedError::AuditorAttestationRequired
        );
        require_keys_eq!(
            ctx.accounts.auditor_attestor.key(),
            ap.auditor_pubkey,
            ReservedError::AuditorAttestationRequired
        );
    }

    let cfg = &ctx.accounts.vault_config;
    let seq = cfg.bunker_shadow_sequence;
    let vault_pk = cfg.key();
    let mint_pk = cfg.deposit_mint;

    let light_cpi_accounts = CpiAccounts::new(
        ctx.accounts.fee_payer.as_ref(),
        ctx.remaining_accounts,
        LIGHT_CPI_SIGNER,
    );

    require!(
        output_tree_index != address_tree_info.address_merkle_tree_pubkey_index,
        ReservedError::LightTreeIndexConflict
    );
    require!(
        output_tree_index != address_tree_info.address_queue_pubkey_index,
        ReservedError::LightTreeIndexConflict
    );

    let tree_pk = address_tree_info
        .get_tree_pubkey(&light_cpi_accounts)
        .map_err(|_| ReservedError::LightCompress)?;
    let (address, address_seed) = derive_address(
        &[
            b"reserved_bunker_shadow".as_slice(),
            vault_pk.as_ref(),
            &seq.to_le_bytes(),
        ],
        &tree_pk,
        &crate::ID,
    );

    // See `light_shield.rs`: second arg is `assigned_account_index` for the batch, not a tree index.
    let new_address_params = address_tree_info.into_new_address_params_assigned_packed(
        address_seed,
        Some(0),
    );

    let mut leaf = LightAccount::<ReservedBunkerShadowLeaf>::new_init(
        &crate::ID,
        Some(address),
        output_tree_index,
    );
    leaf.vault_config = vault_pk;
    leaf.deposit_mint = mint_pk;
    leaf.liquidity_root = cfg.bunker_liquidity_root;
    leaf.sync_sequence = seq;

    // Match the official Light V2 builder order so the account output is attached
    // before the assigned new-address metadata references account index 0.
    LightSystemProgramCpi::new_cpi(LIGHT_CPI_SIGNER, proof)
        .with_light_account(leaf)
        .map_err(|_| ReservedError::LightCompress)?
        .with_new_addresses(&[new_address_params])
        .invoke(light_cpi_accounts)
        .map_err(|_| ReservedError::LightCompress)?;

    let cfg_mut = &mut ctx.accounts.vault_config;
    cfg_mut.bunker_shadow_sequence = seq
        .checked_add(1)
        .ok_or(ReservedError::AmountOverflow)?;
    let _ = next_anchor_hint;
    Ok(())
}
