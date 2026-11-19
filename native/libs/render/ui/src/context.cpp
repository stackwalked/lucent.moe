#include <lucent/ui/context.hpp>

#include <algorithm>
#include <chrono>
#include <flat_map>
#include <iterator>
#include <memory>
#include <optional>
#include <ranges>
#include <string>
#include <utility>
#include <vector>

#include <lucent/core/flags.hpp>
#include <lucent/core/narrow.hpp>
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
#include <lucent/ui/motion.hpp>
#include <lucent/ui/text_spec.hpp>
#include <lucent/ui/theme.hpp>

#include "element.hpp"
#include "layout.hpp"
#include "record.hpp"

namespace lucent::ui {
namespace {

using detail::element;
using detail::root_entry;
using detail::root_layer;

// An id's state outlives a frame it isn't declared in by this many, so an element hidden for a
// frame or two (a tab switched away and back) keeps its scroll and motion.
constexpr i64 forget_after = 3;

// A leaf that only draws: laid out by its content alone.
constexpr box_style unstyled{};

struct motion_memory {
    f32 value = 0.0F;
    f32 velocity = 0.0F;
    std::chrono::nanoseconds pending{};
    f32 from = 0.0F;
    f32 target = 0.0F;
    std::chrono::steady_clock::time_point started;
    i64 stepped_frame = -1;
    bool is_started = false;
};

struct id_memory {
    i64 last_seen = 0;
    motion_memory motion;
    f32 scroll_target = 0.0F;
    f32 scroll_limit = 0.0F;
    // Windows stack by this: higher is nearer the top.
    i64 raised_at = 0;
};

struct last_element {
    element_id id{};
    draw::rect rect;
    // The rect cut by its clips: what could be hit.
    draw::rect visible;
    element_id root{};
};

struct last_root {
    element_id id{};
    draw::rect rect;
};

struct last_scroll {
    element_id id{};
    element_id root{};
    draw::rect visible;
};

struct focusable {
    element_id id{};
    element_id root{};
};

auto contains(const draw::rect& area, draw::vec2 point) -> bool {
    return point.x >= area.min.x
           && point.y >= area.min.y
           && point.x < area.max.x
           && point.y < area.max.y;
}

auto seconds(std::chrono::nanoseconds span) -> f32 {
    return std::chrono::duration<f32>{span}.count();
}

auto anonymous_key(isize ordinal) -> local_key {
    return local_key{detail::mixed(detail::anonymous_seed ^ static_cast<u64>(ordinal))};
}

}

struct context::state {
    explicit state(text::text_system& borrowed)
        : text{&borrowed} {}

    text::text_system* text;
    frame_input frame;
    bool is_declaring = false;
    bool is_laid_out = false;
    i64 frame_number = 0;
    std::chrono::nanoseconds step{};
    std::optional<std::chrono::steady_clock::time_point> previous_time;

    // This frame's declaration.
    std::vector<element> elements;
    std::vector<root_entry> roots;
    std::vector<isize> open;
    std::string strings;
    std::vector<custom_draw> drawers;
    std::vector<focusable> focusables;
    std::vector<element_id> declared_popups;
    bool is_press_claimed = false;

    // The last laid-out frame's, for hit-testing this one. last_elements is sorted by id.
    std::vector<last_element> last_elements;
    std::vector<last_root> last_roots;
    std::vector<last_scroll> last_scrolls;
    std::vector<focusable> last_focusables;
    std::vector<isize> root_order;

    // Across frames.
    std::flat_map<element_id, id_memory> memory;
    std::optional<element_id> focus;
    // Focus as this frame's keys found it: only what held it then is activated by them, not what
    // takes it during the declaration.
    std::optional<element_id> key_focus;
    std::optional<element_id> active;
    // Anchors of the open popups, bottom to top.
    std::vector<element_id> popups;
    std::optional<element_id> hovered_root;
    i64 next_raise = 0;

