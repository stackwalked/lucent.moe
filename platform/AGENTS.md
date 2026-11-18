# Platform TypeScript

Checkable rules live in `/.biome.jsonc`, `/.config/tsconfig.base.json`, `tools/lint/ast-grep/` and
`tools/lint/ts_hygiene.py`. This file holds only what no tool checks.

## Principles

They break ties between the rules below.

1. Judge readability at the call site. Domain and route code is plain and imperative; type-level
   machinery, foreign exception containment and wire framing live in `core/` and `db/`.
2. One way to write each thing. Data is plain `readonly` objects with free functions; stateful
   handles are closure factories (`openX`/`createX`).
3. Parse at the edge; types carry the rules. Untrusted bytes (HTTP, RPC, SQL rows, TOML, env) enter
   as `unknown` or `Uint8Array`, parse once into branded domain values, and are trusted inside.
4. Explicit effects. Time (`EpochMs`), randomness (`CryptoRng`/`SeededRng`), cancellation
   (`AbortSignal`) and database handles (`Db` vs. `Tx`) pass as parameters.
5. Control flow is visible: expected failures return `Result<T, E>`; programmer bugs call
   `invariant()`/`unreachable()` and surface as `503` at `containBoundary()`.

## Semantics

- `null` means explicit domain absence (`Account | null`, SQL `NULL`, JSON `null`). `undefined` is
  only for omitted optional properties (`?:`) and collection misses; never return `T | undefined`
  from a repository or domain query.
- `findX` returns `Promise<X | null>` (absence is normal). `readX` returns `Promise<Result<X, E>>`
  (absence is a refusal such as `NOT_FOUND`). `parseX` validates untrusted input into `Result`;
  `fromX` constructs infallibly; `toX` formats or serializes.
- More than three positional parameters become a single `readonly` parameter object.
- Guard clauses sit at the top of functions; avoid `else` after an early `return`.
- Every outbound I/O call (`fetch`, `Bun.spawn`) carries a bounded `AbortSignal` deadline.

## Database and authority

- Never run `Promise.all` over queries sharing one `Tx` (PostgreSQL connection wire state is
  sequential; `Tx` also guards this at runtime).
- Never perform network, filesystem or subprocess I/O while holding a `Tx`. Commit the authority
  record first, then sign or send.
- Canonical lock order across every writer:
  `account` (`ORDER BY id`, through `lockCallerWith`) → `device` (`ORDER BY id`) → `entitlement`
  (`ORDER BY id`) → `product_slot`
  (`ORDER BY product_id`) → `load` / `runtime_session` → append-only `audit` / `inbox` / `receipt`
  (written last, never locked).
- Time-sensitive eligibility (session freshness, 30-minute passkey step-up, entitlement windows,
  device replacement windows, leases) is evaluated against `txNow` from PostgreSQL `now()`, never
  process wall time.
- Authorization goes solely through `can(subject, action, target?)` and `authorize(txNow, caller,
  action, target?)`; never branch on role names in code.

## Tests

- `tests/<unit>.test.ts`, named as behavior sentences.
- Real PostgreSQL (`withTestDb` over `TEMPLATE` cloning), injected clocks and RNG, zero network,
  never mocking our own modules or SQL.
