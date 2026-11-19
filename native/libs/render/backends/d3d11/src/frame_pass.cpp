#include <algorithm>
#include <array>
#include <bit>
#include <cmath>
#include <cstddef>
#include <optional>
#include <ranges>
#include <span>
#include <utility>
#include <vector>

#include <d3d11.h>

#include <dxgiformat.h>
#include <winerror.h>
#include <wrl/client.h>

#include <lucent/core/match.hpp>
#include <lucent/core/narrow.hpp>
#include <lucent/d3d11/renderer.hpp>
#include <lucent/draw/color.hpp>
#include <lucent/draw/frame_data.hpp>
#include <lucent/draw/layer.hpp>
#include <lucent/draw/path_vertex.hpp>
#include <lucent/draw/quad_record.hpp>

#include "constants.hpp"
#include "gpu_state.hpp"
#include "lucent/draw/image_quad.hpp"
#include "lucent/draw/rect.hpp"
#include "scratch_pool.hpp"
#include "shaders/constants.hlsli"

namespace lucent::d3d11 {
namespace {

// A blur step reaches 3 deviations either side, at most shared::max_blur_radius texels; past this
// deviation the backdrop is halved first, so the same kernel spans more of the screen.
constexpr f32 max_pass_sigma = 8.0F;
constexpr i32 max_halvings = 6;
constexpr isize first_record_capacity = 1024;
constexpr isize first_path_capacity = 4096;

constexpr shared::float4 zero{};

// scRGB: linear values, white at scrgb_paper_white.
auto is_scrgb(u32 format) -> bool {
    return static_cast<DXGI_FORMAT>(format) == DXGI_FORMAT_R16G16B16A16_FLOAT;
}

// What a linear target's 1.0 is worth: scRGB's white sits above 1, an _SRGB target's at it.
auto white_of(u32 format) -> f32 {
    return is_scrgb(format) ? scrgb_paper_white : 1.0F;
}

auto is_srgb(u32 format) -> bool {
    const auto view = static_cast<DXGI_FORMAT>(format);
    return view == DXGI_FORMAT_R8G8B8A8_UNORM_SRGB
           || view == DXGI_FORMAT_B8G8R8A8_UNORM_SRGB
           || view == DXGI_FORMAT_B8G8R8X8_UNORM_SRGB;
}

// A layer drawn aside needs alpha to be composited, which an X8 target doesn't keep. Backdrops
// stay in the target's own format: they are copied from it, and read as opaque anyway.
auto aside_format(u32 format) -> u32 {
    const auto view = static_cast<DXGI_FORMAT>(format);
    if (view == DXGI_FORMAT_B8G8R8X8_UNORM) {
        return static_cast<u32>(DXGI_FORMAT_B8G8R8A8_UNORM);
    }
    if (view == DXGI_FORMAT_B8G8R8X8_UNORM_SRGB) {
        return static_cast<u32>(DXGI_FORMAT_B8G8R8A8_UNORM_SRGB);
    }
    return format;
}

auto encoded_srgb(f32 linear) -> f32 {
    if (linear <= 0.0031308F) {
        return linear * 12.92F;
    }
    return (1.055F * std::pow(linear, 1.0F / 2.4F)) - 0.055F;
}

auto mapped_span(const D3D11_MAPPED_SUBRESOURCE& mapped, usize size) -> std::span<std::byte> {
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wunsafe-buffer-usage-in-container" // Map's memory, size long
    return {static_cast<std::byte*>(mapped.pData), size};
#pragma clang diagnostic pop
}

auto write_buffer(
    ID3D11DeviceContext* context, ID3D11Buffer* buffer, std::span<const std::byte> bytes
) -> result<void> {
    D3D11_MAPPED_SUBRESOURCE mapped{};
    LUCENT_TRY(checked(context->Map(buffer, 0, D3D11_MAP_WRITE_DISCARD, 0, &mapped)));
    std::ranges::copy(bytes, mapped_span(mapped, bytes.size()).begin());
    context->Unmap(buffer, 0);
    return {};
}

enum class buffer_use : u8 { records, vertices };

// Makes the buffer hold at least count elements of stride bytes, growing by half again or more.
auto reserve(ID3D11Device* device, growing_buffer& held, isize count, buffer_use use)
    -> result<void> {
    if (count <= held.capacity) {
        return {};
    }
    const bool is_records = use == buffer_use::records;
    const isize stride =
        is_records ? isize{sizeof(draw::quad_record)} : isize{sizeof(draw::path_vertex)};
    const isize first = is_records ? first_record_capacity : first_path_capacity;
    const isize capacity = std::max({count, held.capacity + (held.capacity / 2), first});
    const D3D11_BUFFER_DESC description{
        .ByteWidth = narrow<UINT>(capacity * stride),
        .Usage = D3D11_USAGE_DYNAMIC,
        .BindFlags =
            static_cast<UINT>(is_records ? D3D11_BIND_SHADER_RESOURCE : D3D11_BIND_VERTEX_BUFFER),
        .CPUAccessFlags = D3D11_CPU_ACCESS_WRITE,
        .MiscFlags = is_records ? static_cast<UINT>(D3D11_RESOURCE_MISC_BUFFER_STRUCTURED) : 0U,
        .StructureByteStride = is_records ? narrow<UINT>(stride) : 0U,
    };
    growing_buffer grown;
    LUCENT_TRY(checked(device->CreateBuffer(&description, nullptr, grown.buffer.GetAddressOf())));
    if (is_records) {
        LUCENT_TRY(checked(
            device->CreateShaderResourceView(grown.buffer.Get(), nullptr, grown.view.GetAddressOf())
        ));
    }
    grown.capacity = capacity;
    held = std::move(grown);
    return {};
}

auto width_of(const draw::pixel_rect& area) -> i32 {
    return area.right - area.left;
}

auto height_of(const draw::pixel_rect& area) -> i32 {
    return area.bottom - area.top;
}

auto size_of(const draw::pixel_rect& area) -> draw::pixel_size {
    return {.width = width_of(area), .height = height_of(area)};
}

auto is_empty(const draw::pixel_rect& area) -> bool {
    return area.right <= area.left || area.bottom <= area.top;
}

auto intersect(const draw::pixel_rect& left, const draw::pixel_rect& right) -> draw::pixel_rect {
    return {
        .left = std::max(left.left, right.left),
        .top = std::max(left.top, right.top),
        .right = std::min(left.right, right.right),
        .bottom = std::min(left.bottom, right.bottom),
    };
}

auto grown(const draw::pixel_rect& area, i32 amount) -> draw::pixel_rect {
    return {
        .left = area.left - amount,
        .top = area.top - amount,
        .right = area.right + amount,
        .bottom = area.bottom + amount,
    };
}

auto whole(draw::pixel_size size) -> draw::pixel_rect {
    return {.left = 0, .top = 0, .right = size.width, .bottom = size.height};
}

// The pixels a layer's bounds cover, inside the target. The list snaps bounds to whole pixels;
// rounding outward keeps a hand-built frame's fractional bounds covered.
auto covered(const draw::rect& bounds, draw::pixel_size target) -> draw::pixel_rect {
    const auto edge = [](f32 value, i32 limit) {
        return static_cast<i32>(std::clamp(value, 0.0F, static_cast<f32>(limit)));
    };
    return {
        .left = edge(std::floor(bounds.min.x), target.width),
        .top = edge(std::floor(bounds.min.y), target.height),
        .right = edge(std::ceil(bounds.max.x), target.width),
        .bottom = edge(std::ceil(bounds.max.y), target.height),
    };
}

auto as_float4(const draw::pixel_rect& area) -> shared::float4 {
    return {
        static_cast<f32>(area.left),
        static_cast<f32>(area.top),
        static_cast<f32>(area.right),
        static_cast<f32>(area.bottom),
    };
}

auto as_float4(const draw::rect& bounds) -> shared::float4 {
    return {bounds.min.x, bounds.min.y, bounds.max.x, bounds.max.y};
}

auto as_d3d_rect(const draw::pixel_rect& area) -> D3D11_RECT {
    return {.left = area.left, .top = area.top, .right = area.right, .bottom = area.bottom};
}

// A surface draws land in: the target, or a layer's contents drawn aside. Its texel (0, 0) is the
// target pixel at area's top left.
struct surface {
    ID3D11RenderTargetView* target = nullptr;
    draw::pixel_rect area;
};

struct open_layer {
    draw::layer surface;
    draw::pixel_rect area;
    // The scratch entry its contents are drawn into, when its opacity is below one.
    std::optional<isize> aside;
    bool has_mask = false;
};

// Where a source's texel (0, 0) sits in a pass's space, and how many positions each texel spans.
struct texel_grid {
    i32 left = 0;
    i32 top = 0;
    i32 scale = 1;
};

// One full-rect pass of the pass vertex shader.
struct pass_draw {
    ID3D11RenderTargetView* into = nullptr;
    D3D11_VIEWPORT viewport{};
    D3D11_RECT scissor{};
    ID3D11PixelShader* shader = nullptr;
    ID3D11ShaderResourceView* source = nullptr;
    ID3D11BlendState* blend = nullptr;
    pass_constants constants{};
};

// A blurred backdrop: a scratch entry holding region, every texel scale target pixels a side.
struct blurred_backdrop {
    isize entry = 0;
    draw::pixel_rect region;
    i32 scale = 1;
    draw::pixel_size used;
};

class frame_pass final {
public:
    frame_pass(
        gpu_state& gpu,
        const device_objects& objects,
        const draw::frame_data& frame,
        const render_target& target
    )
        : m_gpu(&gpu)
        , m_objects(&objects)
        , m_context(gpu.context.Get())
        , m_frame(frame)
        , m_target(target) {}

