#pragma once

#include <algorithm>
#include <string_view>
#include <vector>

namespace lucent::text {

constexpr auto is_lead_surrogate(u32 unit) -> bool {
    return unit >= 0xd800 && unit <= 0xdbff;
}

constexpr auto is_trail_surrogate(u32 unit) -> bool {
    return unit >= 0xdc00 && unit <= 0xdfff;
}

constexpr auto utf8_length(u32 code_point) -> isize {
    if (code_point < 0x80) {
        return 1;
    }
    if (code_point < 0x800) {
        return 2;
    }
    return code_point < 0x1'0000 ? 3 : 4;
}

// For every UTF-16 unit of wide, and one past its end, the byte of the UTF-8 it was converted from
// where its code point starts. Exact for well-formed UTF-8; for ill-formed input (converted to
// U+FFFD) the offsets are clamped into it.
constexpr auto utf8_offsets(std::wstring_view wide, isize utf8_size) -> std::vector<isize> {
    std::vector<isize> offsets;
    offsets.reserve(wide.size() + 1);
    isize byte = 0;
    isize unit = 0;
    while (unit < std::ssize(wide)) {
        const auto first = u32{wide.at(static_cast<usize>(unit))};
        const bool is_pair = is_lead_surrogate(first)
                             && unit + 1 < std::ssize(wide)
                             && is_trail_surrogate(u32{wide.at(static_cast<usize>(unit + 1))});
        const u32 code_point = is_pair ? 0x1'0000 + ((first - 0xd800) << 10U)
                                             + (u32{wide.at(static_cast<usize>(unit + 1))} - 0xdc00)
                                       : first;
        const isize clamped = std::min(byte, utf8_size);
        offsets.push_back(clamped);
        if (is_pair) {
            offsets.push_back(clamped);
        }
        byte += utf8_length(code_point);
        unit += is_pair ? 2 : 1;
    }
    offsets.push_back(utf8_size);
    return offsets;
}

// Code units the fast path takes: Latin or common, left-to-right or neutral, never a control, an
// invisible format character, a combining mark, or a space other than U+0020. Their bidi and
// itemization are trivial; whether the face shapes them is asked per glyph.
constexpr auto is_simple_unit(wchar_t unit) -> bool {
    const auto value = u32{unit};
    if (value < 0x20 || (value >= 0x7f && value < 0xa0) || value == 0xa0 || value == 0xad) {
        return false;
    }
    // Basic Latin to Latin Extended-B, then Latin Extended Additional: Latin script or common, so
    // the Latin script analysis shapes them. Combining marks start right after.
    if (value < 0x0250 || (value >= 0x1e00 && value <= 0x1eff)) {
        return true;
    }
    // General Punctuation, without its spaces, joiners, bidi controls and invisible operators.
    if ((value >= 0x2010 && value <= 0x2027) || (value >= 0x2030 && value <= 0x205e)) {
        return true;
    }
    // Currency symbols and letterlike symbols.
    return (value >= 0x20a0 && value <= 0x20cf) || (value >= 0x2100 && value <= 0x214f);
}

// Units between which UAX #14 allows no break, so a run of them breaks only at U+0020: letters,
// digits, and the infix and quotation punctuation that binds to them.
constexpr auto is_wrap_safe_unit(wchar_t unit) -> bool {
    const auto value = u32{unit};
    const bool is_ascii_word = (value >= u32{'a'} && value <= u32{'z'})
                               || (value >= u32{'A'} && value <= u32{'Z'})
                               || (value >= u32{'0'} && value <= u32{'9'});
    const bool is_binding_punctuation = value == u32{' '}
                                        || value == u32{'.'}
                                        || value == u32{','}
                                        || value == u32{':'}
                                        || value == u32{';'}
                                        || value == u32{'\''}
                                        || value == u32{'"'};
    // Latin-1 and Latin Extended-A and -B letters, without the multiplication and division signs.
    const bool is_latin_letter = value >= 0xc0 && value <= 0x024f && value != 0xd7 && value != 0xf7;
    return is_ascii_word || is_binding_punctuation || is_latin_letter;
}

static_assert(utf8_offsets(L"a\u00e9b", 4) == std::vector<isize>{0, 1, 3, 4});
static_assert(utf8_offsets(L"\U0001F600x", 5) == std::vector<isize>{0, 0, 4, 5});
static_assert(
    is_simple_unit(L'A')
    && !is_simple_unit(L'\u05d0')
    && !is_simple_unit(L'\u202e')
    && !is_simple_unit(L'\u0301')
);

}
