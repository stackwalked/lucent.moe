// The feature ledger as code: every C++26-era feature the dialect relies on, checked against the
// pinned clang-cl and MSVC STL. A toolchain bump that loses one fails here, not somewhere odd.

// NOLINTBEGIN(misc-include-cleaner): every feature-test macro comes from <version> on purpose.
#include <version>

// clang-format off: feature-test values are yyyymm dates, which digit separators would split.

static_assert(__cplusplus > 202302L, "the dialect is C++26 (-std=c++2c)");

static_assert(__cpp_concepts >= 202002L, "concepts and requires are core vocabulary");
static_assert(__cpp_designated_initializers >= 201707L, "designated initializers build values");
static_assert(__cpp_impl_three_way_comparison >= 201907L, "comparisons are defaulted <=>/==");
static_assert(__cpp_consteval >= 202211L, "consteval for what must happen at compile time");
static_assert(__cpp_if_consteval >= 202106L, "if consteval is core vocabulary");
static_assert(__cpp_constinit >= 201907L, "every global is constinit");
static_assert(__cpp_explicit_this_parameter >= 202110L, "deducing this replaces CRTP");
static_assert(__cpp_using_enum >= 201907L, "using enum is core vocabulary");
static_assert(__cpp_structured_bindings >= 202411L, "binding packs are allowed in kit machinery");
static_assert(__cpp_deleted_function >= 202403L, "= delete(\"why\") on tempting overloads");
static_assert(__cpp_placeholder_variables >= 202306L, "_ names unused values");
static_assert(__cpp_static_call_operator >= 202207L, "static operator() is core vocabulary");
static_assert(__cpp_pack_indexing >= 202311L, "Ts...[i] replaces tuple_element tricks");

static_assert(__cpp_lib_expected >= 202211L, "result<T> is std::expected");
static_assert(__cpp_lib_print >= 202406L, "std::print replaces printf and iostreams");
static_assert(__cpp_lib_format >= 202304L, "std::format is core vocabulary");
static_assert(__cpp_lib_ranges >= 202406L, "ranges algorithms replace iterator pairs");
static_assert(__cpp_lib_ranges_zip >= 202110L, "views::zip is core vocabulary");
static_assert(__cpp_lib_ranges_enumerate >= 202302L, "views::enumerate replaces index loops");
static_assert(__cpp_lib_ranges_to_container >= 202202L, "ranges::to is core vocabulary");
static_assert(__cpp_lib_flat_map >= 202511L, "flat_map is the default map");
static_assert(__cpp_lib_flat_set >= 202511L, "flat_set is the default set");
static_assert(__cpp_lib_mdspan >= 202207L, "mdspan for real grids");
static_assert(__cpp_lib_move_only_function >= 202110L, "move_only_function owns callables");
static_assert(__cpp_lib_source_location >= 201907L, "source_location replaces __FILE__/__LINE__");
static_assert(__cpp_lib_bit_cast >= 201806L, "bit_cast reinterprets bits");
static_assert(__cpp_lib_byteswap >= 202110L, "byteswap is core vocabulary");
static_assert(__cpp_lib_to_underlying >= 202102L, "to_underlying is core vocabulary");
static_assert(__cpp_lib_unreachable >= 202202L, "std::unreachable exists, though we fail fast");
static_assert(__cpp_lib_jthread >= 201911L, "kit workers are std::jthread");
static_assert(__cpp_lib_integer_comparison_functions >= 202002L, "narrow is built on in_range");
// NOLINTEND(misc-include-cleaner)
