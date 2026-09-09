# Architecture

`ai-coding-base` is a reusable AI Engineering coding workspace baseline, not an application or framework.

`AGENTS.md` is normative. `CLAUDE.md` and `.cline/rules/workspace.md` are thin adapters that point to it.

## Layout

- `src/` — minimal smoke proof only (`index.ts`).
- `tests/unit/` — deterministic offline Vitest tests.
- `scripts/verify.sh` — single local verification pipeline; CI runs the same script.
- `.github/workflows/ci.yml` — CI gate on `main`.
- `docs/` — workspace notes.

## Deferred (reserved, not created)

- `evals/` — AI evaluation harness, later phase.
- Python/`uv` — when a real Python workload exists.
- Docker — when runtime parity is required.

## Verification order

1. install → 2. format:check → 3. lint → 4. typecheck → 5. test → 6. build → 7. run built artifact.