    frame_pass(const frame_pass&) = delete ("holds scratch entries it releases once");
    auto operator=(const frame_pass&) -> frame_pass& = delete ("holds scratch entries");
    frame_pass(frame_pass&&) = delete ("holds scratch entries it releases once");
    auto operator=(frame_pass&&) -> frame_pass& = delete ("holds scratch entries");

    ~frame_pass() {
        for (const isize entry : m_held) {
            m_gpu->pool.release(entry);
        }
    }

    auto run() -> result<void> {
        LUCENT_TRY(upload());
        LUCENT_TRY(bind_frame());
        m_surfaces.push_back({.target = m_target.view, .area = whole(m_target.size)});
        for (const draw::command& next : m_frame.commands) {
            LUCENT_TRY(execute(next));
        }
        return {};
    }

private:
    auto execute(const draw::command& next) -> result<void> {
        if (m_skipped_depth > 0) {
            m_skipped_depth += match(
                next,
                [](const draw::quad_run&) { return isize{0}; },
                [](const draw::path_run&) { return isize{0}; },
                [](const draw::layer_begin&) { return isize{1}; },
                [](const draw::layer_end&) { return isize{-1}; }
            );
            return {};
        }
        return match(
            next,
            [this](const draw::quad_run& run) { return draw_quads(run); },
            [this](const draw::path_run& run) { return draw_paths(run); },
            [this](const draw::layer_begin& begin) { return begin_layer(begin); },
            [this](const draw::layer_end&) { return end_layer(); }
        );
    }

