# lucent.moe

Lucent: native modules that run inside games (Counter-Strike 2 first), the loader that maps them,
and the platform that holds accounts, entitlements and sessions for them.

## Where things are

| Path          | What lives there                                                 |
| ------------- | ---------------------------------------------------------------- |
| `native/`     | C++ for Windows: libraries, the in-game kit, game targets, tools |
| `platform/`   | TypeScript on Bun: services                                      |
| `contracts/`  | Formats shared across runtimes, pinned by golden vectors         |
| `products/`   | One TOML per product                                             |
| `tools/`      | Linters, repo-wide checks, proto plugins                         |
| `research/`   | Outside the product; `research/kb/` explains external targets    |
| `docs/`       | Codemaps for projects that have settled                          |
| `wishlist.md` | What has been discussed and isn't built yet                      |

`moon projects` lists every project with what it is for; `moon run :check` checks the tree.
Tools are pinned in `.prototools` and installed on first use.

## How we work

`AGENTS.md` holds the rules no tool checks; `native/AGENTS.md` and `platform/AGENTS.md` hold
each runtime's. Everything checkable is in tool config.