    auto last(element_id id) const -> const last_element* {
        const auto found = std::ranges::lower_bound(last_elements, id, {}, &last_element::id);
        if (found == last_elements.end() || found->id != id) {
            return nullptr;
        }
        return &*found;
    }

    // Motion starting at rest on value, this frame.
    auto begun_motion(f32 value) const -> motion_memory {
        motion_memory begun;
        begun.value = value;
        begun.from = value;
        begun.target = value;
        begun.started = frame.input.time;
        begun.stepped_frame = frame_number;
        begun.is_started = true;
        return begun;
    }

    auto remembered(element_id id) -> id_memory& {
        id_memory& entry = memory[id];
        entry.last_seen = frame_number;
        return entry;
    }

    auto current_root() const -> const root_entry* {
        if (open.empty()) {
            return nullptr;
        }
        return &roots.at(narrow<usize>(elements.at(narrow<usize>(open.back())).root));
    }

    auto popup_index(element_id anchor) const -> std::optional<isize> {
        const auto found = std::ranges::find(popups, anchor);
        if (found == popups.end()) {
            return std::nullopt;
        }
        return std::distance(popups.begin(), found);
    }

    auto close_popups_above(isize keep) -> void {
        popups.resize(narrow<usize>(std::clamp(keep, isize{0}, std::ssize(popups))));
    }

    auto push_root(element_id id, const box_style& style, root_entry entry) -> isize {
        LUCENT_INVARIANT(is_declaring);
        const isize index = std::ssize(elements);
        entry.element = index;
        roots.push_back(entry);
        elements.push_back({
            .id = id,
            .style = style,
            .content = detail::no_leaf{},
            .root = std::ssize(roots) - 1,
            .end = index + 1,
        });
        return index;
    }

    auto push_child(element_id id, const box_style& style, detail::leaf content) -> void {
        LUCENT_INVARIANT(is_declaring && !open.empty());
        const isize index = std::ssize(elements);
        const isize parent_index = open.back();
        element& parent = elements.at(narrow<usize>(parent_index));
        if (parent.last_child == -1) {
            parent.first_child = index;
        } else {
            elements.at(narrow<usize>(parent.last_child)).next_sibling = index;
        }
        parent.last_child = index;
        ++parent.child_count;
        const isize root = parent.root;
        elements.push_back({
            .id = id,
            .style = style,
            .content = content,
            .parent = parent_index,
            .root = root,
            .end = index + 1,
        });
        if (const auto found = memory.find(id); found != memory.end()) {
            found->second.last_seen = frame_number;
        }
    }

    auto push_text(element_id id, const text_spec& spec) -> void {
        const isize begin = std::ssize(strings);
        strings.append(spec.utf8);
        push_child(
            id,
            unstyled,
            detail::text_leaf{
                .begin = begin,
                .size = std::ssize(spec.utf8),
                .style = spec.style,
                .ink = spec.ink,
                .wrap = spec.wrap,
                .overflow = spec.overflow,
                .max_lines = spec.max_lines,
                .natural_width = 0.0F,
                .laid_out = nullptr,
            }
        );
    }

    auto anonymous_id() const -> element_id {
        LUCENT_INVARIANT(!open.empty());
        const element& parent = elements.at(narrow<usize>(open.back()));
        return child_id(parent.id, anonymous_key(parent.child_count));
    }

    auto declare_children(isize index, stdx::function_ref<void()> children) -> void {
        open.push_back(index);
        children();
        open.pop_back();
        elements.at(narrow<usize>(index)).end = std::ssize(elements);
    }

    auto hit_root() const -> std::optional<element_id> {
        if (!frame.input.cursor) {
            return std::nullopt;
        }
        const auto topmost =
            std::ranges::find_if(std::views::reverse(last_roots), [&](const last_root& root) {
                return contains(root.rect, *frame.input.cursor);
            });
        if (topmost == std::views::reverse(last_roots).end()) {
            return std::nullopt;
        }
        return topmost->id;
    }

