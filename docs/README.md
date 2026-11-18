# Codemaps

One map per moon project, named after its id: `docs/<id>.md`. A map tells a newcomer where to
start reading and how the parts connect; the code says the rest. Projects small enough to read in
one sitting have no map. `moon query projects` lists them all.

## How the projects connect

- `native/core` is the vocabulary every native project builds on. `native/libs/*` are plain
  libraries: PE images (`pe`), mapping them (`manualmap`), finding things in them (`probe`),
  the signed fact bundle (`bundle`, `crypto`), the OS (`os`).
- `native/kit` is what runs inside a game: boot, lifecycle, hooks, facts and capabilities.
  `native/targets/cs2` builds the module for one game on top of it.
- `native/tools/loader-dev` maps a module into a process for development.
- `native/testing` and `native/fuzzing` host every project's tests and fuzz targets.
- `platform/server` is the authority: accounts, credentials, entitlements, products.
- `contracts/` pins what crosses between them; `tools/lint` and `tools/repo` hold the checks.
