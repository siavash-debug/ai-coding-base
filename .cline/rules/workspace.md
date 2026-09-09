# Workspace rules — adapter only

`AGENTS.md` is the normative contract. This file only adapts it for Cline.

- Before edits, read `AGENTS.md` §2–§5.
- Prefer plan mode for non-trivial work; state files affected, risks, validation.
- Use `pnpm verify` (`scripts/verify.sh`) for verification; do not invent toolchains.
- Report as Verified / Inferred / Not tested / Blocked.
- Keep changes minimal per `AGENTS.md` §2.3; do not build application logic here.

On conflict, `AGENTS.md` wins.
