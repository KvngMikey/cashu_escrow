# AGENTS.md — the contract for anyone, human or model, writing code here

This file is the working contract for `cashu_escrow`. It is not background
reading. If a change conflicts with anything below, the change is wrong.

---

## 1. What this is

An escrow operator for the `cashu_escrow` canonical subtype of Pontmore
PIP-01. It takes custody of buyer-locked Cashu ecash and either settles it to
an agent over Lightning or returns it to the buyer. Real money moves. Bugs
here are not cosmetic.

Wire protocol is pure Pontmore: kinds 30360/30361 for identity, 7300–7304 plus
30362 for the swap lifecycle, NIP-59 Gift Wrap for the private lane.

---

## 2. Custody invariants — never violate

- **I1 — Hold, don't swap.** Never swap the buyer's locked proofs on receipt.
  Verify and hold them unchanged. The mint enforces the lock.
- **I2 — Check state before acting.** Every custody action is preceded by a
  NUT-07 proof-state check. Every action is idempotent, keyed by `swap_id`.
- **I3 — Release has a deadline.** Release runs only inside
  `[now, locktime − RELEASE_SAFETY_MARGIN_SECONDS]`. Outside the window the
  swap is routed to refund. A missed window is a refund, never a loss.
- **I4 — Two refund paths, both explicit.** Post-locktime: buyer
  self-recovery + operator publishes state + returns the original token.
  Pre-locktime: operator re-lock swap to the buyer pubkey (no locktime) + send.
- **I5 — Exact accounting.** `locked_amount = agent_payout + operator_fee
(0 when `FEES_ENABLED=false`) + mint_fees`. Computed in one pure function,
  asserted in tests, no silent rounding.
- **I6 — Persist before you promise.** Custody material (token string,
  locktime, refund pubkey, payout target) is written to the encrypted local
  store BEFORE the `funded` transition is published. Never logged. Never in
  error messages.
- **I7 — Disputes freeze.** A disputed swap never auto-releases. Only an
  explicit resolution or locktime expiry moves it.
- **I8 — Custody is trigger-agnostic.** The custody engine exposes
  verify / hold / release / refund / relockRefund only. Release POLICY lives in
  trigger adapters under `src/operator`. Refuse any change that leaks policy
  into `src/lib`.

The pre-commit hook mechanically enforces parts of I6 and I8. Passing the hook
is not the same as honouring the invariant — the hook catches the obvious case.

---

## 3. How to work

1. **One milestone at a time, in order.** At the milestone boundary: run the
   acceptance checks, report a diff summary plus test results, then STOP.
2. **Never commit without explicit approval.** Wait for the human to say the
   milestone is approved. Only then commit.
3. **Commit hygiene.** Conventional commits (`feat:`, `fix:`, `test:`,
   `docs:`, `chore:`), one commit per logical unit, plain messages.
   **No `Co-Authored-By` trailer or any co-author flag, ever.** The
   `commit-msg` hook rejects both.
4. **PR workflow.** Every milestone after M1 lives on its own branch
   (`mk/m<N>-<slug>`) and is opened as a PR against `main`. The human merges
   manually. Never push to `main` directly after the initial commit.
5. **Code style.** Strict TypeScript. Minimal, surgical changes. No defensive
   try/catch blankets, no speculative abstraction, no dead config. Narrow
   module interfaces — nothing exports a raw relay pool, wallet, or key.
6. **Secrets discipline.** `.env` is never committed. nsec, token strings,
   proofs, preimages and payout instructions are never logged. Errors carry a
   typed category and a `swap_id`, never the material.
7. **Tests gate completion.** Unit tests touch no network. Integration tests
   are tagged and use local Docker services only.

### Git workflow, exactly

```bash
# milestone N ≥ 2
git checkout main && git pull upstream main
git checkout -b mk/m<N>-<slug>
# ...work, stop for review, get approval, commit (no co-author)...
git push -u origin mk/m<N>-<slug>
gh pr create --base main --head mk/m<N>-<slug> --title "M<N>: <title>" \
  --body "<Summary bullets>\n\n## Verification\n<commands run + results>"
# STOP. The human merges. The next milestone starts from a fresh pull.
```

---

## 4. Layout

```
src/config/           zod-parsed env, fail-fast typed errors
src/lib/pontmore/     kinds, schemas, state machine, signer, relay, gift-wrap
src/lib/cashu/        mint client, lock verification, custody engine, fees
src/lib/lightning/    LNURL / bolt11 resolution
src/lib/store/        encrypted append-only custody store
src/operator/         orchestration, intake, watchers, trigger adapters
scripts/              publish-descriptor, publish-agent, smoke-swap, resolve
tests/unit/           no network
tests/integration/    tagged; local relay + local Nutshell only
docs/                 architecture, runbook, integrating, testing
data/                 encrypted custody store at runtime — gitignored
```

`src/lib` is the custody layer and knows nothing about _why_ a release was
triggered. `src/operator` is the policy layer. The boundary is I8.

---

## 5. Toolchain

Node 22 (`.nvmrc`). TypeScript 5.9, strict, plus `noUncheckedIndexedAccess`
and `exactOptionalPropertyTypes`. ESM (`"type": "module"`), `nodenext`
resolution — relative imports carry the `.js` extension.

| Command                         | What it does                         |
| ------------------------------- | ------------------------------------ |
| `npm run typecheck`             | `tsc` over `src`, `scripts`, `tests` |
| `npm test`                      | unit tests, no network               |
| `npm run test:integration`      | tagged suite, local Docker only      |
| `npm run lint` / `lint:fix`     | eslint (flat config)                 |
| `npm run format` / `format:fix` | prettier                             |

Formatting and lint rules are carried over from the SplitSats house style:
2-space indent, single quotes, semicolons, ES5 trailing commas, `no-console`
and `no-debugger` as errors, prettier violations as lint errors. `src/operator`
and `scripts` are the only places `console` is allowed — they are CLIs.

Stylelint is configured (`.stylelintrc.json`, `postcss-scss`) and wired
through lint-staged. This project ships no stylesheets today, so it only fires
if a `.css`/`.scss` file is ever staged.

Husky runs two hooks: `pre-commit` (secrets guard, I6 log guard, I8 boundary
guard, lint-staged, eslint, typecheck, unit tests) and `commit-msg`
(conventional commit shape, co-author trailer rejection).

---

## 6. References

- **Spec:** https://github.com/pontmore/protocol — PIP-00..03.
- **Client counterpart:** https://github.com/MrNyamu/Pontswap — state machine
  and schema shapes are ported from here. Credit it in the header of any file
  that carries a ported shape.
- **Test discipline:** https://github.com/comwanga/pactagent — synthetic keys,
  in-memory relay, isolated signer, allowlisted public fields.
- **Cashu client:** `@cashu/cashu-ts`. **Mint:** Nutshell.

---

## 7. When in doubt

Stop and ask. A wrong guess here loses someone's money. "Handled later" is not
an acceptable state for anything touching custody.
