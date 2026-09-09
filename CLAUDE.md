# CLAUDE.md — adapter only

`AGENTS.md` is the normative engineering contract and source of truth for this repository.

Claude-specific notes:

- Follow `AGENTS.md` §4 workflow: Inspect → Plan → Implement → Verify → Report.
- Use `pnpm verify` (`scripts/verify.sh`) as the single verification entrypoint.
- Distinguish Verified / Inferred / Not tested / Blocked per `AGENTS.md` §5.

Do not duplicate `AGENTS.md` here. On conflict, `AGENTS.md` wins.
