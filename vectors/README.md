# `pontmore/swap@1` conformance vectors

Shared vectors for the PIP-02 v2 coordination kernel and the
`pontmore/swap@1` profile. Written against **pontmore/protocol `d9a1eb3`**
(PIP-00, PIP-01, PIP-02 v2, `profiles/swap-v1.md`).

These 65 files are portable test fixtures: input events plus an expected result.
For example, `settle-btc-to-fiat` expects `settled`; `fork-at-refund` expects
`forked`, so an implementation that chooses a refund branch fails that case.

Each file includes its own descriptor, root, actions and signatures. That is why
the JSON looks repetitive and large: a Rust or Python implementation can use one
file without our TypeScript builders. The forged-duplicate cases deliberately
contain an invalid signature. No real keys, money or network services are used.

Review the case definitions in `scripts/build-vectors.ts` instead of reading repeated hashes.
`npm run vectors:build` regenerates formatted JSON deterministically. The builder
sets expected results explicitly; it does not call the validator to obtain them.

The unit suite checks expectations and replays each valid-root history in reverse
delivery order. Ordinary unit tests handle API edge cases such as malformed UTF-8
and JSON-null messages. Passing these fixtures does not establish custody safety
or independent interoperability.

## Scope boundary

These fixtures test the public Pontmore event chain. Their expiry cases cover a
coordination root's acceptance deadline and an escrow descriptor's selection
deadline. They do not contain Cashu proofs, NUT-11 locktimes, mint state, or
private recovery delivery, and locktime expiry never supplies public
`core/refund` authorization here. Cashu custody and locktime behavior require a
separate integration suite against a local mint.

## File format

```jsonc
{
  "name": "settle-btc-to-fiat",
  "description": "...",
  "spec": { "commit": "d9a1eb3", "pip02_version": 2, "profile": "pontmore/swap@1" },
  "descriptor": {/* signed kind 30361 event */},
  "root": {/* signed kind 7300 event */},
  "actions": [/* signed kind 7301 events, delivery order as given */],
  "expect": {
    "root": "valid", // or { "rejected": "<reason>" }
    "state": "settled", // derived state label
    "terminal": true,
    "disputed": false,
    "forked": null, // or { "branches": 2 }
    "rejected": [], // failures name an action_index and a reason
  },
}
```

`actions` is a delivery order, not a chain order: the chain is followed by
`prev` links, and `settle-out-of-order-delivery` asserts exactly that.

Rejection reasons are the closed set exported as `REJECTION_REASONS` from
`src/lib/pontmore/chain.ts`.

## Test keyset

Secret keys are 32 bytes of one repeated value. They are public, fixed, and for
vectors only.

| Role            | Secret key byte | Pubkey                                                             |
| --------------- | --------------- | ------------------------------------------------------------------ |
| `swap/agent`    | `0xa1`          | `ab5d2e79cfd621b1b027ffb24e2453ed7fb571ba9a841ff0e2473466cabd168d` |
| `swap/customer` | `0xc1`          | `f4f6a5667475b3b52468751c478faad9ea15075c79adeca9f5288311ef176443` |
| `core/escrow`   | `0xe1`          | `07031187fb14f770d521389c502321abb0e41e5ab87181d24e8faa0aeed83798` |
| `core/resolver` | `0x1e`          | `27a2897a1d182ecb48ddc12278d9816be55ca5a39ed852f271cfaae1fff40406` |
| unauthorized    | `0x5a`          | `9c5530e4385ebc41cdaf8257edf9a2baaf8506a4099103211e6ed7382103ed67` |

The escrow key also publishes the descriptor. The customer proposes unless the
vector says otherwise.

## Timeline

All vectors share one timeline, based at `T0 = 1800000000`:

| Point                         | Offset        |
| ----------------------------- | ------------- |
| descriptor `created_at`       | `T0`          |
| root `created_at`             | `T0 + 100`    |
| `core/accept`                 | `T0 + 200`    |
| `core/secure`                 | `T0 + 300`    |
| root `expires_at`             | `T0 + 1000`   |
| `swap/fiat_sent`              | `T0 + 1500`   |
| `deadlines.fiat_pay_by`       | `T0 + 2000`   |
| `swap/fiat_confirmed`         | `T0 + 2500`   |
| `deadlines.fiat_confirm_by`   | `T0 + 3000`   |
| authorization                 | `T0 + 2600`   |
| `core/settle` / `core/refund` | `T0 + 2700`   |
| descriptor `expires_at`       | `T0 + 100000` |

## Coverage

The profile's required vector list, and where it is covered:

| Requirement                                | Vectors                                                                                                                                                                    |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| both directions                            | `settle-btc-to-fiat`, `settle-fiat-to-btc`                                                                                                                                 |
| acceptance before / after expiry           | `accept-before-expiry`, `accept-after-expiry`                                                                                                                              |
| descriptor expiry vs root creation         | `descriptor-expired-before-root`, `descriptor-created-after-root`, `descriptor-expires-at-acceptance`, `descriptor-expires-after-acceptance`                               |
| descriptor binding                         | `descriptor-id-mismatch`, `descriptor-address-mismatch`, `escrow-coordinate-wrong-kind`                                                                                    |
| normal settlement                          | `settle-btc-to-fiat`                                                                                                                                                       |
| no-payment refund                          | `refund-no-payment`                                                                                                                                                        |
| disputed settlement / refund authorization | `dispute-resolved-to-settlement`, `dispute-resolved-to-refund`, `dispute-resolved-to-resume`, `dispute-resolved-to-cancel`                                                 |
| mismatched payment references              | `payment-reference-mismatch`                                                                                                                                               |
| unauthorized signers                       | `accept-by-stranger`, `accept-by-proposer`, `secure-by-non-escrow`, `resolution-by-non-resolver`, plus `core-*-by-stranger` and `swap-*-by-stranger` for the other actions |
| duplicate and out-of-order actions         | `duplicate-event-id`, `replayed-accept`, `dangling-prev-reference`, `root-reference-mismatch`, `settle-out-of-order-delivery`                                              |
| sibling forks at economic gates            | `fork-at-secure`, `fork-at-settlement-gate`, `fork-at-authorize-settlement`, `fork-at-settle`, `fork-at-authorize-refund`, `fork-at-refund`, `fork-with-invalid-sibling`   |
| settlement and refund in one history       | `settle-and-refund-in-one-history`, `resolution-restricts-to-one-outcome`                                                                                                  |
| public/private separation                  | `public-private-separation`, `commitment-key-not-permitted`                                                                                                                |
| version and profile pinning                | `coordination-version-unsupported`, `profile-not-supported`                                                                                                                |
| terms validation                           | `terms-zero-bitcoin-amount`, `terms-expiry-ordering`, `duplicate-application-role`, `missing-resolver-authority`                                                           |
| kernel ordering                            | `settle-without-authorization`, `authorize-refund-too-early`, `dispute-freezes-progress`                                                                                   |

Additional descriptor cases cover missing/duplicate `d` tags, unsupported versions,
network-tag contradictions, mechanism/network incompatibility and a terms/network
mismatch. `dispute-class-unknown` checks the profile enum; `forged-duplicate-first`
and `forged-duplicate-last` check authentication before deduplication.

Rejection names, the 64-character opaque-ID limit, supported discovery version 1,
and the sat cap are local validation conventions, not upstream standardized error
codes or universal limits.
