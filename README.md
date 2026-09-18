# cashu_escrow

An experimental standalone Cashu escrow operator for [Pontmore](https://github.com/pontmore/protocol)

It holds buyer-locked Cashu ecash (NUT-11 P2PK with a locktime and a refund
key), releases inside a bounded window by melting to Lightning, refunds on
locktime expiry or on resolution, freezes on dispute, and resolves explicitly.
It speaks pure Pontmore on the wire: kinds 30360/30361 for identity, 7300–7304
plus 30362 for the swap lifecycle, and NIP-59 Gift Wrap for the private lane.

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
expiry, forks, and malformed input. Regenerate them with `npm run vectors:build`.
They are test data, not production events or proof of independent interoperability.

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
  window closes. Inside the margin the swap is routed to refund.

## References

- [Pontmore PIP-00, PIP-01, PIP-02 and swap profile](https://github.com/pontmore/protocol)
- [Cashu client](https://github.com/cashubtc/cashu-ts)
- [Nutshell mint](https://github.com/cashubtc/nutshell)

## License

MIT — see [LICENSE](LICENSE).