    auto upload() -> result<void> {
        ID3D11Device* device = m_gpu->device.Get();
        if (!m_frame.records.empty()) {
            LUCENT_TRY(
                reserve(device, m_gpu->records, std::ssize(m_frame.records), buffer_use::records)
            );
            LUCENT_TRY(
                write_buffer(m_context, m_gpu->records.buffer.Get(), std::as_bytes(m_frame.records))
            );
        }
        if (!m_frame.path_vertices.empty()) {
            LUCENT_TRY(reserve(
                device, m_gpu->paths, std::ssize(m_frame.path_vertices), buffer_use::vertices
            ));
            LUCENT_TRY(write_buffer(
                m_context, m_gpu->paths.buffer.Get(), std::as_bytes(m_frame.path_vertices)
            ));
        }
        return {};
    }

    auto bind_frame() -> result<void> {
        const frame_constants constants{
            .target = {
                static_cast<f32>(m_target.size.width),
                static_cast<f32>(m_target.size.height),
                is_srgb(m_target.format) || is_scrgb(m_target.format) ? 1.0F : 0.0F,
                white_of(m_target.format),
            },
        };
        LUCENT_TRY(write_buffer(
            m_context, m_objects->states.frame_buffer.Get(), std::as_bytes(std::span{&constants, 1})
        ));
        LUCENT_TRY(write_masks());

        const std::array buffers{
            m_objects->states.frame_buffer.Get(),
            m_objects->states.mask_buffer.Get(),
            m_objects->states.pass_buffer.Get(),
        };
        m_context->VSSetConstantBuffers(0, narrow<UINT>(buffers.size()), buffers.data());
        m_context->PSSetConstantBuffers(0, narrow<UINT>(buffers.size()), buffers.data());
        const std::array<ID3D11ShaderResourceView*, 2> resources{
            m_gpu->records.view.Get(),
            m_objects->textures.atlas_view.Get(),
        };
        m_context->VSSetShaderResources(0, 1, resources.data());
        m_context->PSSetShaderResources(0, narrow<UINT>(resources.size()), resources.data());
        const std::array samplers{m_objects->states.linear_clamp.Get()};
        m_context->PSSetSamplers(0, 1, samplers.data());
        m_context->RSSetState(m_objects->states.rasterizer.Get());
        m_context->OMSetDepthStencilState(m_objects->states.no_depth.Get(), 0);
        return {};
    }

    auto write_masks() -> result<void> {
        mask_constants masks{};
        masks.count = {static_cast<f32>(std::ssize(m_masks)), 0.0F, 0.0F, 0.0F};
        for (const auto [rect, radius, open] : std::views::zip(masks.rects, masks.radii, m_masks)) {
            rect = as_float4(open.bounds);
            radius = {open.radius, 0.0F, 0.0F, 0.0F};
        }
        return write_buffer(
            m_context, m_objects->states.mask_buffer.Get(), std::as_bytes(std::span{&masks, 1})
        );
    }

    auto current() const -> const surface& {
        return m_surfaces.back();
    }

    // Draws given in target pixels land at the surface's own texels.
    auto viewport_of(const surface& into) const -> D3D11_VIEWPORT {
        return {
            .TopLeftX = static_cast<f32>(-into.area.left),
            .TopLeftY = static_cast<f32>(-into.area.top),
            .Width = static_cast<f32>(m_target.size.width),
            .Height = static_cast<f32>(m_target.size.height),
            .MinDepth = 0.0F,
            .MaxDepth = 1.0F,
        };
    }

    // A clip in target pixels as a scissor in the surface's texels; absent when nothing of it is
    // on the surface.
    static auto scissor_of(const surface& into, const draw::pixel_rect& clip)
        -> std::optional<D3D11_RECT> {
        const draw::pixel_rect visible = intersect(clip, into.area);
        if (is_empty(visible)) {
            return std::nullopt;
        }
        return D3D11_RECT{
            .left = visible.left - into.area.left,
            .top = visible.top - into.area.top,
            .right = visible.right - into.area.left,
            .bottom = visible.bottom - into.area.top,
        };
    }

    auto bind_surface(const surface& into) -> void {
        // The pass source may be the texture this surface's view writes, so it goes first.
        const std::array<ID3D11ShaderResourceView*, 1> none{};
        m_context->PSSetShaderResources(3, 1, none.data());
        const std::array targets{into.target};
        m_context->OMSetRenderTargets(1, targets.data(), nullptr);
        const D3D11_VIEWPORT viewport = viewport_of(into);
        m_context->RSSetViewports(1, &viewport);
        m_context->OMSetBlendState(
            m_objects->states.premultiplied_blend.Get(), zero.data(), D3D11_DEFAULT_SAMPLE_MASK
        );
    }

