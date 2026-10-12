//! Binds **viewing-key commitments** to a `spend_authority` without ever uploading IVK/OVK.
//! The spend key remains a distinct secret: only signatures from `spend_authority` may
//! authorize **`shield_into_compressed`** and unshield. Observers with IVK (off-chain) see
//! incoming flow; auditors combine OVK policy with `AuditorPolicy::auditor_pubkey`.

use crate::constants::{SEED_NOTE_HEAD, SEED_VAULT_CONFIG};
use crate::errors::ReservedError;
use crate::state::{UserNoteHead, VaultConfig};
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct RegisterUserNoteHead<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// Distinct from IVK: this is the Solana signing key for spends / nullifiers / CPI auth.
    pub spend_authority: Signer<'info>,
    #[account(
        seeds = [SEED_VAULT_CONFIG, vault_config.deposit_mint.as_ref()],
        bump = vault_config.bump_vault,
    )]
    pub vault_config: Account<'info, VaultConfig>,
    #[account(
        init,
        payer = payer,
        space = UserNoteHead::SIZE,
        seeds = [SEED_NOTE_HEAD, spend_authority.key().as_ref(), vault_config.key().as_ref()],
        bump
    )]
    pub user_note_head: Account<'info, UserNoteHead>,
    pub system_program: Program<'info, System>,
}

pub fn register_user_note_head_handler(
    ctx: Context<RegisterUserNoteHead>,
    ivk_binding: [u8; 32],
    ovk_binding: [u8; 32],
) -> Result<()> {
    require!(
        ivk_binding != [0u8; 32] && ovk_binding != [0u8; 32],
        ReservedError::ViewingKeyBinding
    );
    let h = &mut ctx.accounts.user_note_head;
    h.spend_authority = ctx.accounts.spend_authority.key();
    h.ivk_binding = ivk_binding;
    h.ovk_binding = ovk_binding;
    h.note_sequence = 0;
    h.latest_compressed_anchor = [0u8; 32];
    h.bump = ctx.bumps.user_note_head;
    Ok(())
}
