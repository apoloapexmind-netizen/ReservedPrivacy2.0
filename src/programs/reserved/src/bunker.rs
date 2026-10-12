//! Commitment-only bookkeeping for bunker liquidity (no cleartext `u64` balance in `VaultConfig`).
//!
//! **Explorer / RPC caveat:** SPL `Transfer` still encodes the amount in the inner CPI; observers
//! decoding token instructions will see the moved quantity. The Anchor *outer* instruction uses
//! `amount_commitment` + `amount_opening` so high-level IDL decodes do not surface a plain `u64`.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::hashv;

use crate::constants::{
    BUNKER_DEPOSIT_OPENING_SCHEMA_V1, BUNKER_LEDGER_ROLL_SCHEMA_V1,
    BUNKER_WITHDRAW_OPENING_SCHEMA_V1,
};

pub const BUNKER_OPENING_LEN: usize = 40;

#[inline]
pub fn parse_bunker_opening(opening: &[u8]) -> Result<(u64, [u8; 32])> {
    require!(
        opening.len() == BUNKER_OPENING_LEN,
        crate::errors::ReservedError::InvalidBunkerOpening
    );
    let mut amt = [0u8; 8];
    amt.copy_from_slice(&opening[0..8]);
    let amount = u64::from_le_bytes(amt);
    let mut blinding = [0u8; 32];
    blinding.copy_from_slice(&opening[8..40]);
    Ok((amount, blinding))
}

#[inline]
pub fn bunker_deposit_commitment_v1(
    amount: u64,
    blinding: &[u8; 32],
    depositor: &Pubkey,
    vault_cfg: &Pubkey,
    mint: &Pubkey,
    chain_id_hash: &[u8; 32],
    program_id: &Pubkey,
) -> [u8; 32] {
    hashv(&[
        BUNKER_DEPOSIT_OPENING_SCHEMA_V1,
        &amount.to_le_bytes(),
        blinding.as_ref(),
        depositor.as_ref(),
        vault_cfg.as_ref(),
        mint.as_ref(),
        chain_id_hash.as_ref(),
        program_id.as_ref(),
    ])
    .to_bytes()
}

#[inline]
pub fn bunker_withdraw_commitment_v1(
    amount: u64,
    blinding: &[u8; 32],
    authority: &Pubkey,
    vault_cfg: &Pubkey,
    mint: &Pubkey,
    chain_id_hash: &[u8; 32],
    program_id: &Pubkey,
) -> [u8; 32] {
    hashv(&[
        BUNKER_WITHDRAW_OPENING_SCHEMA_V1,
        &amount.to_le_bytes(),
        blinding.as_ref(),
        authority.as_ref(),
        vault_cfg.as_ref(),
        mint.as_ref(),
        chain_id_hash.as_ref(),
        program_id.as_ref(),
    ])
    .to_bytes()
}

/// Rolling digest over ingress / egress events. Amounts are not stored — only commitments and roots.
#[inline]
pub fn roll_bunker_liquidity_root(
    prev_root: &[u8; 32],
    leg_tag: &[u8],
    amount_commitment: &[u8; 32],
    party: &Pubkey,
) -> [u8; 32] {
    let base = if *prev_root == [0u8; 32] {
        hashv(&[b"RESV/bunker_liq_genesis:v1"]).to_bytes()
    } else {
        *prev_root
    };
    hashv(&[
        BUNKER_LEDGER_ROLL_SCHEMA_V1,
        base.as_ref(),
        leg_tag,
        amount_commitment.as_ref(),
        party.as_ref(),
    ])
    .to_bytes()
}