    auto draw_quads(const draw::quad_run& run) -> result<void> {
        const std::optional<D3D11_RECT> scissor = scissor_of(current(), run.clip);
        if (!scissor) {
            return {};
        }
        bind_surface(current());
        m_context->IASetInputLayout(m_objects->programs.quad_layout.Get());
        m_context->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLESTRIP);
        const std::array buffers{m_objects->states.record_indices.Get()};
        const UINT stride = sizeof(u32);
        const UINT offset = 0;
        m_context->IASetVertexBuffers(0, 1, buffers.data(), &stride, &offset);
        m_context->VSSetShader(m_objects->programs.quad_vertex.Get(), nullptr, 0);
        m_context->PSSetShader(m_objects->programs.main_pixel.Get(), nullptr, 0);
        // A stale handle binds nothing: its image records sample zero and draw nothing, and the
        // shapes sharing the run still draw.
        const std::array images{image_view(run.image)};
        m_context->PSSetShaderResources(2, 1, images.data());
        m_context->RSSetScissorRects(1, &*scissor);
        m_context->DrawInstanced(4, narrow<UINT>(run.count), 0, narrow<UINT>(run.first));
        ++m_gpu->counts.draw_calls;
        return {};
    }

    auto image_view(std::optional<draw::image_handle> image) const -> ID3D11ShaderResourceView* {
        if (!image) {
            return nullptr;
        }
        const std::optional<isize> slot = m_gpu->images.slot_of(*image);
        if (!slot) {
            ++m_gpu->stale_image_misses;
            return nullptr;
        }
        return m_gpu->image_views.at(narrow<usize>(*slot)).Get();
    }

    auto draw_paths(const draw::path_run& run) -> result<void> {
        const std::optional<D3D11_RECT> scissor = scissor_of(current(), run.clip);
        if (!scissor) {
            return {};
        }
        bind_surface(current());
        m_context->IASetInputLayout(m_objects->programs.path_layout.Get());
        m_context->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
        const std::array buffers{m_gpu->paths.buffer.Get()};
        const UINT stride = sizeof(draw::path_vertex);
        const UINT offset = 0;
        m_context->IASetVertexBuffers(0, 1, buffers.data(), &stride, &offset);
        m_context->VSSetShader(m_objects->programs.path_vertex.Get(), nullptr, 0);
        m_context->PSSetShader(m_objects->programs.main_pixel.Get(), nullptr, 0);
        m_context->RSSetScissorRects(1, &*scissor);
        m_context->Draw(narrow<UINT>(run.count), narrow<UINT>(run.first));
        ++m_gpu->counts.draw_calls;
        return {};
    }

    auto begin_layer(const draw::layer_begin& begin) -> result<void> {
        const draw::pixel_rect area =
            intersect(covered(begin.surface.bounds, m_target.size), begin.clip);
        if (is_empty(area)) {
            m_skipped_depth = 1;
            return {};
        }
        open_layer opened{.surface = begin.surface, .area = area, .aside = std::nullopt};
        if (begin.surface.opacity < 1.0F) {
            const isize entry = LUCENT_TRY(acquire(size_of(area), aside_format(m_target.format)));
            const scratch_surface& aside = m_gpu->scratch.at(narrow<usize>(entry));
            m_context->ClearRenderTargetView(aside.target.Get(), zero.data());
            m_surfaces.push_back({.target = aside.target.Get(), .area = area});
            opened.aside = entry;
        }
        if (begin.surface.blur > 0.0F) {
            LUCENT_TRY(draw_backdrop(opened));
        }
        if (begin.surface.radius > 0.0F) {
            LUCENT_INVARIANT(std::ssize(m_masks) < isize{shared::max_masks});
            m_masks.push_back(begin.surface);
            LUCENT_TRY(write_masks());
            opened.has_mask = true;
        }
        m_layers.push_back(opened);
        return {};
    }

    auto end_layer() -> result<void> {
        LUCENT_INVARIANT(!m_layers.empty());
        const open_layer closed = m_layers.back();
        m_layers.pop_back();
        if (closed.has_mask) {
            m_masks.pop_back();
            LUCENT_TRY(write_masks());
        }
        if (!closed.aside) {
            return {};
        }
        m_surfaces.pop_back();
        const isize entry = *closed.aside;
        const draw::pixel_size texture = texture_size(entry);
        const std::optional<D3D11_RECT> scissor = scissor_of(current(), closed.area);
        if (scissor) {
            LUCENT_TRY(run_pass({
                .into = current().target,
                .viewport = viewport_of(current()),
                .scissor = *scissor,
                .shader = m_objects->programs.composite_pixel.Get(),
                .source = m_gpu->scratch.at(narrow<usize>(entry)).view.Get(),
                .blend = m_objects->states.premultiplied_blend.Get(),
                .constants = {
                    .space = target_space(),
                    .rect = as_float4(closed.area),
                    .mapping = mapping_of(
                        texture, {.left = closed.area.left, .top = closed.area.top, .scale = 1}
                    ),
                    .limit = limit_of(texture, size_of(closed.area)),
                    .filter = {},
                    .layer = {closed.surface.radius, 0.0F, closed.surface.opacity, 0.0F},
                    .bounds = as_float4(closed.surface.bounds),
                },
            }));
        }
        release(entry);
        return {};
    }

