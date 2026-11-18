# lucent.moe

Lucent: native modules that run inside games (Counter-Strike 2 first), the loader that maps them,
and the platform that holds accounts, entitlements and sessions for them.

## Where things are

| Path          | What lives there                                                         |
| ------------- | ------------------------------------------------------------------------ |
| `native/`     | C++ for Windows: libraries, the in-game kit, game targets, dev tools     |
| `platform/`   | TypeScript on Bun: `platform/server`, the authority over PostgreSQL      |
| `contracts/`  | Formats shared across runtimes, pinned by golden vectors                 |
| `products/`   | One TOML per product, read by `platform/server/src/products/catalog.ts`  |
| `tools/`      | Linters and repo-wide checks (`tools/lint`, `tools/repo`), proto plugins |
| `research/`   | Outside the product; `research/kb/` explains external targets            |
| `docs/`       | Codemaps, one per project that needs one                                 |
| `wishlist.md` | What has been discussed and isn't built yet                              |

## Working here

Every tool is pinned in `.prototools` and installed by proto on first use; moon drives everything.

- `moon run :check` checks the whole tree. The pre-commit hook runs it on what is staged.
- `moon run native:build` configures and builds the native tree (`native/CMakePresets.json`).
- `moon run server:dev` runs the server against a local PostgreSQL cluster; `server:seed`
  writes its root account.
- `moon run loader-dev:inject` maps the dev build of the cs2 module.
- `moon run <project>:fix` applies formatter and lint fixes.

Each task's `moon.yml` says what it does and why.

## How we work

`AGENTS.md` holds the rules no tool checks; `native/AGENTS.md` and `platform/AGENTS.md` hold
each runtime's. Everything checkable is in tool config.
