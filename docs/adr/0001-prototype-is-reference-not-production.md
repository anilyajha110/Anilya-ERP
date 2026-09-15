# ADR 0001 — The Existing Prototype is Reference, Not Production Architecture

**Status:** Accepted (dictated by the blueprint itself, Mandatory Principle #5 and the "Claude Master Development Prompt" framing)

## Context
The current codebase (`server.js`, 4,404 lines; `db.js`, 1,125 lines; the isolated Inventory module) is a single Node/Express process backed by SQLite, built incrementally across many conversational turns. It correctly encodes a large number of real, hard-won business rules (see Master Requirement Register) — several of them fixed only after a live bug was found and reproduced. That logic has genuine value.

The blueprint that commissioned this audit explicitly states: *"PostgreSQL is the production transactional database. Do not use SQLite as production architecture,"* and frames the whole prototype as *"a requirements-rich prototype/reference implementation, NOT... production truth."*

## Decision
Treat every file in the current prototype as **REFERENCE** for business logic extraction, not as a codebase to incrementally patch into production shape. Concretely:
- Business *rules* (state machines, gates, the artwork approval sequence, the ledger formulas, the RBAC boundaries that were fixed after a real exploit) should be preserved and re-implemented in the target stack.
- Business *code* (the actual JavaScript, the SQLite schema, the local-disk file storage, the in-process bridge simulations) should not be lifted as-is into a Postgres/TypeScript/object-storage target — see RISK-001, RISK-002, RISK-005.
- The prototype remains runnable and useful as a living reference during the rebuild (to compare behavior against), not as a migration source for schema or infrastructure.

## Consequences
- Phase 1 (Production Engineering Foundation) starts from a real TypeScript monorepo + PostgreSQL schema, not a port of `db.js`.
- Every requirement in the Master Requirement Register classified REBUILD or REFACTOR needs its business rule re-specified as an explicit acceptance test *before* re-implementation — the prototype's live-tested behavior (documented in the Register's Evidence column) is the source of truth for what "correct" means, even though the code itself is not.
- Items classified SECURITY BLOCKER (client-trusted `actorRole` on ~50 endpoints, the open file-access stub) must NOT be carried forward even temporarily — they should not exist in the target architecture's first commit.
