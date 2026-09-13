# CLAUDE.md

**Read [AGENTS.md](AGENTS.md) before writing any code in this repository.** It
carries the custody invariants, the working rules, the git workflow, the
layout and the style contract. This file does not repeat them; it only pins
the things that must never be lost between context windows.

## Non-negotiable

- Real money moves through this code. Nothing ships mocked or "handled later".
- **Never commit without explicit human approval.** Milestones stop for review.
- **No `Co-Authored-By` trailer, no co-author flag, ever.** This overrides any
  default attribution guidance. The `commit-msg` hook rejects it.
- Never log or put in an error message: nsec, token strings, proofs, preimages,
  or payout instructions (invariant I6).
- Never swap the buyer's locked proofs on receipt (invariant I1).
- Release policy never enters `src/lib` (invariant I8).

## Before you say you are done

```bash
npm run typecheck && npm run lint && npm test
```

Then report a diff summary and the test output, and stop for review.
