#pragma once

#include <functional>
#include <memory>
#include <optional>

#include <lucent/core/flags.hpp>
#include <lucent/core/stdx/function_ref.hpp>
#include <lucent/draw/color.hpp>
#include <lucent/draw/draw_list.hpp>
#include <lucent/draw/rect.hpp>
#include <lucent/draw/vec2.hpp>
#include <lucent/text/text_system.hpp>
#include <lucent/ui/box_style.hpp>
#include <lucent/ui/element_id.hpp>
#include <lucent/ui/input_snapshot.hpp>
#include <lucent/ui/interaction.hpp>
#include <lucent/ui/text_spec.hpp>
#include <lucent/ui/theme.hpp>

namespace lucent::ui {

struct frame_input {
    input_snapshot input;
    theme tokens;
    // In units.
    draw::vec2 viewport;
    // The draw list's: text is laid out at this scale.
    f32 pixels_per_unit = 1.0F;
};

// What the glue keeps from the game until the next frame.
struct frame_report {
    bool wants_mouse = false;
    bool wants_keyboard = false;
};

// A window: a root the user raises by pressing on it.
struct window_spec {
    local_key key{};
    // Its top left, in units.
    draw::vec2 position;
    box_style style;
};

// The root a popup anchored to anchor is declared as.
constexpr auto popup_id(element_id anchor) -> element_id {
    return child_id(anchor, key<"popup">());
}

enum class visibility : u8 {
    shown,
    hidden,
};

// Draws a leaf into the rect layout gave it. Runs in record(), after the declaration has returned,
// so it owns what it draws from.
using custom_draw = std::move_only_function<void(draw::draw_list&, const draw::rect&)>;

// The UI's frame: declared by code each frame, laid out, then recorded. Holds what lives between
// frames (rects for hit-testing, focus, open popups, scroll and motion per id), dropping an id's
// state once it goes a few frames undeclared.
//
// A frame is begin_frame(), declarations, end_frame(), then record() as often as needed. Threads:
// the render thread only, like the text system it borrows, which must outlive it. Declarations
// between frames, or record() before end_frame(), are bugs: invariants.
class context final {
public:
    explicit context(text::text_system& text);

    context(const context&) = delete ("its state is the UI's identity across frames");
    auto operator=(const context&)
        -> context& = delete ("its state is the UI's identity across frames");
    context(context&& other) noexcept;
    auto operator=(context&& other) noexcept -> context&;
    ~context();

    auto begin_frame(frame_input input) -> void;
    // Lays the frame out. Fails only when the text system does.
    auto end_frame() -> result<frame_report>;
    auto record(draw::draw_list& list) -> result<void>;

    // Declaration. Children run inside, before the call returns. An element's id is id_of() its key
    // just before it is declared.
    auto window(const window_spec& spec, stdx::function_ref<void()> children) -> void;
    auto box(local_key key, const box_style& style, stdx::function_ref<void()> children) -> void;
    // Keyed by its place among its siblings.
    auto box(const box_style& style, stdx::function_ref<void()> children) -> void;
    // Clips its children and scrolls them vertically: by the wheel when it is the innermost
    // scroll under the cursor in the topmost root, smoothly.
    auto scroll(local_key key, const box_style& style, stdx::function_ref<void()> children) -> void;
    auto text(const text_spec& spec) -> void;
    auto text(local_key key, const text_spec& spec) -> void;
    auto icon(const text::icon& drawn, draw::color tint) -> void;
    auto custom(local_key key, const box_style& style, custom_draw drawer) -> void;

    // Popups are roots anchored to an element: below it, at least as wide. Opening one from inside
    // a popup nests it; from anywhere else, it closes every other. Escape closes the top one, a
    // press outside closes all above the root pressed, and a popup not declared in a frame closes.
    auto open_popup(element_id anchor) -> void;
    auto close_popup(element_id anchor) -> void;
    auto is_popup_open(element_id anchor) const -> bool;
    // Declares the popup's root when it is open; its children run only then.
    auto popup(element_id anchor, const box_style& style, stdx::function_ref<void()> children)
        -> void;

    // The id key gives an element declared next, under the element being declared now.
    auto id_of(local_key key) const -> element_id;
    auto interact(element_id id, flags<sense> senses) -> interaction;
    auto focus(element_id id) -> void;

    // Motion, per id, on the input's clock. The first call starts at target, except presence,
    // which starts hidden so an element fades in.
    auto approach(element_id id, f32 target) -> f32;
    auto spring(element_id id, f32 target) -> f32;
    // Restarts from where it is whenever target changes, over the theme's normal duration.
    auto tween(element_id id, f32 target) -> f32;
    // 0 to 1 and back over the theme's fast duration, eased. Keep declaring the element while it
    // is above zero.
    auto presence(element_id id, visibility wanted) -> f32;

    auto input() const -> const input_snapshot&;
    auto tokens() const -> const theme&;
    // The last laid-out frame's.
    auto rect(element_id id) const -> std::optional<draw::rect>;
    auto focused() const -> std::optional<element_id>;

private:
    struct state;

    std::unique_ptr<state> m_state;
};

}
