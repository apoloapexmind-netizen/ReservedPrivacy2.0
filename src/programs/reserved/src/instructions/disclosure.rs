//! **Selective disclosure policy**: binds an **auditor identity** (`auditor_pubkey`)
//! without granting spend authority. Institutional workflows use this slot to enforce
//! that ciphertext / proofs can be opened to a named party while spend keys remain segregated.
//!
//! This is the on-chain counterpart to Zcash **outgoing cipher** visibility for auditors,
//! not a mixer-wide "everyone sees everything" policy.

use crate::constants::{SEED_AUDITOR_POLICY, SEED_VAULT_CONFIG};
use crate::errors::ReservedError;
use crate::state::{AuditorPolicy, VaultConfig};
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct UpsertAuditorPolicy<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        seeds = [SEED_VAULT_CONFIG, vault_config.deposit_mint.as_ref()],
        bump = vault_config.bump_vault,
        constraint = vault_config.authority == authority.key(),
    )]
    pub vault_config: Account<'info, VaultConfig>,
    #[account(
        init_if_needed,
        payer = authority,
        space = AuditorPolicy::SIZE,
        seeds = [SEED_AUDITOR_POLICY, vault_config.key().as_ref()],
        bump
    )]
    pub auditor_policy: Account<'info, AuditorPolicy>,
    pub system_program: Program<'info, System>,
}

pub fn upsert_auditor_policy_handler(
    ctx: Context<UpsertAuditorPolicy>,
    auditor_pubkey: Pubkey,
    policy_commitment: [u8; 32],
    unix_ts: i64,
) -> Result<()> {
    let ap = &mut ctx.accounts.auditor_policy;
    ap.authority = ctx.accounts.authority.key();
    ap.auditor_pubkey = auditor_pubkey;
    ap.policy_commitment = policy_commitment;
    ap.last_rotation_ts = unix_ts;
    ap.bump = ctx.bumps.auditor_policy;
    ctx.accounts.vault_config.version = ctx
        .accounts
        .vault_config
        .version
        .checked_add(1)
        .ok_or(ReservedError::AmountOverflow)?;
    Ok(())
}
