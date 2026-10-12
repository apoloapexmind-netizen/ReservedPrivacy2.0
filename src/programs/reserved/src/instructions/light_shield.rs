//! **RESERVED Protocol -- shield:** auditable auditor gate + SPL debit from escrow (PDA signs via
//! `invoke_signed` inside SPL `transfer`), then CPI to Light Protocol v2 with a client **validity
//! proof** and **`remaining_accounts`** aligned with `CpiAccounts::new`.

use crate::constants::{
    AMOUNT_COMMITMENT_SCHEMA_V1, SEED_AUDITOR_POLICY, SEED_LIGHT_POOL_CUSTODY, SEED_NOTE_HEAD,
    SEED_PUBLIC_ESCROW, SEED_RESERVED_SHIELD, SEED_VAULT_CONFIG,
};
use crate::errors::ReservedError;
use crate::state::{AuditorPolicy, UserNoteHead, VaultConfig};
use crate::{ReservedShieldLeaf, LIGHT_CPI_SIGNER};
use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::hashv;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use light_compressed_account::address::derive_address_legacy;
use light_compressed_account::Pubkey as LightPubkey;
use light_sdk::account::LightAccount;
use light_sdk::address::AddressSeed;
use light_sdk::address::v2::derive_address;
use light_sdk::constants::{
    ACCOUNT_COMPRESSION_PROGRAM_ID, LIGHT_SYSTEM_PROGRAM_ID, LIGHT_TOKEN_PROGRAM_ID,
};
use light_sdk::cpi::invoke::InvokeLightSystemProgram;
use light_sdk::cpi::v2::{CpiAccounts, LightSystemProgramCpi};
use light_sdk::instruction::{PackedAddressTreeInfo, ValidityProof};
use light_sdk::LightCpiInstruction;
use light_sdk::PackedAddressTreeInfoExt;

#[derive(Accounts)]
#[instruction(
    amount: u64,
    amount_commitment: [u8; 32],
    next_anchor_hint: [u8; 32],
    expected_policy_commitment: [u8; 32],
    output_tree_index: u8,
    address_seed: [u8; 32],
    compressed_address: [u8; 32],
    address_merkle_tree_pubkey_index: u8,
)]
pub struct ShieldIntoCompressed<'info> {
    /// Pays protocol / Light fees; typically the same key as `spend_authority`.
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
    /// CHECK: escrow PDA (SPL authority).
    #[account(
        seeds = [SEED_PUBLIC_ESCROW, vault_config.deposit_mint.as_ref()],
        bump = vault_config.bump_escrow,
    )]
    pub vault_authority: UncheckedAccount<'info>,
    /// SPL destination for this leg - must be the custody ATA expected by the bundled Light / compress flow.
    #[account(
        mut,
        constraint = light_pool_token_account.mint == vault_config.deposit_mint @ ReservedError::LightPoolDestination,
    )]
    pub light_pool_token_account: Account<'info, TokenAccount>,
    #[account(constraint = mint.key() == vault_config.deposit_mint @ ReservedError::VaultMintMismatch)]
    pub mint: Account<'info, anchor_spl::token::Mint>,
    pub token_program: Program<'info, Token>,
    /// When auditor_policy.auditor_pubkey is non-default, this account must be a signer and match it.
    /// CHECK: optional co-signer for institutional attestation.
    pub auditor_attestor: UncheckedAccount<'info>,
}

/// Integrity constraint (v1 schema): the compressed leaf amount_commitment must be the SHA256
/// Merkle-Damgard digest of a fixed public preimage so that the SPL leg cannot register an
/// inconsistent amount in the ZK-compressed state for the same shield call.
///
/// Preimage: schema || le64(amount) || vault_cfg_pubkey || le64(note_sequence) || mint ||
/// chain_id_hash || spend_authority || program_id
///
/// Institutional note: This binds cleartext economic amount on the ledger to the note field.
/// Private Pedersen-style amounts belong in a future version with proof of consistency on-chain.
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

#[inline]
fn pubkey_from_literal(bytes: &[u8; 32]) -> Pubkey {
    Pubkey::new_from_array(*bytes)
}

/// Only custody ATAs owned by core Light programs or our custodian PDA are accepted.
fn enforce_light_pool_token_owner(vault_cfg: &Account<VaultConfig>, pool_owner: Pubkey) -> Result<()> {
    let light_system = pubkey_from_literal(&LIGHT_SYSTEM_PROGRAM_ID);
    let light_token = pubkey_from_literal(&LIGHT_TOKEN_PROGRAM_ID);
    let compression = pubkey_from_literal(&ACCOUNT_COMPRESSION_PROGRAM_ID);
    let (custody_pda, _) = Pubkey::find_program_address(
        &[
            SEED_LIGHT_POOL_CUSTODY,
            vault_cfg.deposit_mint.as_ref(),
        ],
        &crate::ID,
    );
    let ok = pool_owner == light_system
        || pool_owner == light_token
        || pool_owner == compression
        || pool_owner == custody_pda;
    require!(ok, ReservedError::InvalidLightPoolOwner);
    Ok(())
}

