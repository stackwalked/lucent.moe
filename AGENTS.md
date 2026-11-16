# How we work

Rules a tool can check live in that tool's config. This file holds only what can't be checked.

## Truth
- Code is truth. No ADRs, no specs, no design docs.
- Why lives at the decision point (comment) or in the commit that made it.
- Docs are maps: they point at code, never restate it. Lists are generated.
- Tests are the only written statement of required behavior; name them as behavior.
- Delete, don't deprecate. Git remembers.

## Readability
- Code should read without comments. Comments state why, invariants, or provenance, never what.
- Code touching things we don't control (offsets, sigs, vtables, hooks, layouts, ABI)
  states where the knowledge came from: build, method, what breaks if wrong.

## Tests
- A test exists because the failure would be silent, expensive, or subtle.
- Yes: formats/parsers, wire compat, state machines, authz, crypto, probe logic,
  concurrency, non-obvious regressions.
- No: obvious code, glue, plumbing, layout, mock-call assertions. No coverage targets.
- Real deps over mocks of our own code. Deterministic: injected clock, seeded RNG, no network.

## Commits
- `<moon-project>[/<subpath>]: <what changed>`, body says why.
  Changes outside any project use `repo`.
- Agents commit and push finished work after `:check`; stage explicit paths only.

## Roles
- Human: decides. Owns concepts, public interfaces, contracts, formats, deps, names,
  and any weakening of a check.
- Lead: refines ideas with the human, writes briefs, reviews once against the brief, commits.
- Implementer: executes a brief. Questions go to the lead, not around it.
- Navigator: pairs while the human drives; edits on request; reports back to the lead at the end.

## Briefs
Ephemeral; never committed. Shape: Goal · Fence · Fixed · Done · Out of scope · Stop and ask if.
- Stay inside the fence. Don't change what's Fixed; report problems with it.
- Lint/format config, toolchain pins, lockfiles, vcpkg manifest, contracts: untouchable
  unless the brief says so.
- Out-of-scope findings get reported, not fixed.
- Report: diff, verified vs suspected, deviations and why, open questions.

## Worktrees
Only for parallel implementers, with non-overlapping fences. Merge, then remove worktree
and branch. A solo implementer owns the fenced paths of the main checkout while running.
