# ADR 0002 — Customer-Approved Artwork Is Never Production Artwork

**Status:** Accepted — carried forward unchanged from the prototype into any rebuild.

## Context
An earlier version of the prototype allowed customer-approved artwork to flow directly into Gang Run planning and printing. A later requirement document explicitly identified this as wrong and mandated a second, internal approval stage. The fix was built, and a **real bug was found and fixed** during that work: the print-ready gate initially blocked orders that never required artwork at all (Case 3, blank artwork field), because the gate checked for an internal-approval file that such orders would never produce. This is exactly the class of mistake a rebuild could silently reintroduce if the rule isn't captured as an explicit, tested invariant rather than folklore.

## Decision
1. Customer approval of artwork (`final_artwork_url` / Stage `ARTWORK_VERIFIER`/`ARTWORK_CREATOR` → `FINAL_ARTWORK_INSPECTOR`) is stored as a locked, immutable historical reference. It is never itself a valid input to a print job.
2. Only an artwork file that has passed **both** an Artwork Operator's technical check (dimensions, DPI, bleed, colour, layout, cutting) **and** a Supervisor's final approval may unlock production (`final_internal_approved_artwork`).
3. This gate applies **only** to orders where artwork was actually required. An order whose artwork field was blank at booking must never be blocked waiting for a file that was never going to exist.
4. Gang Run combination is a *third* tier on top of rule 2, not a substitute for it: every member order must already individually satisfy rule 2 before the gang can even be sent for combined-artwork setup.

## Consequences
- Any rebuild's acceptance test suite must include, as a non-negotiable case: an order with only customer-approval attempts `start-production` → must be rejected. This exact scenario has regressed once already in this project's history.
- A second non-negotiable case: a blank-artwork order attempts `start-production` with zero AMS interaction → must succeed. This is the inverse failure mode, and also regressed once already.
- Any new artwork-adjacent feature (e.g. a future re-approval workflow) must be checked against this ADR before implementation, not assumed compatible.
