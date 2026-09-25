# cashu_escrow

An experimental standalone Cashu escrow operator for
[Pontmore](https://github.com/pontmore/protocol).

The current implementation is the Pontmore coordination kernel and its shared
conformance fixtures. It validates kind 7300 coordination roots, kind 7301
actions, the `pontmore/swap@1` profile, linked histories, signer authority,
disputes, forks, and terminal outcomes. Kinds 30360 and 30361 provide agent and
escrow discovery.

## Development

Requires Node 22 (see `.nvmrc`).

```bash
nvm use
npm install
npm run typecheck
npm test
npm run lint
npm run format
npm run build
```

`npm test` runs local unit tests with synthetic identities and an in-memory relay.
The integration suite is reserved for local Docker services and currently has no
cases.

Keep `.env` and runtime custody data out of Git.

## Protocol fixtures

[Vectors](vectors/README.md) are signed example histories with expected results,
loaded by the unit suite. They exercise settlement, refunds, authorization,
coordination and descriptor expiry, forks, and malformed input. Regenerate them
with `npm run vectors:build`. They are public-chain test data, not Cashu custody
tests, production events, or proof of independent interoperability.

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

| Command                                 | What it does                               |
| --------------------------------------- | ------------------------------------------ |
| `npm run typecheck`                     | `tsc` over `src`, `scripts` and `tests`    |
| `npm test`                              | unit tests (vitest) — no network           |
| `npm run test:integration`              | tagged suite against local Docker services |
| `npm run lint` / `npm run lint:fix`     | eslint                                     |
| `npm run format` / `npm run format:fix` | prettier                                   |
| `npm run build`                         | compile to `dist/`                         |
| `npm run vectors:build`                 | regenerate the deterministic JSON fixtures |

## Fees and expiry

PIP-01 has no descriptor-level pricing policy. The planned service will issue a
signed, expiring quote with exact amounts and bind it through the coordination
root's `commitments.quote` entry.

Cashu NUT-11 locktime expiry makes the provider's refund-key spending path
available at the mint. It does not authorize or publish a Pontmore
`core/refund`. A public refund requires `core/authorize_refund` or a valid
dispute-resolution effect of `authorize_refund`.

## References

- [Pontmore PIP-00, PIP-01, PIP-02 and swap profile](https://github.com/pontmore/protocol)
- [Cashu client](https://github.com/cashubtc/cashu-ts)
- [Nutshell mint](https://github.com/cashubtc/nutshell)

## License

MIT — see [LICENSE](LICENSE).
