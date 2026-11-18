# lint

Repo-wide checks that no off-the-shelf tool expresses, plus the ast-grep rules for the C++ and TypeScript dialects. Each check is a standalone stdlib uv script with no shared package or dispatcher. Agents and humans reach them through moon tasks and git hooks, never directly.

## Where things are

- Wiring: the tasks that run these scripts are in `tools/repo/moon.yml` (`format`, `suppressions`, `includes`, `ast-grep`, `ts-hygiene`, `commit-msg`, `check`). Per-project tidy tasks are in `.moon/tasks/cpp.yml`. The commit-msg hook is declared in `.moon/workspace.yml`. The Claude Code format hook is in `.claude/settings.json`.
- Commit gate: `tools/lint/commit_msg.py` (`validate` is the pure core; scopes come from `moon query projects` plus `repo`).
- Index snapshot runner: `tools/lint/staged.py` (`run_on_index`). It wraps the file-scanning checks above.
- File scans: `tools/lint/suppressions.py` (`MARKERS`, `scan`), `tools/lint/includes.py` (`scan`, `load_projects`, `parse_depends_on`), `tools/lint/ts_hygiene.py` (`check_package_json`, `check_filename`).
- clang-tidy runner: `tools/lint/tidy.py` (`translation_units`, `fix_includes`). It reads the dev build's `compile_commands.json`, so it needs a configured native build.
- Agent hook: `tools/lint/format_file.py` (`formatter_for`) formats the file an agent just wrote.
- Syntax rules: `tools/lint/ast-grep/sgconfig.yml`, with one rule per file in `tools/lint/ast-grep/rules/` and its valid/invalid cases in `tools/lint/ast-grep/tests/`. `ts-*` rules are TypeScript; the rest are C++.

## Flow

- Commit: git runs the commit-msg hook (`commit_msg.py`) on the message file. The pre-commit file checks go through `staged.py`, which exports the index being committed (`GIT_INDEX_FILE`) to a scratch tree under `.moon/cache` and runs the check there. Outside a hook it runs in place.
- Each scan script lists files with `git ls-files --cached --others` in its `_candidate_files`, so it sees whatever tree it runs in. That is why `staged.py` must wrap it.
- Native lint: `.moon/tasks/cpp.yml` runs `tidy.py` per project; `--fix` applies only `misc-include-cleaner` and then formats the changed files with dprint.

## Boundaries and invariants

- The scan scripts read the working tree they are given; only `staged.py` makes that the commit's content. A new file check must be added to `tools/repo/moon.yml` behind `staged.py` with `cache: false`, or it checks the wrong tree.
- `includes.py` reads `dependsOn` from each `native/**/moon.yml` with its own small parser (`parse_depends_on`), not through moon. Its model of the dependency graph is only as good as that parser.
- `suppressions.py` skips the files in `EXEMPT` because they spell markers out as data.
- `TS_ROOTS` in `ts_hygiene.py` and the `inputs` of the `ts-hygiene` task must agree; the task comments say so.
- The ast-grep rules are the checkable half of `native/AGENTS.md` and `platform/AGENTS.md`; those files point here for the rules.

## Where behavior is pinned

- Python checks: `tools/lint/test_commit_msg.py`, `tools/lint/test_includes.py`, `tools/lint/test_staged.py`, `tools/lint/test_suppressions.py`, `tools/lint/test_ts_hygiene.py`, run by the `test` task in `tools/lint/moon.yml`.
- ast-grep rules: the `test-rules` task runs the cases in `tools/lint/ast-grep/tests/`.
- Not tested: `tidy.py` and `format_file.py`.

## Not here

- C++ style and clang-tidy checks: `native/.clang-tidy` and `native/.clang-format`.
- TypeScript formatting and lint: `.biome.jsonc`.
- The task graph that decides when these run: `tools/repo/moon.yml`.
