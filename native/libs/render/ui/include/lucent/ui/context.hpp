#pragma once

#include <functional>
#include <memory>
#include <optional>
#include <string_view>

#include <lucent/core/flags.hpp>
#include <lucent/core/stdx/function_ref.hpp>
#include <lucent/draw/color.hpp>
#include <lucent/draw/draw_list.hpp>
#include <lucent/draw/rect.hpp>
#include <lucent/draw/vec2.hpp>
#include <lucent/text/text_layout.hpp>
#include <lucent/text/text_system.hpp>
#include <lucent/ui/box_style.hpp>
#include <lucent/ui/clipboard.hpp>
#include <lucent/ui/edit_buffer.hpp>
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
    // The glue's, borrowed for the frame; without one, text fields neither copy nor paste.
    clipboard* system_clipboard = nullptr;
};

// What the glue keeps from the game until the next frame.
struct frame_report {
    bool wants_mouse = false;
    bool wants_keyboard = false;
};

enum class input_policy : u8 {
    // The window is hit, raised by a press, and makes the UI want the mouse while under it.
    taken,
    // Input passes through it to what is below, as through a tooltip.
    passed,
};

// A window: a root the user raises by pressing on it.
struct window_spec {
    local_key key{};
    // Its top left, in units.
    draw::vec2 position;
    box_style style;
    input_policy input = input_policy::taken;
};

// The root a popup anchored to anchor is declared as.
constexpr auto popup_id(element_id anchor) -> element_id {
    return child_id(anchor, key<"popup">());
}

// The root a tooltip on anchor is declared as.
constexpr auto tooltip_id(element_id anchor) -> element_id {
    return child_id(anchor, key<"tooltip">());
}

// The thumb of a scroll's rail: what interact() reports pressed while it is dragged.
constexpr auto rail_id(element_id scroll) -> element_id {
    return child_id(scroll, key<"rail">());
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
    // scroll under the cursor in the topmost root, smoothly, and by dragging its rail.
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
    // Declares a root above everything, below anchor, once the cursor has rested on anchor for the
    // theme's tooltip delay with no button held. Input passes through it. Its children run only
    // while it shows.
    auto tooltip(element_id anchor, const box_style& style, stdx::function_ref<void()> children)
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

    // A text field's state, made from utf8 the first time the id asks. Valid until end_frame().
    auto field(element_id id, std::string_view utf8) -> field_memory&;
    // Lays text out as a text leaf with it would be at max_width, at this frame's scale. Valid
    // until the text system's next frame.
    auto measure(const text_spec& spec, f32 max_width) -> result<const text::text_layout*>;

    // A number kept for id between frames, dropped with the id's other state; absent until kept.
    auto kept(element_id id) const -> std::optional<f32>;
    auto keep(element_id id, f32 value) -> void;

    auto input() const -> const input_snapshot&;
    auto tokens() const -> const theme&;
    auto system_clipboard() const -> clipboard*;
    // In units.
    auto viewport() const -> draw::vec2;
    // The last laid-out frame's.
    auto rect(element_id id) const -> std::optional<draw::rect>;
    auto focused() const -> std::optional<element_id>;

private:
    struct state;

    std::unique_ptr<state> m_state;
};

}