    // The layer's backdrop: what the target holds under it, blurred, drawn as the first thing in
    // it. Always from the target, never an enclosing layer's aside surface: glass inside a fading
    // panel shows the world behind, not the panel's empty texture.
    auto draw_backdrop(const open_layer& opened) -> result<void> {
        const blurred_backdrop backdrop = LUCENT_TRY(blur_backdrop(opened));
        const draw::pixel_size texture = texture_size(backdrop.entry);
        const std::optional<D3D11_RECT> scissor = scissor_of(current(), opened.area);
        if (opened.surface.light) {
            LUCENT_TRY(probe_light(backdrop, opened));
        }
        if (scissor) {
            LUCENT_TRY(run_pass({
                .into = current().target,
                .viewport = viewport_of(current()),
                .scissor = *scissor,
                .shader = m_objects->programs.composite_pixel.Get(),
                .source = m_gpu->scratch.at(narrow<usize>(backdrop.entry)).view.Get(),
                .blend = m_objects->states.premultiplied_blend.Get(),
                .constants = {
                    .space = target_space(),
                    .rect = as_float4(opened.area),
                    .mapping = mapping_of(
                        texture,
                        {.left = backdrop.region.left,
                            .top = backdrop.region.top,
                            .scale = backdrop.scale}
                    ),
                    .limit = limit_of(texture, backdrop.used),
                    .filter = {},
                    .layer = {opened.surface.radius, opened.surface.rim, 1.0F, 1.0F},
                    .bounds = as_float4(opened.surface.bounds),
                },
            }));
        }
        if (opened.surface.light && m_is_light_owed) {
            copy_light(*opened.surface.light);
        }
        release(backdrop.entry);
        return {};
    }

    auto blur_backdrop(const open_layer& opened) -> result<blurred_backdrop> {
        const f32 sigma = opened.surface.blur;
        i32 halvings = 0;
        i32 scale = 1;
        while (sigma / static_cast<f32>(scale) > max_pass_sigma && halvings < max_halvings) {
            halvings += 1;
            scale *= 2;
        }
        const auto reach = static_cast<i32>(std::ceil(3.0F * sigma));
        const draw::pixel_rect region = intersect(grown(opened.area, reach), whole(m_target.size));

        isize level = LUCENT_TRY(capture(region));
        draw::pixel_size used = size_of(region);
        for (i32 step = 0; step < halvings; ++step) {
            const draw::pixel_size half{
                .width = (used.width + 1) / 2,
                .height = (used.height + 1) / 2,
            };
            const isize next = LUCENT_TRY(acquire(half, m_target.format));
            LUCENT_TRY(downsample(level, used, next, half));
            release(level);
            level = next;
            used = half;
        }

        // A 2x2 box halving already blurred by a variance of (scale^2 - 1) / 12 target pixels.
        const f32 box_variance = static_cast<f32>((scale * scale) - 1) / 12.0F;
        const f32 remaining = std::sqrt(std::max((sigma * sigma) - box_variance, 1.0F / 16.0F))
                              / static_cast<f32>(scale);
        const f32 reach_texels =
            std::min(std::ceil(3.0F * remaining), static_cast<f32>(shared::max_blur_radius));
        const isize spare = LUCENT_TRY(acquire(used, m_target.format));
        const draw::pixel_size texture = texture_size(level);
        const shared::float4 across{
            1.0F / static_cast<f32>(texture.width),
            0.0F,
            remaining,
            reach_texels,
        };
        const shared::float4 down{
            0.0F,
            1.0F / static_cast<f32>(texture.height),
            remaining,
            reach_texels,
        };
        LUCENT_TRY(blur_step(level, spare, used, across));
        LUCENT_TRY(blur_step(spare, level, used, down));
        release(spare);
        return blurred_backdrop{.entry = level, .region = region, .scale = scale, .used = used};
    }

    // The target's pixels under region, copied into a scratch surface (resolving MSAA first: a
    // multisampled texture can't be copied from in part).
    auto capture(const draw::pixel_rect& region) -> result<isize> {
        ID3D11Resource* source = m_target.texture;
        std::optional<isize> resolved;
        if (m_target.sample_count > 1) {
            const isize entry = LUCENT_TRY(acquire_exact(m_target.size, m_target.format));
            ID3D11Texture2D* single = m_gpu->scratch.at(narrow<usize>(entry)).texture.Get();
            m_context->ResolveSubresource(
                single, 0, m_target.texture, 0, static_cast<DXGI_FORMAT>(m_target.format)
            );
            source = single;
            resolved = entry;
        }
        const isize entry = LUCENT_TRY(acquire(size_of(region), m_target.format));
        const D3D11_BOX box{
            .left = narrow<UINT>(region.left),
            .top = narrow<UINT>(region.top),
            .front = 0,
            .right = narrow<UINT>(region.right),
            .bottom = narrow<UINT>(region.bottom),
            .back = 1,
        };
        m_context->CopySubresourceRegion(
            m_gpu->scratch.at(narrow<usize>(entry)).texture.Get(), 0, 0, 0, 0, source, 0, &box
        );
        if (resolved) {
            release(*resolved);
        }
        return entry;
    }

