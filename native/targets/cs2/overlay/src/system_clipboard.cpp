#include <lucent/cs2-overlay/system_clipboard.hpp>

#include <algorithm>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <tuple>

#include <Windows.h>

#include <lucent/core/text.hpp>

namespace lucent::cs2::overlay {
namespace {

// Opens the clipboard for the life of the scope, if it can.
class open_clipboard final {
public:
    open_clipboard()
        : m_is_open{OpenClipboard(nullptr) != FALSE} {}

    open_clipboard(const open_clipboard&) = delete ("closes the clipboard once");
    auto operator=(const open_clipboard&) -> open_clipboard& = delete ("closes the clipboard once");
    open_clipboard(open_clipboard&&) = delete ("closes the clipboard once");
    auto operator=(open_clipboard&&) -> open_clipboard& = delete ("closes the clipboard once");

    ~open_clipboard() {
        if (m_is_open) {
            std::ignore = CloseClipboard();
        }
    }

    auto is_open() const -> bool {
        return m_is_open;
    }

private:
    bool m_is_open = false;
};

}

auto system_clipboard::text() const -> std::optional<std::string> {
    const open_clipboard opened;
    if (!opened.is_open()) {
        return std::nullopt;
    }
    HANDLE data = GetClipboardData(CF_UNICODETEXT);
    if (data == nullptr) {
        return std::nullopt;
    }
    const auto* const units = static_cast<const wchar_t*>(GlobalLock(data));
    if (units == nullptr) {
        return std::nullopt;
    }
#pragma clang diagnostic push
// GlobalSize is the block's size.
#pragma clang diagnostic ignored "-Wunsafe-buffer-usage-in-container"
    const std::span<const wchar_t> block{units, GlobalSize(data) / sizeof(wchar_t)};
#pragma clang diagnostic pop
    // CF_UNICODETEXT is terminated; the block bounds the scan should it not be.
    const auto end = std::ranges::find(block, L'\0');
    std::string utf8 = to_utf8(std::wstring_view{block.begin(), end});
    std::ignore = GlobalUnlock(data);
    return utf8;
}

auto system_clipboard::put_text(std::string_view utf8) -> void {
    const std::wstring units = to_wide(utf8);
    const open_clipboard opened;
    if (!opened.is_open() || EmptyClipboard() == FALSE) {
        return;
    }
    const usize bytes = (units.size() + 1) * sizeof(wchar_t);
    HGLOBAL owned = GlobalAlloc(GMEM_MOVEABLE, bytes);
    if (owned == nullptr) {
        return;
    }
    auto* const target = static_cast<wchar_t*>(GlobalLock(owned));
    if (target == nullptr) {
        std::ignore = GlobalFree(owned);
        return;
    }
#pragma clang diagnostic push
// Allocated for the units and the terminator.
#pragma clang diagnostic ignored "-Wunsafe-buffer-usage-in-container"
    const std::span<wchar_t> block{target, units.size() + 1};
#pragma clang diagnostic pop
    std::ranges::copy(std::wstring_view{units.c_str(), units.size() + 1}, block.begin());
    std::ignore = GlobalUnlock(owned);
    // The clipboard owns the memory once this succeeds.
    if (SetClipboardData(CF_UNICODETEXT, owned) == nullptr) {
        std::ignore = GlobalFree(owned);
    }
}

}
