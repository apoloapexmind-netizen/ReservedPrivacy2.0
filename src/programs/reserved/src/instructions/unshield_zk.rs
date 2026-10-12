//! **`unshield_zk`:** consume one existing [`crate::ReservedShieldLeaf`] and release the full SPL
//! amount back to the user's recipient ATA.
//!
//! Phase 2A scope:
//! - burns exactly one compressed note
//! - no partial spends
//! - no change output

use crate::constants::{
    AMOUNT_COMMITMENT_SCHEMA_V1, SEED_AUDITOR_POLICY, SEED_LIGHT_POOL_CUSTODY, SEED_VAULT_CONFIG,
};
use crate::errors::ReservedError;
use crate::state::{AuditorPolicy, VaultConfig};
use crate::{ReservedShieldLeaf, LIGHT_CPI_SIGNER};
use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::hashv;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
use light_sdk::account::LightAccount;
use light_sdk::cpi::invoke::InvokeLightSystemProgram;
use light_sdk::cpi::v2::{CpiAccounts, LightSystemProgramCpi};
use light_sdk::instruction::{account_meta::CompressedAccountMetaBurn, ValidityProof};
use light_sdk::LightCpiInstruction;

#[derive(Accounts)]
pub struct UnshieldZk<'info> {
    #[account(mut)]
    pub fee_payer: Signer<'info>,
    #[account(mut)]
    pub spend_authority: Signer<'info>,
    #[account(
        seeds = [SEED_VAULT_CONFIG, vault_config.deposit_mint.as_ref()],
        bump = vault_config.bump_vault,
    )]
    pub vault_config: Account<'info, VaultConfig>,
    #[account(
        seeds = [SEED_AUDITOR_POLICY, vault_config.key().as_ref()],
        bump = auditor_policy.bump,
    )]
    pub auditor_policy: Account<'info, AuditorPolicy>,
    #[account(
        mut,
        constraint = light_pool_token_account.mint == vault_config.deposit_mint @ ReservedError::LightPoolDestination,
        constraint = light_pool_token_account.owner == light_pool_custody.key() @ ReservedError::InvalidLightPoolOwner,
    )]
    pub light_pool_token_account: Account<'info, TokenAccount>,
    /// CHECK: PDA authority for `light_pool_token_account`.
    #[account(
        seeds = [SEED_LIGHT_POOL_CUSTODY, vault_config.deposit_mint.as_ref()],
        bump,
    )]
    pub light_pool_custody: UncheckedAccount<'info>,
    #[account(
        mut,
        constraint = recipient_token_account.owner == spend_authority.key() @ ReservedError::UnauthorizedSpend,
        constraint = recipient_token_account.mint == vault_config.deposit_mint @ ReservedError::VaultMintMismatch,
    )]
    pub recipient_token_account: Account<'info, TokenAccount>,
    #[account(constraint = mint.key() == vault_config.deposit_mint @ ReservedError::VaultMintMismatch)]
    pub mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
    /// CHECK: optional co-signer for institutional attestation.
    pub auditor_attestor: UncheckedAccount<'info>,
}

#[inline]
fn public_amount_commitment_v1(
    amount: u64,
    vault_cfg: &Pubkey,
    note_sequence: u64,
    deposit_mint: &Pubkey,
    chain_id_hash: &[u8; 32],
    spend_authority: &Pubkey,
    program_id: &Pubkey,
) -> [u8; 32] {
    hashv(&[
        AMOUNT_COMMITMENT_SCHEMA_V1,
        &amount.to_le_bytes(),
        vault_cfg.as_ref(),
        &note_sequence.to_le_bytes(),
        deposit_mint.as_ref(),
        chain_id_hash.as_ref(),
        spend_authority.as_ref(),
        program_id.as_ref(),
    ])
    .to_bytes()
}

pub fn unshield_zk_handler<'info>(
    ctx: Context<'_, '_, '_, 'info, UnshieldZk<'info>>,
    amount: u64,
    expected_policy_commitment: [u8; 32],
    account_meta: CompressedAccountMetaBurn,
    current_note: ReservedShieldLeaf,
    proof: ValidityProof,
) -> Result<()> {
    require!(amount > 0, ReservedError::ZeroDeposit);

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

    let vault_key = ctx.accounts.vault_config.key();
    let expected_amount_commitment = public_amount_commitment_v1(
        amount,
        &vault_key,
        current_note.note_sequence,
        &ctx.accounts.vault_config.deposit_mint,
        &ctx.accounts.vault_config.chain_id_hash,
        &current_note.owner,
        &crate::ID,
    );
    require!(
        current_note.amount_commitment == expected_amount_commitment,
        ReservedError::AmountCommitmentMismatch
    );

    let burn_account = LightAccount::<ReservedShieldLeaf>::new_burn(
        &crate::ID,
        &account_meta,
        current_note,
    )
    .map_err(|_| ReservedError::LightCompress)?;

    let light_cpi_accounts = CpiAccounts::new(
        ctx.accounts.fee_payer.as_ref(),
        ctx.remaining_accounts,
        LIGHT_CPI_SIGNER,
    );

    LightSystemProgramCpi::new_cpi(LIGHT_CPI_SIGNER, proof)
        .with_light_account(burn_account)
        .map_err(|_| ReservedError::LightCompress)?
        .invoke(light_cpi_accounts)
        .map_err(|_| ReservedError::LightCompress)?;

    let mint_key = ctx.accounts.vault_config.deposit_mint.key();
    let light_pool_custody_bump = ctx.bumps.light_pool_custody;
    let signer_seeds: &[&[&[u8]]] = &[&[
        SEED_LIGHT_POOL_CUSTODY,
        mint_key.as_ref(),
        &[light_pool_custody_bump],
    ]];
    let cpi = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        Transfer {
            from: ctx.accounts.light_pool_token_account.to_account_info(),
            to: ctx.accounts.recipient_token_account.to_account_info(),
            authority: ctx.accounts.light_pool_custody.to_account_info(),
        },
        signer_seeds,
    );
    token::transfer(cpi, amount)?;

    Ok(())
}
