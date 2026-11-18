# native

The CMake tree that builds every native project: one configure and one build for every C++ project under `native/`, plus the toolchain, dependency and preset setup they share. This map covers only what sits at the root of `native/`. Everyone who touches C++ goes through it: it owns the flags, so a target cannot opt out of them.

## Where to start

- `native/CMakeLists.txt`: the project list. Each `add_subdirectory` is a sub-project with its own `CMakeLists.txt` and `moon.yml`.
- `native/cmake/lucent.cmake`: the helpers every target is declared through (`lucent_library`, `lucent_module`, `lucent_executable`, `lucent_fuzz`, `lucent_test`, `lucent_fixture`) and the tree-wide compile options. Read this before adding or changing a target.
- `native/cmake/clang-cl.cmake`: finds the pinned LLVM and Ninja (from `.prototools`), Visual Studio and the Windows SDK, and passes their locations as flags instead of using a dev shell.
- `native/cmake/toolchain.cmake`: what the presets name as the toolchain file; chains `clang-cl.cmake` and then VS's vcpkg.
- `native/CMakePresets.json`: `dev`, `release` and `fuzz`. Build trees go under `.moon/cache/cmake/<preset>`.
- `native/vcpkg.json` and `native/vcpkg-configuration.json`: the dependency manifest and the registry baseline. `native/cmake/ports/` holds overlay ports (monocypher has no vcpkg port) and `native/cmake/triplets/x64-windows-lucent.cmake` the one triplet.
- `native/moon.yml`: the `configure`, `build`, `fuzz-build` and `check` tasks of this project. `native/cmake/configure.cmake` is what `configure` runs.

## Flow

moon's `native:configure` runs `native/cmake/configure.cmake`, which configures the `dev` preset once and afterwards only regenerates `build.ninja`. `native:build` builds the whole tree. Every other native project's `test` and `lint` tasks (inherited from `.moon/tasks/cpp.yml`) depend on one of those two, so they share one build tree rather than each configuring its own. Tests run through CTest filtered by the project's label; `lucent_test` sets that label.

Dependencies are built by vcpkg with the same clang-cl and the same triplet as our code (via `VCPKG_CHAINLOAD_TOOLCHAIN_FILE`), so there is one answer to where the compiler and SDK are. They never see the tree-wide flags, which are set in `lucent.cmake`.

## Invariants across files

- Flags live only in `lucent.cmake` and apply to the whole tree, so header-verification units get them too. `-Weverything -Werror` with a short list of named exceptions; a target does not add its own.
- `native/core/include/lucent/core/prelude.hpp` is force-included into every target by the helpers; it is not included by hand.
- Mapped modules cannot have static TLS. `lucent_module` runs `native/cmake/check_no_tls.cmake` after linking, and `x64-windows-lucent.cmake` builds safetyhook with thread-safe statics off for the same reason. RTTI is off everywhere (`clang-cl.cmake`) except in fixtures that ask for `RTTI`.
- The static CRT is the only CRT, for our code and for vcpkg's.
- Fuzzing is a mode of the same tree: `LUCENT_FUZZ` (set by the `fuzz` preset) instruments our code with ASan and libFuzzer and builds only the `fuzzers` target. Outside that preset, `lucent_fuzz` still compiles the fuzz sources unlinked so they stay warning-clean. It is deliberately not part of `check`.
- `lucent_executable` fails configure when an executable's source directory holds anything but `main.cpp` and folders.
- Toolchain versions come from `.prototools` at the repo root, read as a file. A change to it or to a triplet re-triggers configure through `CMAKE_CONFIGURE_DEPENDS` in `toolchain.cmake`.

## Where behavior is pinned

- `native/core/src/toolchain_probe.cpp`: `static_assert`s of every language and library feature the dialect needs; a toolchain bump that loses one fails here.
- `native/cmake/check_no_tls.cmake`: the post-link TLS check above, run for every `lucent_module`.
- The tree has no tests of its own; each sub-project's tests are registered through `lucent_test` and `native/testing` supplies the Catch2 host.

## Not here

The code itself: see `native/core`, `native/kit`, `native/libs/`, `native/targets/cs2`, `native/tools/loader-dev`. `native/fuzzing` holds the shared libFuzzer entry, the targets sit beside each library. Lint configuration is `native/.clang-tidy` and `native/.clang-format`; the lint task itself is inherited from `.moon/tasks/cpp.yml`.
