#pragma once

#include <array>
#include <chrono>
#include <cstddef>
#include <limits>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include <lucent/core/stdx/function_ref.hpp>
#include <lucent/draw/color.hpp>
#include <lucent/draw/rect.hpp>
#include <lucent/draw/vec2.hpp>
#include <lucent/os/file.hpp>
#include <lucent/text/text_system.hpp>
#include <lucent/ui/clipboard.hpp>
#include <lucent/ui/context.hpp>
#include <lucent/ui/input_snapshot.hpp>
#include <lucent/ui/theme.hpp>

namespace lucent::ui::testing {

inline constexpr draw::vec2 viewport{.x = 800.0F, .y = 600.0F};
inline constexpr draw::color accent{.r = 90, .g = 140, .b = 250, .a = 255};

// A text system with IBM Plex Sans (Latin subset), the text library's fixture font, as its one
// face; a missing fixture is a broken checkout, not a test outcome.
struct fixture_text {
    text::text_system text;
    text::face_id plex{};
};

inline auto plex_text() -> fixture_text {
    result<text::text_system> made = text::text_system::create({
        .raster_budget = 64,
        .layout_lifetime = 4,
        .atlas = {.page_size = draw::atlas_page_size, .page_count = draw::atlas_page_count},
    });
    LUCENT_INVARIANT(made.has_value());
    result<std::vector<std::byte>> bytes =
        os::read_file(std::string{LUCENT_UI_FIXTURES_DIR} + "/ibm-plex-sans-400.woff2");
    LUCENT_INVARIANT(bytes.has_value());
    const result<text::face_id> plex = made->add_face(*bytes);
    LUCENT_INVARIANT(plex.has_value());
    return {.text = *std::move(made), .plex = *plex};
}

enum class motion_preference : u8 {
    full,
    reduced,
};

inline auto test_theme(text::face_id face, motion_preference motion) -> theme {
    return derive_theme({
        .accent = accent,
        .preset = theme_preset::dark,
        .scale = 1.0F,
        .is_reduced_motion = motion == motion_preference::reduced,
        .backdrop = std::nullopt,
        .text_face = face,
        .numeric_face = face,
    });
}

// The injected clock's time a test frame is built at: a fixed epoch plus the test's own count.
inline auto at(std::chrono::milliseconds since_start) -> std::chrono::steady_clock::time_point {
    return std::chrono::steady_clock::time_point{} + std::chrono::hours{1} + since_start;
}

// Drives a context frame by frame from snapshots, on a test clock that steps 16 ms a frame.
class driver final {
public:
    driver(text::text_system& text, const theme& tokens)
        : m_ui{text}
        , m_tokens{tokens} {}

    auto ui() -> context& {
        return m_ui;
    }

    // The last frame's.
    auto report() const -> frame_report {
        return m_report;
    }

    // Borrowed from now on; it must outlive the driver's frames.
    auto lend(clipboard& shared) -> void {
        m_clipboard = &shared;
    }

    // Moves the clock on before the next frame, on top of the usual step.
    auto wait(std::chrono::milliseconds span) -> void {
        m_now += span;
    }

    // One frame: input as given (its time is the driver's), the declaration, then layout.
    auto step(input_snapshot input, stdx::function_ref<void()> declare) -> void {
        m_now += std::chrono::milliseconds{16};
        input.time = at(m_now);
        m_ui.begin_frame({
            .input = std::move(input),
            .tokens = m_tokens,
            .viewport = viewport,
            .pixels_per_unit = 1.0F,
            .system_clipboard = m_clipboard,
        });
        declare();
        result<frame_report> laid_out = m_ui.end_frame();
        LUCENT_INVARIANT(laid_out.has_value());
        m_report = *laid_out;
    }

    auto step(stdx::function_ref<void()> declare) -> void {
        const input_snapshot idle;
        step(idle, declare);
    }

private:
    context m_ui;
    theme m_tokens;
    std::chrono::milliseconds m_now{};
    frame_report m_report;
    clipboard* m_clipboard = nullptr;
};

// The glue's clipboard stood in for by a string.
class memory_clipboard final : public clipboard {
public:
    memory_clipboard() = default;

    auto text() const -> std::optional<std::string> override {
        return m_text;
    }

    auto put_text(std::string_view utf8) -> void override {
        m_text = std::string{utf8};
    }

private:
    std::optional<std::string> m_text;
};

// The last laid-out frame's rect; a test that asks for an element it never declared is wrong.
inline auto rect_of(const context& frame, element_id id) -> draw::rect {
    const std::optional<draw::rect> found = frame.rect(id);
    LUCENT_INVARIANT(found.has_value());
    return *found;
}

inline auto hover(draw::vec2 cursor) -> input_snapshot {
    input_snapshot input;
    input.cursor = cursor;
    return input;
}

inline auto press(draw::vec2 cursor) -> input_snapshot {
    input_snapshot input = hover(cursor);
    input.left = {.is_down = true, .click_count = 1, .is_released = false};
    return input;
}

inline auto hold(draw::vec2 cursor) -> input_snapshot {
    input_snapshot input = hover(cursor);
    input.left = {.is_down = true, .click_count = 0, .is_released = false};
    return input;
}

inline auto release(draw::vec2 cursor) -> input_snapshot {
    input_snapshot input = hover(cursor);
    input.left = {.is_down = false, .click_count = 0, .is_released = true};
    return input;
}

inline auto keys(const std::vector<key_event>& events) -> input_snapshot {
    input_snapshot input;
    for (const key_event& event : events) {
        input.keyboard.emplace_back(event);
    }
    return input;
}

inline auto typed(std::string utf8) -> input_snapshot {
    input_snapshot input;
    input.keyboard.emplace_back(typed_text{.utf8 = std::move(utf8)});
    return input;
}

inline auto pressed(key_code code) -> key_event {
    return {.code = code, .action = key_action::pressed};
}

// A rect's edges as left, top, right, bottom; NaN when there is no rect. Compared as an array, so a
// check shows every edge.
inline auto edges(const std::optional<draw::rect>& area) -> std::array<f32, 4> {
    if (!area) {
        const f32 none = std::numeric_limits<f32>::quiet_NaN();
        return {none, none, none, none};
    }
    return {area->min.x, area->min.y, area->max.x, area->max.y};
}

inline auto centre(const draw::rect& area) -> draw::vec2 {
    return {.x = (area.min.x + area.max.x) / 2.0F, .y = (area.min.y + area.max.y) / 2.0F};
}

}
