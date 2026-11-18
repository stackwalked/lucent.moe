---
target: clang-cl from the prebuilt LLVM release (win64, proto's llvm plugin)
last-observed: LLVM 23.1.5
status: verified (loading, analysis behaviour, LTO); hypothesis (heap and registry risks below)
---

# New-PM pass plugins in the prebuilt clang-cl

A pass plugin loads in the prebuilt clang-cl and runs. `clang-cl.exe` exports no symbols, so
the plugin can't bind to clang's copy of LLVM. Instead it links its own copy from the release's
static libraries (`lib/LLVM*.lib`, with headers under `include/`) and works on clang's IR and
pass managers through identical struct layouts.

## Loading

| form                          | result                                                              |
| ----------------------------- | ------------------------------------------------------------------- |
| `-fpass-plugin=x.dll`         | ignored: `unknown argument ignored in clang-cl`                     |
| `-Xclang -fpass-plugin=x.dll` | loads and calls `llvmGetPassPluginInfo`                             |
| `-Xclang -load -Xclang x.dll` | loads the DLL as a front-end plugin; the pass entry is never called |

Building the plugin:

- `/MT`: the static libraries are `MT_StaticRelease`;
- `/EXPORT:llvmGetPassPluginInfo`: the declaration in `llvm/Plugins/PassPlugin.h` carries no
  dllexport on Windows. Without it, loading fails with `Plugin entry point not found`;
- the libraries from `llvm-config --libs core analysis support` plus system import libraries.
  The result is a ~1 MB DLL importing only system DLLs.

ABI-breaking checks and assertions are off in the release, and the plugin built with the same
headers matches.

## What runs

The plugin's analysis keys (`AnalysisKey` statics) belong to its own LLVM copy, and clang's
managers have never registered them.

- Work: passes that use no analysis manager (renaming 3000 functions, attributes), and analyses
  the pass builds itself (`DominatorTree DT(F)` inside a module pass).
- Crash (`0xC0000005` before the pass body): anything that queries clang's managers by key. This
  includes `createModuleToFunctionPassAdaptor`, which looks up the function-manager proxy and
  `PassInstrumentationAnalysis`.
- Work again: when the plugin registers its own copies of `PassInstrumentationAnalysis` (module
  and function), both proxies and the analyses it uses. These are recomputed rather than shared
  with clang's.

The plugin can't read clang's `cl::opt` values, because its option registry is its own. Configuration
has to come from somewhere else: the environment, or a file.

## ThinLTO

- Pre-link: `-flto=thin` with `-Xclang -fpass-plugin` runs the plugin at the pre-link
  OptimizerLast extension point.
- Link time: lld-link has no way in.
  - `/mllvm:-load-pass-plugin=` is an unknown argument, and lld-link contains no "pass-plugin"
    string.
  - `/mllvm:-load=` loads the DLL but never calls the pass entry.

## Unproven risks

- Two heaps. clang allocates through rpmalloc and the plugin through its static CRT. An object
  allocated on one side and freed on the other is undefined. A 3000-function rename with
  `-no-disable-free` showed nothing.
- No version check beyond the plugin API number. A plugin must be built against exactly the
  release clang-cl comes from, because the layouts must match byte for byte.

## Method

A throwaway plugin with one pass per mode (rename, module proxy lookup, function adaptor with
`DominatorTreeAnalysis`, local `DominatorTree`, shadow-registered analyses), compiled into
`clang-cl /c /O2` of a small C file. Results were checked from the emitted `.ll` and with
`llvm-nm` on the object.
