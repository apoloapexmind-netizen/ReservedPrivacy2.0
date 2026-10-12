//! **Public ingress**: moves SPL from the user's plain ATA into the protocol escrow.
//! Outer args use hash-openings (no plain `u64` in the IDL). SPL inner transfers remain
//! observable to anyone decoding Token instructions.

use crate::bunker::{
    bunker_deposit_commitment_v1, parse_bunker_opening, roll_bunker_liquidity_root,
};
use crate::constants::SEED_PUBLIC_ESCROW;
use crate::constants::SEED_VAULT_CONFIG;
use crate::errors::ReservedError;
use crate::state::VaultConfig;
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

#[derive(Accounts)]
pub struct DepositPublic<'info> {
    #[account(mut)]
    pub depositor: Signer<'info>,
    #[account(
        mut,
        constraint = user_token_account.owner == depositor.key(),
        constraint = user_token_account.mint == vault_config.deposit_mint @ ReservedError::VaultMintMismatch,
    )]
    pub user_token_account: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = vault_token_account.mint == vault_config.deposit_mint @ ReservedError::VaultMintMismatch,
        constraint = vault_token_account.owner == vault_authority.key(),
    )]
    pub vault_token_account: Account<'info, TokenAccount>,
    #[account(
        mut,
        seeds = [SEED_VAULT_CONFIG, vault_config.deposit_mint.as_ref()],
        bump = vault_config.bump_vault,
    )]
    pub vault_config: Account<'info, VaultConfig>,
    /// CHECK: escrow PDA (owns `vault_token_account`).
    #[account(
        seeds = [SEED_PUBLIC_ESCROW, vault_config.deposit_mint.as_ref()],
        bump = vault_config.bump_escrow,
    )]
    pub vault_authority: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

pub fn deposit_public_handler(
    ctx: Context<DepositPublic>,
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
    let expected = bunker_deposit_commitment_v1(
        amount,
        &blinding,
        &ctx.accounts.depositor.key(),
        &vc.key(),
        &vc.deposit_mint,
        &vc.chain_id_hash,
        &crate::ID,
    );
    require!(
        expected == amount_commitment,
        ReservedError::InvalidBunkerOpening
    );

    let cpi = CpiContext::new(
        ctx.accounts.token_program.to_account_info(),
        Transfer {
            from: ctx.accounts.user_token_account.to_account_info(),
            to: ctx.accounts.vault_token_account.to_account_info(),
            authority: ctx.accounts.depositor.to_account_info(),
        },
    );
    token::transfer(cpi, amount)?;

    let cfg = &mut ctx.accounts.vault_config;
    cfg.bunker_liquidity_root = roll_bunker_liquidity_root(
        &cfg.bunker_liquidity_root,
        b"dep",
        &amount_commitment,
        &ctx.accounts.depositor.key(),
    );
    Ok(())
}