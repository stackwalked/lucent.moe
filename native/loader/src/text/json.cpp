#include "text/json.hpp"

#include <charconv>
#include <expected>
#include <format>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <system_error>
#include <utility>

#include <lucent/core/match.hpp>

namespace lucent::loader {
namespace {

auto malformed() -> std::unexpected<error> {
    return std::unexpected(error{.code = error_code::malformed});
}

auto begin_of(std::string_view text) -> const char* {
    return std::to_address(text.begin());
}

auto end_of(std::string_view text) -> const char* {
    return std::to_address(text.end());
}

auto is_space(char letter) -> bool {
    return letter == ' ' || letter == '\t' || letter == '\n' || letter == '\r';
}

auto utf8_of(u32 point) -> std::string {
    std::string encoded;
    if (point < 0x80) {
        encoded.push_back(static_cast<char>(point));
    } else if (point < 0x800) {
        encoded.push_back(static_cast<char>(0xc0U | (point >> 6U)));
        encoded.push_back(static_cast<char>(0x80U | (point & 0x3fU)));
    } else if (point < 0x10000) {
        encoded.push_back(static_cast<char>(0xe0U | (point >> 12U)));
        encoded.push_back(static_cast<char>(0x80U | ((point >> 6U) & 0x3fU)));
        encoded.push_back(static_cast<char>(0x80U | (point & 0x3fU)));
    } else {
        encoded.push_back(static_cast<char>(0xf0U | (point >> 18U)));
        encoded.push_back(static_cast<char>(0x80U | ((point >> 12U) & 0x3fU)));
        encoded.push_back(static_cast<char>(0x80U | ((point >> 6U) & 0x3fU)));
        encoded.push_back(static_cast<char>(0x80U | (point & 0x3fU)));
    }
    return encoded;
}

// Reads the text one value at a time; every read fails as malformed rather than guessing.
class reader final {
public:
    explicit reader(std::string_view text)
        : m_text{text} {}

    auto skip_space() -> void {
        while (m_at < m_text.size() && is_space(m_text.at(m_at))) {
            ++m_at;
        }
    }

    auto is_done() const -> bool {
        return m_at == m_text.size();
    }

    auto peek() const -> std::optional<char> {
        if (m_at == m_text.size()) {
            return std::nullopt;
        }
        return m_text.at(m_at);
    }

    auto take(char expected) -> bool {
        if (peek() != expected) {
            return false;
        }
        ++m_at;
        return true;
    }

    auto take_word(std::string_view word) -> bool {
        if (!m_text.substr(m_at).starts_with(word)) {
            return false;
        }
        m_at += word.size();
        return true;
    }

    auto string() -> result<std::string> {
        if (!take('"')) {
            return malformed();
        }
        std::string value;
        while (true) {
            const std::optional<char> next = peek();
            if (!next || static_cast<u8>(*next) < 0x20) {
                return malformed();
            }
            ++m_at;
            if (*next == '"') {
                return value;
            }
            if (*next != '\\') {
                value.push_back(*next);
                continue;
            }
            LUCENT_TRY(escape(value));
        }
    }

    auto integer() -> result<i64> {
        const usize start = m_at;
        if (peek() == '-') {
            ++m_at;
        }
        while (peek() && *peek() >= '0' && *peek() <= '9') {
            ++m_at;
        }
        const std::string_view digits = m_text.substr(start, m_at - start);
        // A leading zero, a fraction and an exponent are all legal JSON no reply uses.
        if (peek() == '.'
            || peek() == 'e'
            || peek() == 'E'
            || (digits.size() > 1 && digits.front() == '0')) {
            return malformed();
        }
        i64 value = 0;
        const std::from_chars_result parsed =
            std::from_chars(begin_of(digits), end_of(digits), value);
        if (parsed.ec != std::errc{} || parsed.ptr != end_of(digits)) {
            return malformed();
        }
        return value;
    }

private:
    auto hex4() -> result<u32> {
        if (m_text.size() - m_at < 4) {
            return malformed();
        }
        u32 value = 0;
        const std::string_view digits = m_text.substr(m_at, 4);
        const std::from_chars_result parsed =
            std::from_chars(begin_of(digits), end_of(digits), value, 16);
        if (parsed.ec != std::errc{} || parsed.ptr != end_of(digits)) {
            return malformed();
        }
        m_at += 4;
        return value;
    }