    auto is_on_popup_anchor() const -> bool {
        return std::ranges::any_of(popups, [&](element_id anchor) {
            const last_element* const seen = last(anchor);
            return seen != nullptr
                   && frame.input.cursor
                   && seen->root == hovered_root
                   && contains(seen->visible, *frame.input.cursor);
        });
    }

    // A press closes the popups above the root it lands in, all of them when it lands outside
    // every popup, except a press on a popup's own anchor, which leaves the anchor to decide.
    auto take_press() -> void {
        if (frame.input.left.click_count == 0) {
            return;
        }
        const auto on_popup = std::ranges::find_if(popups, [&](element_id anchor) {
            return hovered_root == popup_id(anchor);
        });
        if (on_popup != popups.end()) {
            close_popups_above(std::distance(popups.begin(), on_popup) + 1);
            return;
        }
        if (!is_on_popup_anchor()) {
            popups.clear();
        }
        if (hovered_root) {
            remembered(*hovered_root).raised_at = ++next_raise;
        }
    }

    auto move_focus(isize direction) -> void {
        std::vector<element_id> order;
        for (const focusable& candidate : last_focusables) {
            if (popups.empty() || candidate.root == popup_id(popups.back())) {
                order.push_back(candidate.id);
            }
        }
        if (order.empty()) {
            return;
        }
        const auto current = focus ? std::ranges::find(order, *focus) : order.end();
        if (current == order.end()) {
            focus = direction > 0 ? order.front() : order.back();
            return;
        }
        const isize count = std::ssize(order);
        const isize next = (std::distance(order.begin(), current) + direction + count) % count;
        focus = order.at(narrow<usize>(next));
    }

    auto take_keys() -> void {
        const bool is_backward = frame.input.modifiers.has(modifier::shift);
        for (const key_event& event : frame.input.keys) {
            if (event.action == key_action::released) {
                continue;
            }
            switch (event.code) {
            case key_code::escape:
                if (event.action != key_action::pressed) {
                    break;
                }
                if (!popups.empty()) {
                    popups.pop_back();
                } else {
                    focus.reset();
                }
                break;
            case key_code::tab:
                move_focus(is_backward ? -1 : 1);
                break;
            case key_code::up:
            case key_code::down:
                if (!popups.empty()) {
                    move_focus(event.code == key_code::down ? 1 : -1);
                }
                break;
            case key_code::enter:
            case key_code::space:
            case key_code::backspace:
            case key_code::left:
            case key_code::right:
            case key_code::home:
            case key_code::end:
            case key_code::page_up:
            case key_code::page_down:
                break;
            }
        }
    }

    // The wheel scrolls the innermost scroll under the cursor in the topmost root: scrolls are
    // listed in declaration order, so a nested one comes after the scroll holding it.
    auto take_wheel() -> void {
        if (frame.input.wheel.y == 0.0F || !frame.input.cursor || !hovered_root) {
            return;
        }
        const last_scroll* target = nullptr;
        for (const last_scroll& scroll : last_scrolls) {
            if (scroll.root == *hovered_root && contains(scroll.visible, *frame.input.cursor)) {
                target = &scroll;
            }
        }
        if (target == nullptr) {
            return;
        }
        id_memory& scrolled = remembered(target->id);
        scrolled.scroll_target = std::clamp(
            scrolled.scroll_target - (frame.input.wheel.y * frame.tokens.controls.wheel_step),
            0.0F,
            scrolled.scroll_limit
        );
    }

    auto keep_declared_popups() -> void {
        for (isize index = 0; index < std::ssize(popups); ++index) {
            if (std::ranges::find(declared_popups, popups.at(narrow<usize>(index)))
                == declared_popups.end()) {
                close_popups_above(index);
                return;
            }
        }
    }

