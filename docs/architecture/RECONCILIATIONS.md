<!-- Generated from the normative documents by `pnpm docs:reconciliations`. Do not edit by hand. -->

# Reconciliation notes

The normative documents keep their historical claims intact. When a later phase makes a claim
out of date, the section is amended with a dated **reconciliation note** — an italic span
opening `_Reconciled YYYY-MM-DD:` and closing `_` — rather than being rewritten. This page
collects every one, so a reader can see what was superseded, when, and by which decisions in a
single place.

It is a projection, not a source: the notes in `README.md`, `docs/ARCHITECTURE.md`, the RFC
(`docs/architecture/V2-ARCHITECTURE.md`) and the ADR set (`docs/architecture/DECISIONS.md`) are
authoritative, and `tests/integration/docs-consistency.test.ts` fails if this page drifts from
them.

## 2026-09-27 — `docs/architecture/V2-ARCHITECTURE.md` — 34.4 Still simulated or absent (as of Phase C)

Cites ADR-059, ADR-060.

> this described the default runner; a project can now select a bounded real
> coding path (ADR-059) and, with named checks, criterion-bound acceptance evidence (ADR-060). The
> default runner is still simulated.

## 2026-09-27 — `docs/architecture/V2-ARCHITECTURE.md` — 35.6 Still simulated, absent, or provider/sandbox dependent

Cites ADR-059, ADR-060.

> still true of the default runner; a project can now select a bounded real
> coding path through the enforcement boundary (ADR-059) and bind a criterion to a named check
> (ADR-060). The default runner remains simulated.

## 2026-09-27 — `docs/architecture/V2-ARCHITECTURE.md` — 36.10 Still absent after Phase E

Cites ADR-059, ADR-060.

> the runtime can now be a bounded real coding path that executes a configured
> verification command through the operation gateway (ADR-059), with criterion-bound acceptance
> evidence from named checks (ADR-060). The default runner is still simulated, and there is still no
> autonomous loop.

## 2026-09-27 — `docs/architecture/V2-ARCHITECTURE.md` — 39.8 Deliberately not implemented after Phase H

Cites ADR-059, ADR-060.

> the bundled default runner is still simulated, but a project can select a
> bounded real coding path (ADR-059) that performs engineering work only through the enforcement
> boundary and can evidence criteria through named checks (ADR-060).

## 2026-09-27 — `docs/architecture/DECISIONS.md` — ADR-058 — The frontier executes one step; code filters and the brain reorders

Cites ADR-059, ADR-060.

> still true of the default runner, which remains simulated, but the runtime can now
> be configured with a bounded real coding path that performs engineering work only through the enforcement
> boundary (ADR-059) and can supply criterion-bound acceptance evidence (ADR-060).
