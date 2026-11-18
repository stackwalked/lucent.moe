# Native C++

The dialect's checkable rules live in `.clang-format`, `.clang-tidy`, `cmake/lucent.cmake`,
`core/src/toolchain_probe.cpp` and `tools/lint/ast-grep/`. This file holds only what no tool checks.

## Principles

They break ties between the rules below.

1. Judge readability at the call site. Feature and domain code is plain and imperative; machinery
   (templates, tokens, compile-time code) lives in a few kit libraries.
2. One way to write each thing. If two spellings mean the same, one is banned, by a tool where
   possible.
3. A call shows what it does: whether it can fail, mutate, take ownership, or touch foreign memory.
4. Types carry the rules. A mistake that can be a compile error is one; a comment never holds an
   invariant a type could.
5. Values first: aggregates of regular values. Identity is the exception and its type says so.
6. Control flow is visible: no implicit conversions, `throw` only through `raise()` into
   `contain()`, only the named error macros branch, no mutable global without a named owner.
7. The newest form that reads better and that the pinned toolchain supports; the older idiom is then
   banned.
8. Our memory and foreign memory (owned by someone else: a game, another target) are handled
   differently and never mixed in one expression.

## Types

- A `struct` is a pure aggregate: public data, no constructors, only defaulted `==`/`<=>`. Its
  behavior is free functions beside it.
- A `class` has an invariant: all data private (`m_`), constructors establish it, no plain
  getter/setter pairs (a freely settable field belongs in a struct).
- Identity types (hooks, threads, devices) are classes that can't be copied, via `= delete("why")`;
  movable only if moving makes sense.
- No `init()`. Construction that can fail is a private constructor plus a static named constructor
  returning `result<T>`.
- Rule of zero, except the kit's owning types. No `const` or reference data members.
- A member function needs `m_` access or is a core verb or query; everything else is a free function
  in the type's namespace.
- Polymorphism, one mechanism per situation: concepts at compile time; `variant` with `match` for a
  closed set; an interface (no data, pure virtuals, virtual destructor) with `final` implementations
  for an open set; `function_ref`/`move_only_function` for a single operation; deducing `this`
  instead of const/non-const pairs.
- Inherit only interfaces; no middle layers; never std types. Foreign layout mirrors may mirror the
  target's inheritance.
- Operators: defaulted comparisons; arithmetic only on quantity types, as hidden friends; `|` for
  ranges and flags, `[]` for containers. No user-defined literals of our own.

## Vocabulary

- Counts, indices and offsets are `isize`; `usize` only where std or an ABI demands it. Narrow with
  `narrow<T>`, reinterpret bits with `std::bit_cast`. `std::byte` is opaque memory, `u8` a number.
- `char` holds UTF-8; `std::string` owns, `std::string_view` borrows. `wchar_t` only at the Win32
  boundary, converted at once.

| Spelling                           | Meaning                                                   |
| ---------------------------------- | --------------------------------------------------------- |
| `T`                                | a value                                                   |
| `std::unique_ptr<T>`               | the only owner                                            |
| `T&`                               | borrowed, never null                                      |
| `T*`                               | borrowed, may be null; never owning, never foreign memory |
| `std::span<T>`, `std::string_view` | a borrowed range                                          |

- `std::optional<T>`: absence is normal. `result<T>`: failure with a reason. Never a success `bool`.
- Ids and handles are empty enum classes. Quantities with arithmetic are dedicated types; time is
  `std::chrono` through the injected clock.
- Containers: `std::vector`, `std::array`, `std::flat_map`/`std::flat_set`; `std::unordered_map`
  only with a profiling reason.
- A std gap is filled in `lucent::stdx` with std's name and API, only when first needed.

## Names

- Mutators are verbs; queries are nouns; anything returning or holding a `bool` starts with `is_`,
  `has_`, `can_` or `should_` and states the positive.
- `to_x()` copies, `as_x()` views, `from_x()` constructs. No `try_`: the return type says it.
- Types are nouns, concepts adjectives, enums singular. Suffixes mean one thing: `_id` opaque
  identity, `_handle` index plus serial, `_view` non-owning, `_token` capability. No unit suffixes.
- A variable is named for its role, never after its type.
- Abbreviations only from `id`, `ptr`, `fn`, `ui`, `io`, `rng`, `src`/`dst`; single letters for loop
  indices and math.
- Foreign identifiers keep their own spelling, only inside the foreign-memory layer.

## Declarations and functions

- Local `auto` only when the type is on the same line (casts, `narrow<T>`, `std::make_unique<T>`,
  `T{...}`) or can't be written out (lambdas, views, iterators).
- `T x = value;` for a value of that type; `T x{parts...}` to build one; designated initializers for
  two or more fields, ending with a comma when they span lines; parentheses only where braces pick
  the wrong constructor.
- Parameters: cheap inputs (trivially copyable, two words or less) by value, others by `const T&`;
  borrowed ranges by value; sinks by value then `std::move`. Several outputs are a named struct,
  never `std::pair`/`std::tuple`. A non-const `T&` only for non-copyable types. More than three
  parameters means a parameter struct.
- `noexcept` only on moves, `swap`, and entry points foreign code calls. `constexpr` on pure header
  functions; `consteval` for what must happen at compile time.
- Guard clauses first. A `switch` over our enum has no `default`.
- Range-for; `std::views::enumerate` for an index; a named `std::ranges` algorithm whenever one
  exists; view pipelines of three stages at most, each stage a named function.
- `[&]` only for a lambda that doesn't outlive its statement; otherwise name every capture. A lambda
  over about ten lines becomes a named function.
- `LUCENT_ENSURE` when the world surprised us (the feature gets disabled); `LUCENT_INVARIANT` when
  our own code is wrong (fail fast). Both sit at the top as preconditions.

## Generic code

- Templates and concepts live in kit libraries; feature and domain code declares none.
- Every template parameter is constrained. `C auto x` when the type is named once,
  `template <C T>` when named more, a `requires` clause only for relational constraints. std
  concepts first; ours state meaning, not member checklists.
- One tool per job: `if constexpr`, `requires` expressions, folds and `Ts...[i]`, concepts. Our value
  traits are `is_x` variable templates.

## Threads and foreign memory

- Nothing blocks on a foreign thread. Data crosses threads only through kit primitives; feature and
  domain code never sees a mutex or an atomic.
- Every atomic operation names its memory order; `relaxed` says why it is safe.
- Foreign memory is read by copying values out, never by holding references in. Every value is
  untrusted until validated; every walk over a foreign structure has a bound; a foreign pointer
  doesn't outlive the tick it came from.

## Structure

- One main type or concept per header, named after it; its free functions in the same header.
  Definitions go in the `.cpp` unless template, `constexpr`, or trivial.
- Public headers under `include/lucent/<name>/`, sources and private headers under `src/`.
- std names are always fully qualified; no `using` declarations or namespace aliases, except the
  literal namespaces at function scope.

## Comments

- `//` on its own line above what it explains, in sentences. Never what the code does.
- A public declaration gets a comment only for a contract its types can't express: the thread it
  runs on, how long a borrow must live, a precondition beyond `LUCENT_ENSURE`.
- Hardcoded foreign facts carry `// build:`, `// found:`, `// breaks:` lines citing durable evidence.
- No commented-out code.

## Tests

- `tests/<unit>_test.cpp`, registered by `lucent_test()`; test names are behavior sentences.
- Pure `constexpr` logic is tested only by `static_assert`.
- No mocks of our own code; the foreign layer is tested against a memory source of laid-out bytes.
