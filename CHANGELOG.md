# Changelog

## 0.1.0 — unreleased

First experimental release of the standalone Cashu escrow operator for
Pontmore PIP-02 v2 and `pontmore/swap@1`.

### Included

- Profile-neutral kind-7300/7301 coordination kernel and swap-v1 adapter.
- Sixty-five portable signed conformance vectors pinned to pontmore/protocol
  `edcf1370e7e646574021709cc9b186d96377280a`.
- Kind-30360 Agent and kind-30361 escrow discovery publishers.
- Signed exact quotes and an OpenAPI HTTPS service authenticated with NIP-98.
- Cashu NUT-07/10/11 custody with P2PK locktime and refund-key validation.
- Cashu P2PK and BOLT11 settlement, authorized refunds and bare-expiry private
  recovery.
- Encrypted append-only custody and operator journals with restart-safe outbox
  recovery.
- Dispute resolution, fork freezing and persistent fork evidence.
- NIP-59 delivery for settlement, refund, recovery and operational notices.

### Compatibility boundary

The release remains experimental. The shared vectors cover the public protocol
chain; they do not model Cashu proofs, mint state, NUT-11 locktime behavior or
private delivery. Production mint operation and independent interoperability
validation remain outstanding.
