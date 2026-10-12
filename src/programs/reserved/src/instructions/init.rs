//! Bootstraps the **public ledger phase**: SPL vault + global params.
//! Shielded / compressed economics attach later via `shield_into_compressed`.

use crate::constants::{SEED_PUBLIC_ESCROW, SEED_VAULT_CONFIG};
use crate::state::VaultConfig;
use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{Mint, Token, TokenAccount};

#[derive(Accounts)]
pub struct InitializeVault<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// Governance or deployer; rotates auditor policy off-chain / via multisig flow.
    pub authority: Signer<'info>,
    /// `VaultConfig` init space must match full struct (incl. `bunker_liquidity_root`, `bunker_shadow_sequence`)
    /// so clients avoid account-size / decode mismatches vs older deployments.
    #[account(
        init,
        payer = payer,
        space = VaultConfig::ACCOUNT_INIT_SPACE,
        seeds = [SEED_VAULT_CONFIG, deposit_mint.key().as_ref()],
        bump
    )]
    pub vault_config: Account<'info, VaultConfig>,
    /// Existing SPL mint (e.g. Devnet USDC). Must already be initialized on-chain — this struct does **not** create the mint.
    pub deposit_mint: Account<'info, Mint>,
    /// CHECK: PDA authority for the public escrow ATA (no data; signs via seeds in CPI).
    #[account(
        seeds = [SEED_PUBLIC_ESCROW, deposit_mint.key().as_ref()],
        bump
    )]
    pub vault_authority: UncheckedAccount<'info>,
    #[account(
        init,
        payer = payer,
        associated_token::mint = deposit_mint,
        associated_token::authority = vault_authority,
        associated_token::token_program = token_program,
    )]
    pub vault_token_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn initialize_vault_handler(
    ctx: Context<InitializeVault>,
    chain_id_hash: [u8; 32],
    light_state_tree: Pubkey,
) -> Result<()> {
    let cfg = &mut ctx.accounts.vault_config;
    cfg.authority = ctx.accounts.authority.key();
    cfg.deposit_mint = ctx.accounts.deposit_mint.key();
    cfg.bump_vault = ctx.bumps.vault_config;
    cfg.bump_escrow = ctx.bumps.vault_authority;
    cfg.version = 1;
    cfg.light_state_tree = light_state_tree;
    cfg.chain_id_hash = chain_id_hash;
    cfg.bunker_liquidity_root = [0u8; 32];
    cfg.bunker_shadow_sequence = 0;
    Ok(())
}