    auto escape(std::string& into) -> result<void> {
        const std::optional<char> kind = peek();
        if (!kind) {
            return malformed();
        }
        ++m_at;
        switch (*kind) {
        case '"':
        case '\\':
        case '/':
            into.push_back(*kind);
            return {};
        case 'b':
            into.push_back('\b');
            return {};
        case 'f':
            into.push_back('\f');
            return {};
        case 'n':
            into.push_back('\n');
            return {};
        case 'r':
            into.push_back('\r');
            return {};
        case 't':
            into.push_back('\t');
            return {};
        case 'u':
            return unicode_escape(into);
        default:
            return malformed();
        }
    }

    // RFC 8259 §7: a code point above the BMP is a surrogate pair of two escapes; a lone
    // surrogate is refused, since it has no UTF-8 spelling.
    auto unicode_escape(std::string& into) -> result<void> {
        const u32 first = LUCENT_TRY(hex4());
        if (first >= 0xdc00 && first <= 0xdfff) {
            return malformed();
        }
        if (first < 0xd800 || first > 0xdbff) {
            into.append(utf8_of(first));
            return {};
        }
        if (!take_word("\\u")) {
            return malformed();
        }
        const u32 second = LUCENT_TRY(hex4());
        if (second < 0xdc00 || second > 0xdfff) {
            return malformed();
        }
        into.append(utf8_of(0x10000 + ((first - 0xd800) << 10U) + (second - 0xdc00)));
        return {};
    }

    std::string_view m_text;
    usize m_at = 0;
};

// A member's value, or nothing for the literals the loader drops.
auto value_of(reader& text) -> result<std::optional<json_value>> {
    const std::optional<char> next = text.peek();
    if (next == '"') {
        return json_value{LUCENT_TRY(text.string())};
    }
    if (next == '-' || (next && *next >= '0' && *next <= '9')) {
        return json_value{LUCENT_TRY(text.integer())};
    }
    if (text.take_word("true") || text.take_word("false") || text.take_word("null")) {
        return std::nullopt;
    }
    return malformed();
}

// One "name": value pair; a repeated name is refused, a dropped literal leaves no member.
auto read_member(reader& input, json_object& object) -> result<void> {
    input.skip_space();
    std::string name = LUCENT_TRY(input.string());
    input.skip_space();
    if (!input.take(':')) {
        return malformed();
    }
    input.skip_space();
    const std::optional<json_value> value = LUCENT_TRY(value_of(input));
    if (object.contains(name)) {
        return malformed();
    }
    if (value) {
        object.emplace(std::move(name), *value);
    }
    return {};
}

}

auto to_json_string(std::string_view text) -> std::string {
    std::string quoted{"\""};
    for (const char letter : text) {
        switch (letter) {
        case '"':
            quoted.append("\\\"");
            break;
        case '\\':
            quoted.append("\\\\");
            break;
        default:
            if (static_cast<u8>(letter) < 0x20) {
                quoted.append(std::format("\\u{:04x}", static_cast<u32>(letter)));
            } else {
                quoted.push_back(letter);
            }
        }
    }
    quoted.push_back('"');
    return quoted;
}

auto parse_flat_object(std::string_view text) -> result<json_object> {
    reader input{text};
    json_object object;
    input.skip_space();
    if (!input.take('{')) {
        return malformed();
    }
    input.skip_space();
    if (!input.take('}')) {
        while (true) {
            LUCENT_TRY(read_member(input, object));
            input.skip_space();
            if (input.take('}')) {
                break;
            }
            if (!input.take(',')) {
                return malformed();
            }
        }
    }
    input.skip_space();
    if (!input.is_done()) {
        return malformed();
    }
    return object;
}

auto string_member(const json_object& object, std::string_view name) -> std::optional<std::string> {
    const auto found = object.find(std::string{name});
    if (found == object.end()) {
        return std::nullopt;
    }
    return match(
        found->second,
        [](const std::string& text) { return std::optional<std::string>{text}; },
        [](const i64& /*number*/) { return std::optional<std::string>{}; }
    );
}

auto integer_member(const json_object& object, std::string_view name) -> std::optional<i64> {
    const auto found = object.find(std::string{name});
    if (found == object.end()) {
        return std::nullopt;
    }
    return match(
        found->second,
        [](const std::string& /*text*/) { return std::optional<i64>{}; },
        [](const i64& number) { return std::optional<i64>{number}; }
    );
}

}
