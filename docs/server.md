# server

The authority service: accounts, roles, entitlements, credentials and browser sessions, over PostgreSQL. Its only caller today is the web front end, through an authenticated internal RPC listener; the native-facing `/v1` listener is not built yet. Bun and TypeScript; `platform/AGENTS.md` holds the rules for how code here is written.

## Where things are

Start at `platform/server/src/boot.ts` (`startServer`), which wires everything and is the only place that does.

- Entry points: `platform/server/src/main.ts` (the server process, exit codes a supervisor acts on), `platform/server/src/ops.ts` (operator verbs run against the same database), `platform/server/dev/dev.ts` and `platform/server/dev/seed.ts` (local cluster, see `platform/server/moon.yml`).
- Config: `platform/server/src/config.ts` (`readServerConfig`, `readOpsConfig`) is the only reader of the environment.
- Internal RPC surface: `platform/server/src/internal/app.ts` (`createInternalWebApp`, `webRpc`) and `platform/server/src/internal/auth-rpc.ts` (`authRpc`). The procedure map's type is exported as `./rpc-type` in `platform/server/package.json` for clients.
- RPC machinery: `platform/server/src/core/rpc.ts` (`procedure`, `mountInternalRpc`, `createRpcClient`).
- Authority (who may do what): `platform/server/src/authority/`. `policy.ts` has `can` and `authorize`; `actions.ts` the action set; `standing.ts` the locked read of a caller (`lockCallerWith`); `writers.ts` every state-changing operation (`createAccount`, `upsertRole`, `issueEntitlement`, ...); `entitlements.ts` effective product access.
- Authentication: `platform/server/src/auth/`. `sign-in.ts` and `credentials.ts` are the flows; `sessions.ts`, `flows.ts`, `setup.ts` and `tokens.ts` hold the bearer tokens; `passkeys.ts`, `password.ts`, `totp.ts` wrap the primitives; `deps.ts` (`AuthDeps`) bundles what they take as parameters.
- Data layer: `platform/server/src/db/`. `pool.ts` (`openPool`, `sql`, `queryOne`), `tx.ts` (`withTx`), `migrate.ts`, `receipt.ts` (idempotent replay), `audit.ts`, `epoch-guard.ts`. Schema is `platform/server/migrations/`.
- Foundations: `platform/server/src/core/`. `result.ts` (`Result`), `contain.ts` (`invariant`, `containBoundary`, `trySync`), `scalars.ts` (branded ids and `EpochMs`), `clock.ts` and `rng.ts` (the only ambient time and randomness), `log.ts`.
- Product catalog: `platform/server/src/products/catalog.ts` (`loadProductCatalog`) reads the TOML files in `products/` at the repo root.

## How a request flows

1. `mountInternalRpc` checks the peer key and bounded body, parses input with the procedure's zod schema, then calls `createContext` from `createInternalWebApp`.
2. Procedures in `authRpc` call into `auth/` or `authority/`. Writers take a `Db`, open `withTx`, re-read the caller under lock, `authorize` against `txNow`, write, then record a receipt and audit row.
3. Failures are `Result` values; database failures are collapsed to `SERVICE_UNAVAILABLE` in `auth-rpc.ts` before they reach the wire. Anything uncontained surfaces as 503 through `containBoundary` and `app.onError`.

## Boundaries and invariants

- Handover between instances: `startServer` claims the next service epoch just before listening; an older instance's `EpochGuard` then reports superseded and `createContext` refuses with `SERVICE_UNAVAILABLE`. A failed epoch read is logged, not treated as supersession.
- Boot refuses to serve on a schema that differs from this build's migrations (`verifySchemaCurrent`, exit code 2 in `main.ts`). Migrations are applied only by `ops migrate` (and by `dev.ts`), never by the server.
- The internal listener is loopback or a Unix socket only, and peer keys are length-checked (`isStrongPeerKey`); both are enforced from config, not left to deployment.
- Authority and time rules (lock order, `txNow`, no I/O inside a `Tx`, authorization only through `can`/`authorize`) are in `platform/AGENTS.md`; they span `authority/`, `auth/` and `db/`, so a new writer must follow them.
- The root account is outside the RPC surface: it is created and recovered only through `ops bootstrap-superadmin` and `ops recover-root`, which print a setup link path.
- Clients treat session and setup tokens as opaque bearer values (`BearerToken`); the server stores only hashes of them.

## Where behavior is pinned

Tests are in `platform/server/tests/`, run against a real PostgreSQL started by `platform/server/tests/harness/pg-test.ts` and stopped by `platform/server/tests/harness/teardown.ts` (preloaded in `platform/server/bunfig.toml`). The WebAuthn tests use the software authenticator in `platform/server/tests/harness/authenticator.ts`. By area: `authority-*.test.ts` (roles, entitlements, accounts, receipts), `auth-*.test.ts` (sign-in, credentials, TOTP), `tx.test.ts` and `pool.test.ts` (transaction behavior), `epoch-guard.test.ts`, `boot.test.ts`, `rpc.test.ts` and `internal-app.test.ts`.

## Not here

The web front end (the RPC client), the native-facing `/v1` listener and the product catalog data (`products/`) are not in this project.
