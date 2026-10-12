//! Phase 2 **egress stub** (`decompress_to_spl_preview`): IDL-visible withdrawal rail.
//!
//! Enforces account surface parity with planned `decompress_to_spl`; execution returns
//! `ReservedError::ContractLogicNotYetLive` until nullifier semantics + Light Merkle egress land.

use crate::constants::{
    SEED_AUDITOR_POLICY, SEED_NOTE_HEAD, SEED_PUBLIC_ESCROW, SEED_VAULT_CONFIG,
};
use crate::errors::ReservedError;
use crate::state::{AuditorPolicy, UserNoteHead, VaultConfig};
use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

#[derive(Accounts)]
pub struct DecompressToSplPreview<'info> {
    #[account(mut)]
    pub fee_payer: Signer<'info>,
    #[account(mut)]
    pub spend_authority: Signer<'info>,
    #[account(
        mut,
        seeds = [SEED_NOTE_HEAD, spend_authority.key().as_ref(), vault_config.key().as_ref()],
        bump = user_note_head.bump,
        constraint = user_note_head.spend_authority == spend_authority.key() @ ReservedError::UnauthorizedSpend,
    )]
    pub user_note_head: Account<'info, UserNoteHead>,
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
        constraint = vault_token_account.mint == vault_config.deposit_mint @ ReservedError::VaultMintMismatch,
        constraint = vault_token_account.owner == vault_authority.key() @ ReservedError::VaultMintMismatch,
    )]
    pub vault_token_account: Account<'info, TokenAccount>,
    /// CHECK: This is the authority of the vault, validated via PDA seeds in the implementation.
    #[account(
        seeds = [SEED_PUBLIC_ESCROW, vault_config.deposit_mint.as_ref()],
        bump = vault_config.bump_escrow,
    )]
    pub vault_authority: UncheckedAccount<'info>,
    #[account(mut, constraint = light_pool_token_account.mint == vault_config.deposit_mint @ ReservedError::LightPoolDestination)]
    pub light_pool_token_account: Account<'info, TokenAccount>,
    /// Public SPL recipient for egress (preview only; fills IDL egress surface).
    #[account(mut, constraint = recipient_token_account.mint == vault_config.deposit_mint @ ReservedError::VaultMintMismatch)]
    pub recipient_token_account: Account<'info, TokenAccount>,
    #[account(constraint = mint.key() == vault_config.deposit_mint @ ReservedError::VaultMintMismatch)]
    pub mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
}

pub fn decompress_to_spl_preview_handler(_ctx: Context<DecompressToSplPreview>) -> Result<()> {
    err!(ReservedError::ContractLogicNotYetLive)
}
