# cashu_escrow

An escrow operator implementing the `cashu_escrow` canonical subtype of
[Pontmore](https://github.com/pontmore/protocol) PIP-01.

It holds buyer-locked Cashu ecash (NUT-11 P2PK with a locktime and a refund
key), releases inside a bounded window by melting to Lightning, refunds on
locktime expiry or on resolution, freezes on dispute, and resolves explicitly.
It speaks pure Pontmore on the wire: kinds 30360/30361 for identity, 7300–7304
plus 30362 for the swap lifecycle, and NIP-59 Gift Wrap for the private lane.

> **Status: pre-MVP.** Milestone 1 (scaffold + tooling) only. No custody code
> has been written yet. Do not point this at real sats.

## How custody works

A buyer locks ecash to the operator's public key with a locktime and their own
refund key. The mint — not this software — enforces the lock:

- **before locktime**, only the operator key can spend the proofs;
- **after locktime**, only the buyer's refund key can.

The operator never swaps the proofs on receipt; it holds them unchanged. That
means a crashed, compromised, or simply absent operator cannot make the funds
disappear — the buyer recovers them at locktime without anyone's cooperation.

There are two refund paths, both explicit:

| Path          | When                                     | Who acts                                                                                                      |
| ------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Self-recovery | locktime has passed                      | buyer spends with the refund key; operator publishes the transition and returns the original token            |
| Re-lock swap  | before locktime, on cancel or resolution | operator swaps the proofs into outputs locked to the buyer's pubkey with no locktime, and sends the new token |

## Custody invariants

These are the contract. Nothing in this repository may violate them.

- **I1 — Hold, don't swap.** Buyer proofs are verified and held unchanged.
- **I2 — Check state before acting.** Every custody action is preceded by a
  NUT-07 proof-state check and is idempotent, keyed by `swap_id`.
- **I3 — Release has a deadline.** Release runs only inside
  `[now, locktime − RELEASE_SAFETY_MARGIN_SECONDS]`. A missed window is a
  refund, never a loss.
- **I4 — Two refund paths, both explicit.** As tabled above.
- **I5 — Exact accounting.** `locked_amount = agent_payout + operator_fee +
mint_fees`, in one pure function, with no silent rounding.
- **I6 — Persist before you promise.** Custody material is written to the
  encrypted store before the `funded` transition is published. Never logged,
  never in an error message.
- **I7 — Disputes freeze.** A disputed swap never auto-releases.
- **I8 — Custody is trigger-agnostic.** The engine exposes verify / hold /
  release / refund / relockRefund. Release _policy_ lives in trigger adapters.

## Setup

Requires Node 22 (see `.nvmrc`).

```bash
nvm use
npm install
cp .env.example .env   # then fill in OPERATOR_NSEC and MINT_URL
```

`.env` is gitignored and must stay that way. So is `data/`, which holds the
encrypted custody store.

### Local services

A local relay and a local mint, for development and the integration suite:

```bash
# relay
docker run -p 7000:8080 scsibug/nostr-rs-relay

# mint (Nutshell, fake Lightning backend)
docker run -d -p 3338:3338 \
  -e MINT_BACKEND_BOLT11_SAT=FakeWallet \
  -e MINT_LISTEN_HOST=0.0.0.0 \
  -e MINT_LISTEN_PORT=3338 \
  -e MINT_PRIVATE_KEY=TEST_PRIVATE_KEY \
  cashubtc/nutshell:latest poetry run mint
```

## Scripts

| Command                                              | What it does                                     |
| ---------------------------------------------------- | ------------------------------------------------ |
| `npm run typecheck`                                  | `tsc` over `src`, `scripts` and `tests`          |
| `npm test`                                           | unit tests (vitest) — no network                 |
| `npm run test:integration`                           | tagged suite against local Docker services       |
| `npm run lint` / `lint:fix`                          | eslint                                           |
| `npm run format` / `format:fix`                      | prettier                                         |
| `npm run build`                                      | compile to `dist/`                               |
| `npm run operator`                                   | run the operator                                 |
| `npm run smoke`                                      | end-to-end smoke swap against local relay + mint |
| `npm run resolve -- --swap <id> --release\|--refund` | resolve a dispute                                |

## Configuration

See `.env.example`. Two settings deserve a note:

- **`FEES_ENABLED`** — set `false` to run fee-free. `OPERATOR_FEE_BPS` is
  ignored when it is false, and the published `pricing_policy` says so.
- **`RELEASE_SAFETY_MARGIN_SECONDS`** — how far ahead of locktime the release
  window closes. Inside the margin the swap is routed to refund (I3).

## References

- **Spec:** https://github.com/pontmore/protocol — PIP-00..03; `cashu_escrow`
  is merged into PIP-01.
- **Client counterpart:** https://github.com/MrNyamu/Pontswap — state machine
  and schema shapes ported here, credited in file headers.
- **Test discipline:** https://github.com/comwanga/pactagent — synthetic keys,
  in-memory relay, isolated signer, allowlisted public fields.
- **Cashu client:** [@cashu/cashu-ts](https://github.com/cashubtc/cashu-ts).
  Mint software: [Nutshell](https://github.com/cashubtc/nutshell).

## License

MIT — see [LICENSE](LICENSE).
