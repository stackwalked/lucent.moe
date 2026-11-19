#include <lucent/text/text_system.hpp>

#include <cstddef>
#include <memory>
#include <span>
#include <utility>
#include <vector>

#include <lucent/draw/color.hpp>
#include <lucent/draw/draw_list.hpp>
#include <lucent/draw/vec2.hpp>
#include <lucent/text/glyph_atlas.hpp>
#include <lucent/text/text_layout.hpp>

#include "text_engine.hpp"

namespace lucent::text {

struct text_system::state {
    std::unique_ptr<text_engine> engine;
};

auto text_system::create(const text_options& options) -> result<text_system> {
    std::unique_ptr<text_engine> engine = LUCENT_TRY(text_engine::create(options));
    return text_system{std::make_unique<state>(std::move(engine))};
}

text_system::text_system(std::unique_ptr<state> owned)
    : m_state{std::move(owned)} {}

text_system::text_system(text_system&& other) noexcept = default;
auto text_system::operator=(text_system&& other) noexcept -> text_system& = default;
text_system::~text_system() = default;

auto text_system::add_face(std::span<const std::byte> bytes) -> result<face_id> {
    return m_state->engine->add_face(bytes);
}

auto text_system::set_fallback(std::span<const face_id> chain) -> result<void> {
    return m_state->engine->set_fallback(chain);
}

auto text_system::begin_frame() -> void {
    m_state->engine->begin_frame();
}

auto text_system::layout(const layout_request& request) -> result<const text_layout*> {
    return m_state->engine->layout(request);
}

auto text_system::draw(
    draw::draw_list& list, const text_layout& laid_out, draw::vec2 origin, draw::color tint
) -> result<void> {
    return m_state->engine->draw(list, laid_out, origin, tint);
}

auto text_system::prewarm(const layout_request& request) -> result<void> {
    return m_state->engine->prewarm(request);
}

auto text_system::add_icon(const icon_pixels& pixels) -> result<icon> {
    return m_state->engine->add_icon(pixels);
}

auto text_system::draw(
    draw::draw_list& list, const icon& drawn, draw::vec2 origin, draw::color tint
) -> void {
    m_state->engine->draw(list, drawn, origin, tint);
}

auto text_system::take_patches() -> std::vector<atlas_patch> {
    return m_state->engine->atlas().take_patches();
}

auto text_system::every_page() const -> std::vector<atlas_patch> {
    return m_state->engine->atlas().every_page();
}

auto text_system::evictions() const -> i64 {
    return m_state->engine->atlas().evictions();
}

}
