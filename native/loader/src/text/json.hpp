#pragma once

#include <flat_map>
#include <optional>
#include <string>
#include <string_view>
#include <variant>

// The little JSON the loader touches: the JOSE header and claims it writes, and the OAuth replies
// it reads (RFC 6749 §5.1 and §5.2), which are flat objects of strings and numbers. Anything
// nested is refused rather than half read.

namespace lucent::loader {

// The text as a JSON string, quotes included.
auto to_json_string(std::string_view text) -> std::string;

// A member's value: a string, or an integer. true, false and null parse and are dropped, since no
// reply the loader reads needs them.
using json_value = std::variant<std::string, i64>;

using json_object = std::flat_map<std::string, json_value>;

// Exactly one object, with whitespace around it and nothing else; a duplicate name, a fraction,
// an exponent or a nested value is malformed.
auto parse_flat_object(std::string_view text) -> result<json_object>;

auto string_member(const json_object& object, std::string_view name) -> std::optional<std::string>;
auto integer_member(const json_object& object, std::string_view name) -> std::optional<i64>;

}