pub fn shield_into_compressed_handler<'info>(
    ctx: Context<'_, '_, '_, 'info, ShieldIntoCompressed<'info>>,
    amount: u64,
    amount_commitment: [u8; 32],
    next_anchor_hint: [u8; 32],
    expected_policy_commitment: [u8; 32],
    output_tree_index: u8,
    address_seed: [u8; 32],
    compressed_address: [u8; 32],
    address_merkle_tree_pubkey_index: u8,
    address_tree_info: PackedAddressTreeInfo,
    proof: ValidityProof,
) -> Result<()> {
    require!(amount > 0, ReservedError::ZeroDeposit);
    require!(amount_commitment != [0u8; 32], ReservedError::EmptyAmountCommitment);

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

    let head = &ctx.accounts.user_note_head;
    let seq = head.note_sequence;
    let vault_key = ctx.accounts.vault_config.key();
    let expected_cm = public_amount_commitment_v1(
        amount,
        &vault_key,
        seq,
        &ctx.accounts.vault_config.deposit_mint,
        &ctx.accounts.vault_config.chain_id_hash,
        &ctx.accounts.spend_authority.key(),
        &crate::ID,
    );
    require!(
        amount_commitment == expected_cm,
        ReservedError::AmountCommitmentMismatch
    );

    enforce_light_pool_token_owner(
        &ctx.accounts.vault_config,
        ctx.accounts.light_pool_token_account.owner,
    )?;

    let esc = [
        SEED_PUBLIC_ESCROW,
        ctx.accounts.vault_config.deposit_mint.as_ref(),
        &[ctx.accounts.vault_config.bump_escrow],
    ];
    let signer_seeds: &[&[&[u8]]] = &[&esc[..]];

    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault_token_account.to_account_info(),
                to: ctx.accounts.light_pool_token_account.to_account_info(),
                authority: ctx.accounts.vault_authority.to_account_info(),
            },
            signer_seeds,
        ),
        amount,
    )?;

    let light_cpi_accounts = CpiAccounts::new(
        ctx.accounts.fee_payer.as_ref(),
        ctx.remaining_accounts,
        LIGHT_CPI_SIGNER,
    );

    // `PackedAddressTreeInfo` carries packed indices for the **address** Merkle tree + queue.
    // `output_tree_index` must index the **state** Merkle tree only; overlapping indices yield
    // LIGHT custom 6042 (`StateMerkleTreeAccountDiscriminatorMismatch`) when the prover layout
    // puts state and address trees at different packed positions than the leaf expects.
    require!(
        output_tree_index != address_tree_info.address_merkle_tree_pubkey_index,
        ReservedError::LightTreeIndexConflict
    );
    require!(
        output_tree_index != address_tree_info.address_queue_pubkey_index,
        ReservedError::LightTreeIndexConflict
    );

    require!(
        address_merkle_tree_pubkey_index
            == address_tree_info.address_merkle_tree_pubkey_index,
        ReservedError::AddressTreeIndexMismatch
    );

    // Client supplies `address_seed` + `compressed_address` (matches TS / prover); Light System
    // Program validates the pair — we avoid on-chain `derive_address` (light-sdk version drift).
    // IMPORTANT: second arg is `assigned_account_index` in the CPI batch, not the address-tree slot.
    // This instruction writes exactly one new compressed account, so the assigned account index is 0.
    let new_address_params = address_tree_info.into_new_address_params_assigned_packed(
        AddressSeed::from(address_seed),
        Some(0),
    );

    // `output_tree_index`: packed index of the **state** Merkle tree in `remaining_accounts` after
    // Light system accounts (from client `PackedAccounts`); must not point at the address Merkle tree.
    let mut leaf = LightAccount::<ReservedShieldLeaf>::new_init(
        &crate::ID,
        Some(compressed_address),
        output_tree_index,
    );
    leaf.owner = ctx.accounts.spend_authority.key();
    leaf.amount_commitment = amount_commitment;
    leaf.note_sequence = seq;
    leaf.ovk_binding = head.ovk_binding;

    let resolved_tree = address_tree_info
        .get_tree_pubkey(&light_cpi_accounts)
        .map_err(|_| ReservedError::LightCompress)?;
    let (expected_compressed_address_v2, expected_address_seed) = derive_address(
        &[
            SEED_RESERVED_SHIELD,
            ctx.accounts.spend_authority.key().as_ref(),
            vault_key.as_ref(),
            &seq.to_le_bytes(),
        ],
        &resolved_tree,
        &crate::ID,
    );
    let expected_compressed_address_legacy =
        derive_address_legacy(&LightPubkey::from(resolved_tree), &address_seed)
            .map_err(|_| ReservedError::LightCompress)?;
    let expected_address_seed: [u8; 32] = expected_address_seed.into();
    msg!("RESERVED_DEBUG: address_seed: {:?}", address_seed);
    msg!("RESERVED_DEBUG: compressed_address: {:?}", compressed_address);
    msg!("RESERVED_DEBUG: resolved_tree: {:?}", resolved_tree);
    msg!(
        "RESERVED_DEBUG: expected_address_seed: {:?}",
        expected_address_seed
    );
    msg!(
        "RESERVED_DEBUG: expected_compressed_address_v2: {:?}",
        expected_compressed_address_v2
    );
    msg!(
        "RESERVED_DEBUG: expected_compressed_address_legacy: {:?}",
        expected_compressed_address_legacy
    );
    require!(
        address_seed == expected_address_seed,
        ReservedError::AddressSeedMismatch
    );
    require!(
        compressed_address == expected_compressed_address_v2
            || compressed_address == expected_compressed_address_legacy,
        ReservedError::CompressedAddressMismatch
    );

    // Match the official Light V2 builder order so the account output is attached
    // before the assigned new-address metadata references account index 0.
    LightSystemProgramCpi::new_cpi(LIGHT_CPI_SIGNER, proof)
        .with_light_account(leaf)
        .map_err(|_| ReservedError::LightCompress)?
        .with_new_addresses(&[new_address_params])
        .invoke(light_cpi_accounts)
        .map_err(|_| ReservedError::LightCompress)?;

    let head_mut = &mut ctx.accounts.user_note_head;
    head_mut.note_sequence = seq
        .checked_add(1)
        .ok_or(ReservedError::AmountOverflow)?;
    head_mut.latest_compressed_anchor = next_anchor_hint;

    Ok(())
}
