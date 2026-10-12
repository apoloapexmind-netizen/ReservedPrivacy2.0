# Reserved: Private Bearer Cash Rail on Solana

**Private, asynchronous, bearer digital cash.**

Reserved is a high-performance privacy protocol on Solana built to make digital cash behave like a bearer asset. By leveraging **ZK-Compression with Light Protocol V2**, Reserved enables asset transfers whose economic value can move across the network **without leaving a direct on-chain link between sender and receiver**.

At its core, Reserved combines compressed state, zero-knowledge validity proofs, and a local-first note wallet model to deliver **private, unlinked transfer flows** with the performance profile expected from modern Solana infrastructure.

---

## Introduction

Reserved is designed as a next-generation privacy rail for Solana. Instead of treating privacy as an overlay or wallet-only trick, it treats it as a **native state transition problem**:

- value is deposited into a compressed private note,
- the note becomes the spendable bearer object,
- and redemption is authorized by possession of a cryptographic secret rather than by the identity of the original wallet.

This architecture allows Reserved to support **unlinked on-chain asset transfers** while preserving the scalability benefits of compressed state. The result is a protocol that feels less like a mixer and more like a **private cash rail** for the Solana economy.

---

## Key Innovation: The Bearer Model

Reserved introduces **Private Asynchronous Transfers**.

The key breakthrough is that spending authority is **decoupled from wallet identity** and embedded into a transferable cryptographic secret represented as a **Base58 Voucher**. In practice, this means value can move from one participant to another **off-chain**, while the final on-chain redemption remains **unlinked** from the original sender in the explorer.

This creates a new privacy primitive for Solana:

- the sender can export value as a bearer secret,
- the recipient can import and redeem it later,
- and no explicit on-chain sender-to-recipient transfer edge needs to exist.

That is the defining property of Reserved: **private value transfer without synchronous counterparties and without direct wallet-to-wallet linkage**.

---

## Core Features

### Sovereign Bearer Assets

Reserved treats the private note itself as the asset. Spending authority resides in the **secret** (the Voucher), not in the identity of the original depositor. Whoever holds the valid voucher holds the right to redeem the underlying value.

### Asynchronous Privacy

Reserved enables private transfers even when the recipient is offline. A sender can create and export a bearer voucher, and the recipient can import and redeem it later. The transfer flow remains unlinked in public explorers, creating a cash-like asynchronous user experience.

### ZK-Compressed State

Reserved is powered by **Light Protocol V2**, using ZK-compression to store private state efficiently and verify transitions with validity proofs. This provides the scalability profile required for a privacy rail to grow without inheriting the storage costs of traditional account-heavy designs.

### Local-First Security

Reserved uses a local-first wallet model for private state. Notes, secrets, and voucher material are managed in the client via **IndexedDB**, minimizing exposure while keeping the private execution context under the user’s control.

---

## Technical Stack

- **Rust & Anchor** for the Solana on-chain program
- **Light Protocol V2** for ZK-compression and proof-based state transitions
- **React** for the application layer and wallet UX
- **TypeScript** for transaction construction, proof orchestration, and client logic
- **IndexedDB** for local note persistence and secret management

---

## Why Reserved Matters

Most blockchain privacy systems force a tradeoff between usability, scalability, and credible transfer semantics. Reserved is built to collapse that tradeoff.

It combines:

- **compressed private state** for scalability,
- **bearer semantics** for cash-like transferability,
- **asynchronous delivery** for real-world usability,
- and **local-first secret custody** for minimal exposure.

This makes Reserved suitable not only as a privacy application, but as a **foundational infrastructure layer** for private payments, private treasury movement, and bearer-style settlement on Solana.

---

## Competitive Benchmark

Reserved is architected to exceed the technical difficulty and innovation benchmarks set by leading **Solana Renaissance Hackathon** winners, especially across the **DeFi & Payments** and **Infrastructure** tracks.

Its competitive edge comes from the integration of two ideas that are rarely combined at production depth:

1. **ZK-compressed on-chain state transitions** with Light Protocol V2
2. **Bearer-value semantics** where spending authority lives inside a transferable cryptographic secret

This combination moves Reserved beyond a standard privacy app or wallet utility. It positions the protocol as a **new infrastructure primitive**: a scalable, privacy-preserving bearer cash rail built natively for Solana.

---

## Positioning

Reserved is not just a privacy wrapper.

It is a **private bearer cash rail**:

- optimized for Solana performance,
- powered by zero-knowledge compressed state,
- and designed for unlinked, asynchronous value transfer at infrastructure scale.

For teams, judges, and ecosystem partners evaluating technical ambition, Reserved represents a clear thesis:

**private digital cash on Solana should be scalable, transferable, asynchronous, and bearer by design.**