    auto remember_layout() -> void {
        last_elements.clear();
        last_scrolls.clear();
        for (element& laid_out : elements) {
            const draw::rect area = detail::rect_of(laid_out);
            const element_id root = roots.at(narrow<usize>(laid_out.root)).id;
            last_elements.push_back({
                .id = laid_out.id,
                .rect = area,
                .visible = draw::intersect(area, laid_out.clip),
                .root = root,
            });
            if (laid_out.is_scroll) {
                last_scrolls.push_back({
                    .id = laid_out.id,
                    .root = root,
                    .visible = draw::intersect(area, laid_out.clip),
                });
                id_memory& scrolled = remembered(laid_out.id);
                scrolled.scroll_limit =
                    std::max(laid_out.extent[detail::y_axis] - laid_out.size[detail::y_axis], 0.0F);
                scrolled.scroll_target =
                    std::clamp(scrolled.scroll_target, 0.0F, scrolled.scroll_limit);
            }
        }
        std::ranges::sort(last_elements, {}, &last_element::id);
        // Two siblings with one key would share every bit of state: a caller's bug.
        LUCENT_INVARIANT(
            std::ranges::adjacent_find(last_elements, {}, &last_element::id) == last_elements.end()
        );
        last_focusables = std::move(focusables);
        focusables.clear();
    }

    auto stack_roots() -> void {
        root_order.clear();
        for (const root_entry& entry : roots) {
            if (entry.layer == root_layer::window) {
                root_order.push_back(entry.element);
            }
        }
        std::ranges::stable_sort(root_order, {}, [&](isize index) {
            return remembered(elements.at(narrow<usize>(index)).id).raised_at;
        });
        for (const element_id anchor : popups) {
            const auto found = std::ranges::find(roots, popup_id(anchor), &root_entry::id);
            if (found != roots.end()) {
                root_order.push_back(found->element);
            }
        }
        last_roots.clear();
        for (const isize index : root_order) {
            const element& root = elements.at(narrow<usize>(index));
            last_roots.push_back({.id = root.id, .rect = detail::rect_of(root)});
        }
    }

    auto forget_unseen() -> void {
        std::erase_if(memory, [&](const auto& entry) {
            return entry.second.last_seen < frame_number - forget_after;
        });
    }