    auto downsample(isize from, draw::pixel_size from_used, isize into, draw::pixel_size into_used)
        -> result<void> {
        const draw::pixel_size source = texture_size(from);
        const draw::pixel_size texture = texture_size(into);
        return run_pass({
            .into = m_gpu->scratch.at(narrow<usize>(into)).target.Get(),
            .viewport = viewport_over(texture),
            .scissor = as_d3d_rect(whole(into_used)),
            .shader = m_objects->programs.downsample_pixel.Get(),
            .source = m_gpu->scratch.at(narrow<usize>(from)).view.Get(),
            .blend = m_objects->states.replace_blend.Get(),
            .constants = {
                .space = space_of(texture),
                .rect = as_float4(whole(into_used)),
                .mapping =
                    {
                        2.0F / static_cast<f32>(source.width),
                        2.0F / static_cast<f32>(source.height),
                        0.0F,
                        0.0F,
                    },
                .limit = limit_of(source, from_used),
                .filter = {},
                .layer = {},
                .bounds = {},
            },
        });
    }

    auto blur_step(isize from, isize into, draw::pixel_size used, const shared::float4& filter)
        -> result<void> {
        const draw::pixel_size texture = texture_size(into);
        return run_pass({
            .into = m_gpu->scratch.at(narrow<usize>(into)).target.Get(),
            .viewport = viewport_over(texture),
            .scissor = as_d3d_rect(whole(used)),
            .shader = m_objects->programs.blur_pixel.Get(),
            .source = m_gpu->scratch.at(narrow<usize>(from)).view.Get(),
            .blend = m_objects->states.replace_blend.Get(),
            .constants = {
                .space = space_of(texture),
                .rect = as_float4(whole(used)),
                .mapping = mapping_of(texture, {.left = 0, .top = 0, .scale = 1}),
                .limit = limit_of(texture_size(from), used),
                .filter = filter,
                .layer = {},
                .bounds = {},
            },
        });
    }

    // Draws the layer's blurred backdrop down into the light probe, when the ring has room; the
    // copy out waits until the composite has moved the output merger off the probe.
    auto probe_light(const blurred_backdrop& backdrop, const open_layer& opened) -> result<void> {
        m_is_light_owed = false;
        if (m_gpu->light_ring.at(narrow<usize>(m_gpu->light_cursor)).key) {
            return {};
        }
        const draw::pixel_size texture = texture_size(backdrop.entry);
        const auto probe = static_cast<f32>(light_probe_size);
        const auto scale = static_cast<f32>(backdrop.scale);
        const shared::float4 mapping{
            static_cast<f32>(width_of(opened.area))
                / (probe * scale * static_cast<f32>(texture.width)),
            static_cast<f32>(height_of(opened.area))
                / (probe * scale * static_cast<f32>(texture.height)),
            static_cast<f32>(opened.area.left - backdrop.region.left)
                / (scale * static_cast<f32>(texture.width)),
            static_cast<f32>(opened.area.top - backdrop.region.top)
                / (scale * static_cast<f32>(texture.height)),
        };
        const draw::pixel_size probe_size{.width = light_probe_size, .height = light_probe_size};
        LUCENT_TRY(run_pass({
            .into = m_objects->textures.light_probe_target.Get(),
            .viewport = viewport_over(probe_size),
            .scissor = as_d3d_rect(whole(probe_size)),
            .shader = m_objects->programs.downsample_pixel.Get(),
            .source = m_gpu->scratch.at(narrow<usize>(backdrop.entry)).view.Get(),
            .blend = m_objects->states.replace_blend.Get(),
            .constants = {
                .space = space_of(probe_size),
                .rect = as_float4(whole(probe_size)),
                .mapping = mapping,
                .limit = limit_of(texture, backdrop.used),
                .filter = {},
                .layer = {},
                .bounds = {},
            },
        }));
        m_is_light_owed = true;
        return {};
    }

    auto copy_light(draw::light_key key) -> void {
        const auto cursor = narrow<usize>(m_gpu->light_cursor);
        m_context->CopyResource(
            m_objects->textures.light_staging.at(cursor).Get(),
            m_objects->textures.light_probe.Get()
        );
        m_gpu->light_ring.at(cursor) = {
            .key = key,
            .is_linear = is_srgb(m_target.format) || is_scrgb(m_target.format),
            .white = white_of(m_target.format),
            .issued = m_gpu->frame,
        };
        m_gpu->light_cursor = (m_gpu->light_cursor + 1) % light_ring_size;
        m_is_light_owed = false;
    }

    auto run_pass(const pass_draw& pass) -> result<void> {
        LUCENT_TRY(write_buffer(
            m_context,
            m_objects->states.pass_buffer.Get(),
            std::as_bytes(std::span{&pass.constants, 1})
        ));
        const std::array<ID3D11ShaderResourceView*, 1> none{};
        m_context->PSSetShaderResources(3, 1, none.data());
        const std::array targets{pass.into};
        m_context->OMSetRenderTargets(1, targets.data(), nullptr);
        m_context->RSSetViewports(1, &pass.viewport);
        m_context->RSSetScissorRects(1, &pass.scissor);
        m_context->OMSetBlendState(pass.blend, zero.data(), D3D11_DEFAULT_SAMPLE_MASK);
        m_context->IASetInputLayout(nullptr);
        m_context->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLESTRIP);
        m_context->VSSetShader(m_objects->programs.pass_vertex.Get(), nullptr, 0);
        m_context->PSSetShader(pass.shader, nullptr, 0);
        const std::array sources{pass.source};
        m_context->PSSetShaderResources(3, 1, sources.data());
        m_context->Draw(4, 0);
        ++m_gpu->counts.draw_calls;
        ++m_gpu->counts.passes;
        return {};
    }

