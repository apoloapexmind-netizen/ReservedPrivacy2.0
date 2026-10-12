use anchor_lang::prelude::*;

#[error_code]
pub enum ReservedError {
    /// Spend authority signature missing for a state transition that moves value.
    #[msg("E_UNAUTHORIZED_SPEND")]
    UnauthorizedSpend,
    /// Viewing-key commitment does not match expected derivation binding.
    #[msg("E_VIEWING_KEY_BINDING")]
    ViewingKeyBinding,
    /// Auditor slot is unset but instruction requires auditor capability.
    #[msg("E_AUDITOR_REQUIRED")]
    AuditorRequired,
    /// Attempt to strip auditor policy while locked funds exist (invariant).
    #[msg("E_AUDITOR_POLICY_LOCKED")]
    AuditorPolicyLocked,
    /// SPL ingress amount or decimals inconsistent with vault mint.
    #[msg("E_VAULT_MINT_MISMATCH")]
    VaultMintMismatch,
    /// Light Protocol CPI not yet wired or merkle proof verify failed at program boundary.
    #[msg("E_LIGHT_COMPRESS")]
    LightCompress,
    /// `output_tree_index` collides with address-tree packed indices (state vs address Merkle discriminator / LIGHT 6042).
    #[msg("E_LIGHT_TREE_INDEX")]
    LightTreeIndexConflict,
    /// Zero-value ingress disallowed.
    #[msg("E_ZERO_DEPOSIT")]
    ZeroDeposit,
    /// Arithmetic defensive check.
    #[msg("E_AMOUNT_OVERFLOW")]
    AmountOverflow,
    /// On-chain policy commitment does not match the value supplied in this instruction.
    #[msg("E_AUDITOR_POLICY_MISMATCH")]
    AuditorPolicyMismatch,
    /// A registered auditor must co-sign shield when `auditor_pubkey` is set.
    #[msg("E_AUDITOR_ATTESTATION")]
    AuditorAttestationRequired,
    /// SPL destination for shield is invalid (mint / authority).
    #[msg("E_LIGHT_POOL_DESTINATION")]
    LightPoolDestination,
    /// `amount_commitment` must be non-zero (empty leaf field disallowed for v1 binding).
    #[msg("E_AMOUNT_COMMITMENT_EMPTY")]
    EmptyAmountCommitment,
    /// `amount_commitment` does not match the canonical hash of SPL amount + vault context (economic binding).
    #[msg("E_AMOUNT_COMMITMENT_MISMATCH")]
    AmountCommitmentMismatch,
    /// Client `address_seed` must equal Light `derive_address` for the same tree + seeds (avoids AddressDerivationMismatch / 0x17a0).
    #[msg("E_ADDRESS_SEED_MISMATCH")]
    AddressSeedMismatch,
    /// Client `compressed_address` must equal the Light-derived address for the canonical seed + tree.
    #[msg("E_COMPRESSED_ADDRESS_MISMATCH")]
    CompressedAddressMismatch,
    /// `address_merkle_tree_pubkey_index` must match `PackedAddressTreeInfo.address_merkle_tree_pubkey_index` (packed address Merkle slot, not state tree index 0).
    #[msg("E_ADDRESS_TREE_INDEX_MISMATCH")]
    AddressTreeIndexMismatch,
    /// `light_pool_token_account` owner is not a Light program id or protocol-authorized custodian PDA.
    #[msg("E_INVALID_LIGHT_POOL_OWNER")]
    InvalidLightPoolOwner,
    /// Egress CPI + nullifiers not yet live — IDL previews planned Phase 2 surface.
    #[msg("Egress logic planned for Phase 2; nullifier set validation in roadmap")]
    ContractLogicNotYetLive,
    /// Bunker `amount_opening` cannot be parsed or does not match `amount_commitment`.
    #[msg("E_INVALID_BUNKER_OPENING")]
    InvalidBunkerOpening,
}