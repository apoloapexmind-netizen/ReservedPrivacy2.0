//! Domain separation and PDA seeds.

pub const PROTOCOL_DOMAIN_LABEL: &[u8] = b"RESERVED/01/SOLANA";
pub const SEED_VAULT_CONFIG: &[u8] = b"vault_cfg";
pub const SEED_PUBLIC_ESCROW: &[u8] = b"pub_escrow";
pub const SEED_NOTE_HEAD: &[u8] = b"note_head";
pub const SEED_AUDITOR_POLICY: &[u8] = b"audit_pol";

/// PDA seed for a protocol-authorized SPL custodian that may own `light_pool_token_account`
/// when the pool is not held directly under a Light program id (institutional deployment option).
pub const SEED_LIGHT_POOL_CUSTODY: &[u8] = b"light_pool_custody";

/// Address derivation domain for shield notes:
/// `reserved_shield || spend_authority || vault_config || le64(note_sequence)`.
pub const SEED_RESERVED_SHIELD: &[u8] = b"reserved_shield";

/// Domain tag for v1 canonical binding: SPL `amount` transferred in `shield_into_compressed`
/// must match `amount_commitment` in the compressed leaf (SHA256 domain-separated preimage).
///
/// **Semantics:** This is an *auditable ledger binding*, not a hidden Pedersen note amount.
/// Off-chain ZK circuits that use a different commitment scheme must align their public inputs
/// with this 32-byte value when interacting with this program version.
pub const AMOUNT_COMMITMENT_SCHEMA_V1: &[u8] = b"RESV/amount_leaf:v1";

/// Opening hash domain for bunker deposits (outer instruction hides cleartext `u64` in IDL).
pub const BUNKER_DEPOSIT_OPENING_SCHEMA_V1: &[u8] = b"RESV/bunker_dep:v1";

/// Opening hash domain for bunker withdrawals (authority-signed leg).
pub const BUNKER_WITHDRAW_OPENING_SCHEMA_V1: &[u8] = b"RESV/bunker_wdr:v1";

/// Ledger roll domain for `VaultConfig::bunker_liquidity_root`.
pub const BUNKER_LEDGER_ROLL_SCHEMA_V1: &[u8] = b"RESV/bunker_roll:v1";