    auto target_space() const -> shared::float4 {
        return space_of(m_target.size);
    }

    static auto space_of(draw::pixel_size size) -> shared::float4 {
        return {static_cast<f32>(size.width), static_cast<f32>(size.height), 0.0F, 0.0F};
    }

    static auto viewport_over(draw::pixel_size size) -> D3D11_VIEWPORT {
        return {
            .TopLeftX = 0.0F,
            .TopLeftY = 0.0F,
            .Width = static_cast<f32>(size.width),
            .Height = static_cast<f32>(size.height),
            .MinDepth = 0.0F,
            .MaxDepth = 1.0F,
        };
    }

    // From a position in the pass's space to the source's uv.
    static auto mapping_of(draw::pixel_size texture, const texel_grid& grid) -> shared::float4 {
        const f32 across = static_cast<f32>(grid.scale) * static_cast<f32>(texture.width);
        const f32 down = static_cast<f32>(grid.scale) * static_cast<f32>(texture.height);
        return {
            1.0F / across,
            1.0F / down,
            static_cast<f32>(-grid.left) / across,
            static_cast<f32>(-grid.top) / down,
        };
    }

    // Half a texel inside the part of the texture that was written, so no bilinear tap reaches
    // past it into whatever a surface's last user left.
    static auto limit_of(draw::pixel_size texture, draw::pixel_size used) -> shared::float4 {
        const f32 width = static_cast<f32>(texture.width);
        const f32 height = static_cast<f32>(texture.height);
        return {
            0.5F / width,
            0.5F / height,
            (static_cast<f32>(used.width) - 0.5F) / width,
            (static_cast<f32>(used.height) - 0.5F) / height,
        };
    }

    auto texture_size(isize entry) const -> draw::pixel_size {
        const scratch_key& key = m_gpu->pool.key_of(entry);
        return {.width = key.width, .height = key.height};
    }

    auto acquire(draw::pixel_size size, u32 format) -> result<isize> {
        return acquire_exact(bucketed(size), format);
    }

    auto acquire_exact(draw::pixel_size size, u32 format) -> result<isize> {
        const scratch_key key{.width = size.width, .height = size.height, .format = format};
        std::optional<isize> entry = m_gpu->pool.acquire(key);
        if (!entry) {
            scratch_surface made = LUCENT_TRY(make_scratch(key));
            m_gpu->scratch.push_back(std::move(made));
            entry = m_gpu->pool.add(key);
            LUCENT_INVARIANT(*entry == std::ssize(m_gpu->scratch) - 1);
        }
        m_held.push_back(*entry);
        return *entry;
    }

    auto make_scratch(const scratch_key& key) const -> result<scratch_surface> {
        const D3D11_TEXTURE2D_DESC description{
            .Width = narrow<UINT>(key.width),
            .Height = narrow<UINT>(key.height),
            .MipLevels = 1,
            .ArraySize = 1,
            .Format = static_cast<DXGI_FORMAT>(key.format),
            .SampleDesc = DXGI_SAMPLE_DESC{.Count = 1, .Quality = 0},
            .Usage = D3D11_USAGE_DEFAULT,
            .BindFlags = static_cast<UINT>(D3D11_BIND_RENDER_TARGET)
                         | static_cast<UINT>(D3D11_BIND_SHADER_RESOURCE),
            .CPUAccessFlags = 0,
            .MiscFlags = 0,
        };
        ID3D11Device* device = m_gpu->device.Get();
        scratch_surface made;
        LUCENT_TRY(
            checked(device->CreateTexture2D(&description, nullptr, made.texture.GetAddressOf()))
        );
        LUCENT_TRY(checked(
            device->CreateRenderTargetView(made.texture.Get(), nullptr, made.target.GetAddressOf())
        ));
        LUCENT_TRY(checked(
            device->CreateShaderResourceView(made.texture.Get(), nullptr, made.view.GetAddressOf())
        ));
        return made;
    }

    auto release(isize entry) -> void {
        const auto held = std::ranges::find(m_held, entry);
        LUCENT_INVARIANT(held != m_held.end());
        m_held.erase(held);
        m_gpu->pool.release(entry);
    }

    gpu_state* m_gpu;
    const device_objects* m_objects;
    ID3D11DeviceContext* m_context;
    draw::frame_data m_frame;
    render_target m_target;
    std::vector<surface> m_surfaces;
    std::vector<open_layer> m_layers;
    std::vector<isize> m_held;
    // The open rounded layers, innermost last.
    std::vector<draw::layer> m_masks;
    // Inside a layer that missed its clip: how many layers deep, so its end is found.
    isize m_skipped_depth = 0;
    bool m_is_light_owed = false;
};