    auto wants_mouse() const -> bool {
        if (active) {
            return true;
        }
        if (!frame.input.cursor) {
            return false;
        }
        return std::ranges::any_of(last_roots, [&](const last_root& root) {
            return contains(root.rect, *frame.input.cursor);
        });
    }
};

context::context(text::text_system& text)
    : m_state{std::make_unique<state>(text)} {}

context::context(context&& other) noexcept = default;
auto context::operator=(context&& other) noexcept -> context& = default;
context::~context() = default;

auto context::begin_frame(frame_input input) -> void {
    state& self = *m_state;
    LUCENT_INVARIANT(!self.is_declaring);
    self.step = self.previous_time ? std::clamp<std::chrono::nanoseconds>(
                                         input.input.time - *self.previous_time,
                                         std::chrono::nanoseconds{0},
                                         max_frame_step
                                     )
                                   : std::chrono::nanoseconds{0};
    self.previous_time = input.input.time;
    ++self.frame_number;
    self.frame = std::move(input);
    self.elements.clear();
    self.roots.clear();
    self.open.clear();
    self.strings.clear();
    self.drawers.clear();
    self.focusables.clear();
    self.declared_popups.clear();
    self.is_press_claimed = false;
    self.is_declaring = true;
    self.is_laid_out = false;

    self.hovered_root = self.hit_root();
    self.take_press();
    self.take_keys();
    self.take_wheel();
    self.key_focus = self.focus;
}

auto context::end_frame() -> result<frame_report> {
    state& self = *m_state;
    LUCENT_INVARIANT(self.is_declaring && self.open.empty());
    self.is_declaring = false;
    self.keep_declared_popups();

    LUCENT_TRY(
        detail::lay_out(
            self.elements,
            *self.text,
            {
                .viewport = self.frame.viewport,
                .pixels_per_unit = self.frame.pixels_per_unit,
                .popup_gap = self.frame.tokens.controls.popup_gap,
                .strings = self.strings,
                .roots = &self.roots,
            }
        )
    );
    self.is_laid_out = true;

    const bool is_unclaimed_press = self.frame.input.left.click_count > 0 && !self.is_press_claimed;
    const bool is_focus_declared =
        self.focus && std::ranges::any_of(self.focusables, [&](const focusable& candidate) {
            return candidate.id == *self.focus;
        });
    if (is_unclaimed_press || !is_focus_declared) {
        self.focus.reset();
    }
    if (self.frame.input.left.is_released || !self.frame.input.left.is_down) {
        self.active.reset();
    }
    self.remember_layout();
    self.stack_roots();
    self.forget_unseen();
    return frame_report{
        .wants_mouse = self.wants_mouse(),
        .wants_keyboard = self.focus.has_value() || !self.popups.empty(),
    };
}

auto context::record(draw::draw_list& list) -> result<void> {
    state& self = *m_state;
    LUCENT_INVARIANT(self.is_laid_out);
    return detail::record_roots(
        list,
        *self.text,
        {
            .elements = &self.elements,
            .order = &self.root_order,
            .drawers = &self.drawers,
            .rail = self.frame.tokens.colors.muted_ink,
            .rail_width = self.frame.tokens.controls.rail_width,
        }
    );
}

auto context::window(const window_spec& spec, stdx::function_ref<void()> children) -> void {
    state& self = *m_state;
    LUCENT_INVARIANT(self.open.empty());
    const element_id id = root_id(spec.key);
    id_memory& remembered = self.remembered(id);
    if (remembered.raised_at == 0) {
        remembered.raised_at = ++self.next_raise;
    }
    const isize index = self.push_root(
        id,
        spec.style,
        {
            .id = id,
            .element = 0,
            .layer = root_layer::window,
            .position = spec.position,
            .anchor_element = std::nullopt,
            .anchor_rect = std::nullopt,
        }
    );
    self.declare_children(index, children);
}

auto context::box(local_key key, const box_style& style, stdx::function_ref<void()> children)
    -> void {
    state& self = *m_state;
    const element_id id = id_of(key);
    const isize index = std::ssize(self.elements);
    self.push_child(id, style, detail::no_leaf{});
    self.declare_children(index, children);
}

auto context::box(const box_style& style, stdx::function_ref<void()> children) -> void {
    state& self = *m_state;
    const element_id id = self.anonymous_id();
    const isize index = std::ssize(self.elements);
    self.push_child(id, style, detail::no_leaf{});
    self.declare_children(index, children);
}

auto context::scroll(local_key key, const box_style& style, stdx::function_ref<void()> children)
    -> void {
    state& self = *m_state;
    const element_id id = id_of(key);
    const f32 offset = approach(id, self.remembered(id).scroll_target);
    const isize index = std::ssize(self.elements);
    self.push_child(id, style, detail::no_leaf{});
    element& declared = self.elements.at(narrow<usize>(index));
    declared.is_scroll = true;
    declared.scroll_offset = offset;
    self.declare_children(index, children);
}

auto context::text(const text_spec& spec) -> void {
    state& self = *m_state;
    const element_id id = self.anonymous_id();
    self.push_text(id, spec);
}

auto context::text(local_key key, const text_spec& spec) -> void {
    const element_id id = id_of(key);
    m_state->push_text(id, spec);
}

auto context::icon(const text::icon& drawn, draw::color tint) -> void {
    state& self = *m_state;
    const element_id id = self.anonymous_id();
    self.push_child(id, unstyled, detail::icon_leaf{.drawn = drawn, .tint = tint});
}

auto context::custom(local_key key, const box_style& style, custom_draw drawer) -> void {
    state& self = *m_state;
    const element_id id = id_of(key);
    self.drawers.push_back(std::move(drawer));
    self.push_child(id, style, detail::custom_leaf{.drawer = std::ssize(self.drawers) - 1});
}

auto context::open_popup(element_id anchor) -> void {
    state& self = *m_state;
    const root_entry* const declaring = self.current_root();
    if (declaring != nullptr && declaring->layer == root_layer::popup) {
        const auto parent = std::ranges::find_if(self.popups, [&](element_id open) {
            return popup_id(open) == declaring->id;
        });
        self.close_popups_above(std::distance(self.popups.begin(), parent) + 1);
    } else {
        self.popups.clear();
    }
    if (!self.popup_index(anchor)) {
        self.popups.push_back(anchor);
    }
}

auto context::close_popup(element_id anchor) -> void {
    state& self = *m_state;
    if (const std::optional<isize> index = self.popup_index(anchor)) {
        self.close_popups_above(*index);
    }
}

auto context::is_popup_open(element_id anchor) const -> bool {
    return m_state->popup_index(anchor).has_value();
}

auto context::popup(element_id anchor, const box_style& style, stdx::function_ref<void()> children)
    -> void {
    state& self = *m_state;
    if (!is_popup_open(anchor)) {
        return;
    }
    const auto declared = std::ranges::find(self.elements, anchor, &element::id);
    const last_element* const seen = self.last(anchor);
    root_entry entry{
        .id = popup_id(anchor),
        .element = 0,
        .layer = root_layer::popup,
        .position = {.x = 0.0F, .y = 0.0F},
        .anchor_element = std::nullopt,
        .anchor_rect = std::nullopt,
    };
    if (declared != self.elements.end()) {
        entry.anchor_element = std::distance(self.elements.begin(), declared);
    } else if (seen != nullptr) {
        entry.anchor_rect = seen->rect;
    } else {
        close_popup(anchor);
        return;
    }
    self.declared_popups.push_back(anchor);
    std::vector<isize> outer = std::exchange(self.open, {});
    const isize index = self.push_root(entry.id, style, entry);
    self.declare_children(index, children);
    self.open = std::move(outer);
}

auto context::id_of(local_key key) const -> element_id {
    const state& self = *m_state;
    if (self.open.empty()) {
        return root_id(key);
    }
    return child_id(self.elements.at(narrow<usize>(self.open.back())).id, key);
}

auto context::interact(element_id id, flags<sense> senses) -> interaction {
    state& self = *m_state;
    LUCENT_INVARIANT(self.is_declaring);
    const input_snapshot& input = self.frame.input;
    const last_element* const seen = self.last(id);
    const bool is_under_cursor = seen != nullptr
                                 && input.cursor
                                 && self.hovered_root == seen->root
                                 && contains(seen->visible, *input.cursor);
    const bool is_hovered = is_under_cursor && (!self.active || self.active == id);
    if (senses.has(sense::focus)) {
        const root_entry* const declaring = self.current_root();
        self.focusables.push_back({
            .id = id,
            .root = declaring != nullptr ? declaring->id : element_id{},
        });
    }
    const bool is_pressable = senses.has_any(flags{sense::click, sense::drag, sense::focus});
    if (input.left.click_count > 0 && is_hovered && is_pressable && !self.is_press_claimed) {
        self.is_press_claimed = true;
        self.active = id;
        if (senses.has(sense::focus)) {
            self.focus = id;
        }
    }
    const bool is_held = self.active == id;
    const bool is_focused = self.focus == id;
    const bool is_key_activated =
        is_focused
        && self.key_focus == id
        && (has_key(input, {.code = key_code::enter, .action = key_action::pressed})
            || has_key(input, {.code = key_code::space, .action = key_action::pressed}));
    return {
        .id = id,
        .is_hovered = is_hovered,
        .is_pressed = is_held && (input.left.is_down || input.left.is_released),
        .is_just_pressed = is_held && input.left.click_count > 0,
        .is_activated = (is_held && input.left.is_released && is_under_cursor) || is_key_activated,
        .is_focused = is_focused,
        .rect = seen != nullptr ? std::optional{seen->rect} : std::nullopt,
        .cursor = input.cursor,
    };
}

auto context::focus(element_id id) -> void {
    m_state->focus = id;
}

auto context::approach(element_id id, f32 target) -> f32 {
    state& self = *m_state;
    motion_memory& motion = self.remembered(id).motion;
    if (!motion.is_started) {
        motion = self.begun_motion(target);
        return target;
    }
    if (motion.stepped_frame != self.frame_number) {
        motion.value = approached(
            motion.value,
            {
                .target = target,
                .timing = self.frame.tokens.motion.approach_half_life,
                .elapsed = self.step,
            }
        );
        motion.stepped_frame = self.frame_number;
    }
    return motion.value;
}

auto context::spring(element_id id, f32 target) -> f32 {
    state& self = *m_state;
    motion_memory& motion = self.remembered(id).motion;
    if (!motion.is_started) {
        motion = self.begun_motion(target);
        return target;
    }
    if (motion.stepped_frame != self.frame_number) {
        const spring_value next = sprung(
            {.position = motion.value, .velocity = motion.velocity, .pending = motion.pending},
            {
                .target = target,
                .timing = self.frame.tokens.motion.spring_response,
                .elapsed = self.step,
            }
        );
        motion.value = next.position;
        motion.velocity = next.velocity;
        motion.pending = next.pending;
        motion.stepped_frame = self.frame_number;
    }
    return motion.value;
}

auto context::tween(element_id id, f32 target) -> f32 {
    state& self = *m_state;
    const std::chrono::steady_clock::time_point now = self.frame.input.time;
    const motion_tokens& motion_tokens = self.frame.tokens.motion;
    motion_memory& motion = self.remembered(id).motion;
    if (!motion.is_started) {
        motion = self.begun_motion(target);
        return target;
    }
    const auto value_at = [&](std::chrono::steady_clock::time_point when) {
        const f32 duration = seconds(motion_tokens.normal);
        const f32 progress = duration <= 0.0F ? 1.0F : seconds(when - motion.started) / duration;
        return motion.from
               + ((motion.target - motion.from) * eased(motion_tokens.standard, progress));
    };
    if (target < motion.target || target > motion.target) {
        motion.from = value_at(now);
        motion.target = target;
        motion.started = now;
    }
    motion.value = value_at(now);
    return motion.value;
}

auto context::presence(element_id id, visibility wanted) -> f32 {
    state& self = *m_state;
    const motion_tokens& motion_tokens = self.frame.tokens.motion;
    motion_memory& motion = self.remembered(id).motion;
    const f32 target = wanted == visibility::shown ? 1.0F : 0.0F;
    if (!motion.is_started) {
        motion = self.begun_motion(0.0F);
    }
    if (motion.stepped_frame != self.frame_number) {
        const f32 duration = seconds(motion_tokens.fast);
        const f32 reach = duration <= 0.0F ? 1.0F : seconds(self.step) / duration;
        motion.value = motion.value < target ? std::min(motion.value + reach, target)
                                             : std::max(motion.value - reach, target);
        motion.stepped_frame = self.frame_number;
    }
    if (motion_tokens.fast.count() == 0) {
        motion.value = target;
    }
    return eased(motion_tokens.standard, motion.value);
}

auto context::input() const -> const input_snapshot& {
    return m_state->frame.input;
}

auto context::tokens() const -> const theme& {
    return m_state->frame.tokens;
}

auto context::rect(element_id id) const -> std::optional<draw::rect> {
    const last_element* const seen = m_state->last(id);
    if (seen == nullptr) {
        return std::nullopt;
    }
    return seen->rect;
}

auto context::focused() const -> std::optional<element_id> {
    return m_state->focus;
}

}
