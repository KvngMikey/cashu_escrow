# cashu_escrow

An experimental standalone Cashu escrow operator for
[Pontmore](https://github.com/pontmore/protocol).

The current implementation includes the Pontmore coordination kernel, shared
conformance fixtures, discovery-event publishers, a NIP-98 authenticated HTTPS
service, signed exact quotes, an encrypted private-state store, the custody
engine, and a coordination watcher. The watcher replays kind 7300/7301 chains,
checks the bound quote, drives custody only from derived authorization, and
publishes `core/secure`, `core/settle`, or `core/refund` after the corresponding
custody and private-delivery work succeeds. Kinds 30360 and 30361 provide agent
and escrow discovery.

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

`npm test` runs local unit tests with synthetic identities and an in-memory
relay. The integration suite exercises custody against a local Nutshell mint.

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
docker run -p 17000:8080 scsibug/nostr-rs-relay

# mint (Nutshell, fake Lightning backend)
docker run -d -p 3338:3338 \
  -e MINT_BACKEND_BOLT11_SAT=FakeWallet \
  -e MINT_LISTEN_HOST=0.0.0.0 \
  -e MINT_LISTEN_PORT=3338 \
  -e MINT_PRIVATE_KEY=TEST_PRIVATE_KEY \
  cashubtc/nutshell:latest poetry run mint
```

## Scripts

| Command                                 | What it does                                                   |
| --------------------------------------- | -------------------------------------------------------------- |
| `npm run typecheck`                     | `tsc` over `src`, `scripts` and `tests`                        |
| `npm test`                              | unit tests (vitest) — no network                               |
| `npm run test:integration`              | tagged suite against local Docker services                     |
| `npm run lint` / `npm run lint:fix`     | eslint                                                         |
| `npm run format` / `npm run format:fix` | prettier                                                       |
| `npm run build`                         | compile to `dist/`                                             |
| `npm run operator`                      | run the watcher and private HTTP service                       |
| `npm run smoke`                         | run escrow coordination flows against the local relay and mint |
| `npm run vectors:build`                 | regenerate the deterministic JSON fixtures                     |
| `npm run publish:descriptor`            | publish and verify the escrow descriptor                       |
| `npm run publish:agent`                 | publish and verify the Agent definition                        |
| `npm run publish:profile`               | publish and verify the kind-0 profile                          |

The publisher scripts read `.env`; [.env.example](.env.example) lists every
required value. Each script reads its event back from the configured relay and
fails if the stored event does not validate.

The smoke command uses `ws://127.0.0.1:17000` and
`http://127.0.0.1:3338` by default. Override them with `TEST_RELAY_URL` and
`TEST_MINT_URL` when the local services use different addresses.

`npm run operator` initializes the configured mint, publishes and verifies the
discovery events, replays known coordinations, resumes the encrypted NIP-59
outbox, and listens on `SERVICE_LISTEN_HOST:SERVICE_LISTEN_PORT`. Put an HTTPS
reverse proxy in front of that listener at `SERVICE_BASE_URL`; NIP-98 requests
are verified against that public origin. `QUOTE_NETWORK_COST_SATS` is the exact
network budget signed into new quotes. Cashu P2PK funding must have that exact
input fee; Lightning returns unused budget when configured.

## Fees and expiry

PIP-01 has no descriptor-level pricing policy. The service issues a signed,
expiring quote with exact amounts and accepts a coordination only when its
`commitments.quote` entry matches a quote in the encrypted operator store. The
quote's `terms_digest` must also match the root's `commitments.private_terms`
digest.

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