auto average_light(const D3D11_MAPPED_SUBRESOURCE& mapped, const light_readback& readback)
    -> draw::color {
    constexpr isize channels = 4;
    constexpr isize texel_bytes = channels * isize{sizeof(f32)};
    const auto row_pitch = isize{mapped.RowPitch};
    const std::span<std::byte> bytes = mapped_span(
        mapped,
        narrow<usize>((row_pitch * (light_probe_size - 1)) + (light_probe_size * texel_bytes))
    );
    std::array<f64, 3> sum{};
    for (const isize row : std::views::iota(isize{0}, isize{light_probe_size})) {
        const auto texels = bytes.subspan(
            narrow<usize>(row * row_pitch), narrow<usize>(light_probe_size * texel_bytes)
        );
        for (const auto texel : texels | std::views::chunk(texel_bytes)) {
            for (const auto [channel, total] : std::views::zip(
                     texel | std::views::chunk(isize{sizeof(f32)}) | std::views::take(3), sum
                 )) {
                std::array<std::byte, sizeof(f32)> value{};
                std::ranges::copy(channel, value.begin());
                total += static_cast<f64>(std::bit_cast<f32>(value));
            }
        }
    }
    const auto encode = [&readback](f64 total) {
        const f64 mean = total / static_cast<f64>(light_probe_size * light_probe_size)
                         / static_cast<f64>(readback.white);
        f32 value = std::isfinite(mean) ? std::clamp(static_cast<f32>(mean), 0.0F, 1.0F) : 0.0F;
        value = readback.is_linear ? encoded_srgb(value) : value;
        return narrow<u8>(static_cast<i32>(std::lround(value * 255.0F)));
    };
    return {.r = encode(sum[0]), .g = encode(sum[1]), .b = encode(sum[2]), .a = 255};
}

}

auto draw_frame(gpu_state& gpu, const draw::frame_data& frame, const render_target& target)
    -> result<void> {
    LUCENT_INVARIANT(gpu.objects.has_value());
    gpu.counts = {};
    frame_pass pass{gpu, *gpu.objects, frame, target};
    return pass.run();
}

auto collect_light(gpu_state& gpu) -> void {
    LUCENT_INVARIANT(gpu.objects.has_value());
    for (const auto [readback, staging] :
        std::views::zip(gpu.light_ring, gpu.objects->textures.light_staging)) {
        if (!readback.key) {
            continue;
        }
        D3D11_MAPPED_SUBRESOURCE mapped{};
        const HRESULT status =
            gpu.context->Map(staging.Get(), 0, D3D11_MAP_READ, D3D11_MAP_FLAG_DO_NOT_WAIT, &mapped);
        if (status == DXGI_ERROR_WAS_STILL_DRAWING) {
            continue;
        }
        const draw::light_key key = *readback.key;
        readback.key = std::nullopt;
        // A failure other than being early (a removed device) drops the sample rather than asking
        // for it forever.
        if (FAILED(status)) {
            continue;
        }
        const draw::color light = average_light(mapped, readback);
        gpu.context->Unmap(staging.Get(), 0);
        const auto known = gpu.lights.find(key);
        if (known == gpu.lights.end() || known->second.issued < readback.issued) {
            gpu.lights.insert_or_assign(
                key, sampled_light{.light = light, .issued = readback.issued}
            );
        }
    }
}

}

namespace lucent::d3d11 {

auto collect_timing(gpu_state& gpu) -> void {
    for (timing_queries& queries : gpu.timing) {
        if (!queries.is_pending) {
            continue;
        }
        D3D11_QUERY_DATA_TIMESTAMP_DISJOINT clock{};
        const auto no_flush = static_cast<UINT>(D3D11_ASYNC_GETDATA_DONOTFLUSH);
        if (gpu.context->GetData(queries.disjoint.Get(), &clock, sizeof(clock), no_flush) != S_OK) {
            continue;
        }
        u64 began = 0;
        u64 ended = 0;
        const bool has_times =
            gpu.context->GetData(queries.begin.Get(), &began, sizeof(began), no_flush) == S_OK
            && gpu.context->GetData(queries.end.Get(), &ended, sizeof(ended), no_flush) == S_OK;
        if (!has_times) {
            continue;
        }
        queries.is_pending = false;
        if (clock.Disjoint != FALSE || clock.Frequency == 0 || ended < began) {
            continue;
        }
        const f64 seconds = static_cast<f64>(ended - began) / static_cast<f64>(clock.Frequency);
        gpu.gpu_time = std::chrono::nanoseconds{static_cast<i64>(seconds * 1e9)};
    }
}

auto begin_timing(gpu_state& gpu) -> void {
    if (gpu.timing.empty()) {
        return;
    }
    const timing_queries& queries = gpu.timing.at(narrow<usize>(gpu.timing_cursor));
    // Still in flight from a ring's worth of frames ago: this frame goes untimed.
    if (queries.is_pending) {
        return;
    }
    gpu.context->Begin(queries.disjoint.Get());
    gpu.context->End(queries.begin.Get());
}

auto end_timing(gpu_state& gpu) -> void {
    if (gpu.timing.empty()) {
        return;
    }
    timing_queries& queries = gpu.timing.at(narrow<usize>(gpu.timing_cursor));
    if (queries.is_pending) {
        return;
    }
    gpu.context->End(queries.end.Get());
    gpu.context->End(queries.disjoint.Get());
    queries.is_pending = true;
    gpu.timing_cursor = (gpu.timing_cursor + 1) % std::ssize(gpu.timing);
}

}
