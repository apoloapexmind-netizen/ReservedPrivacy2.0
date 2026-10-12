//! **Public egress**: SPL from escrow vault ATA back to the vault **authority’s** ATA.
//! Uses hash-openings for the outer instruction (see [`crate::instructions::deposit_public`]).

use crate::bunker::{
    bunker_withdraw_commitment_v1, parse_bunker_opening, roll_bunker_liquidity_root,
};
use crate::constants::{SEED_PUBLIC_ESCROW, SEED_VAULT_CONFIG};
use crate::errors::ReservedError;
use crate::state::VaultConfig;
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

#[derive(Accounts)]
pub struct WithdrawPublic<'info> {
    #[account(
        mut,
        seeds = [SEED_VAULT_CONFIG, vault_config.deposit_mint.as_ref()],
        bump = vault_config.bump_vault,
        has_one = authority @ ReservedError::UnauthorizedSpend,
    )]
    pub vault_config: Account<'info, VaultConfig>,
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        mut,
        constraint = recipient_token_account.owner == authority.key() @ ReservedError::UnauthorizedSpend,
        constraint = recipient_token_account.mint == vault_config.deposit_mint @ ReservedError::VaultMintMismatch,
    )]
    pub recipient_token_account: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = vault_token_account.owner == vault_authority.key(),
        constraint = vault_token_account.mint == vault_config.deposit_mint @ ReservedError::VaultMintMismatch,
    )]
    pub vault_token_account: Account<'info, TokenAccount>,
    /// CHECK: escrow PDA (signs CPI out of vault).
    #[account(
        seeds = [SEED_PUBLIC_ESCROW, vault_config.deposit_mint.as_ref()],
        bump = vault_config.bump_escrow,
    )]
    pub vault_authority: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

pub fn withdraw_public_handler(
    ctx: Context<WithdrawPublic>,
    amount_commitment: [u8; 32],
    amount_opening: Vec<u8>,
) -> Result<()> {
    require!(
        amount_commitment != [0u8; 32],
        ReservedError::EmptyAmountCommitment
    );
    let (amount, blinding) = parse_bunker_opening(&amount_opening)?;
    require!(amount > 0, ReservedError::ZeroDeposit);

    let vc = &ctx.accounts.vault_config;
    let expected = bunker_withdraw_commitment_v1(
        amount,
        &blinding,
        &ctx.accounts.authority.key(),
        &vc.key(),
        &vc.deposit_mint,
        &vc.chain_id_hash,
        &crate::ID,
    );
    require!(
        expected == amount_commitment,
        ReservedError::InvalidBunkerOpening
    );

    let vault_config = &ctx.accounts.vault_config;
    let mint = vault_config.deposit_mint.key();
    let bump_escrow = vault_config.bump_escrow;
    let signer_seeds: &[&[&[u8]]] = &[&[
        SEED_PUBLIC_ESCROW,
        mint.as_ref(),
        &[bump_escrow],
    ]];
    let cpi = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        Transfer {
            from: ctx.accounts.vault_token_account.to_account_info(),
            to: ctx.accounts.recipient_token_account.to_account_info(),
            authority: ctx.accounts.vault_authority.to_account_info(),
        },
        signer_seeds,
    );
    token::transfer(cpi, amount)?;

    let cfg = &mut ctx.accounts.vault_config;
    cfg.bunker_liquidity_root = roll_bunker_liquidity_root(
        &cfg.bunker_liquidity_root,
        b"wdr",
        &amount_commitment,
        &ctx.accounts.authority.key(),
    );
    Ok(())
}