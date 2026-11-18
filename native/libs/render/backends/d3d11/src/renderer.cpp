#include <lucent/d3d11/renderer.hpp>

#include <algorithm>
#include <array>
#include <cstddef>
#include <expected>
#include <memory>
#include <optional>
#include <ranges>
#include <span>
#include <utility>
#include <vector>

#include <d3d11.h>

#include <wrl/client.h>

#include <lucent/core/narrow.hpp>
#include <lucent/draw/color.hpp>
#include <lucent/draw/frame_data.hpp>
#include <lucent/draw/glyph_run.hpp>
#include <lucent/draw/image_quad.hpp>
#include <lucent/draw/layer.hpp>

#include "gpu_state.hpp"
#include "image_slots.hpp"
#include "pipeline_guard.hpp"

namespace lucent::d3d11 {

struct renderer::resources {
    gpu_state gpu;
};

namespace {

using Microsoft::WRL::ComPtr;

constexpr isize bytes_per_pixel = 4;
// A D3D11 texture's largest side (D3D11_REQ_TEXTURE2D_U_OR_V_DIMENSION).
constexpr i32 max_image_side = 16'384;

// Whether rows of row_pitch bytes, the last of them row_bytes long, fit in bytes.
auto is_covered(std::span<const std::byte> bytes, isize row_pitch, isize row_bytes, isize rows)
    -> bool {
    return row_pitch >= row_bytes && std::ssize(bytes) >= (row_pitch * (rows - 1)) + row_bytes;
}

// Straight sRGB to premultiplied sRGB, rounded: the image shader samples and filters it as is.
auto premultiplied(const image_pixels& pixels) -> std::vector<std::byte> {
    std::vector<std::byte> out;
    out.reserve(narrow<usize>(isize{pixels.size.width} * pixels.size.height * bytes_per_pixel));
    for (const isize row : std::views::iota(isize{0}, isize{pixels.size.height})) {
        const auto texels = pixels.rgba.subspan(
            narrow<usize>(row * pixels.row_pitch),
            narrow<usize>(isize{pixels.size.width} * bytes_per_pixel)
        );
        for (const auto chunk : texels | std::views::chunk(bytes_per_pixel)) {
            std::array<std::byte, 4> texel{};
            std::ranges::copy(chunk, texel.begin());
            const u32 alpha = std::to_integer<u32>(texel[3]);
            for (const std::byte channel : std::span{texel}.first(3)) {
                out.push_back(
                    static_cast<std::byte>(((std::to_integer<u32>(channel) * alpha) + 127U) / 255U)
                );
            }
            out.push_back(texel[3]);
        }
    }
    return out;
}

auto is_valid(const atlas_upload& upload) -> bool {
    const draw::pixel_rect& area = upload.area;
    const isize width = area.right - area.left;
    const isize height = area.bottom - area.top;
    return std::to_underlying(upload.page) < draw::atlas_page_count
           && area.left >= 0
           && area.top >= 0
           && width > 0
           && height > 0
           && area.right <= draw::atlas_page_size
           && area.bottom <= draw::atlas_page_size
           && is_covered(upload.coverage, upload.row_pitch, width, height);
}

auto packed(const atlas_upload& upload) -> atlas_patch {
    const isize width = upload.area.right - upload.area.left;
    const isize height = upload.area.bottom - upload.area.top;
    atlas_patch patch{.page = upload.page, .area = upload.area, .coverage = {}};
    patch.coverage.reserve(narrow<usize>(width * height));
    for (const isize row : std::views::iota(isize{0}, height)) {
        patch.coverage.append_range(
            upload.coverage.subspan(narrow<usize>(row * upload.row_pitch), narrow<usize>(width))
        );
    }
    return patch;
}

auto apply_atlas_patches(gpu_state& gpu) -> void {
    LUCENT_INVARIANT(gpu.objects.has_value());
    for (const atlas_patch& patch : gpu.atlas_patches) {
        const D3D11_BOX box{
            .left = narrow<UINT>(patch.area.left),
            .top = narrow<UINT>(patch.area.top),
            .front = 0,
            .right = narrow<UINT>(patch.area.right),
            .bottom = narrow<UINT>(patch.area.bottom),
            .back = 1,
        };
        const UINT slice = D3D11CalcSubresource(0, narrow<UINT>(std::to_underlying(patch.page)), 1);
        gpu.context->UpdateSubresource(
            gpu.objects->textures.atlas.Get(),
            slice,
            &box,
            patch.coverage.data(),
            narrow<UINT>(patch.area.right - patch.area.left),
            0
        );
    }
    gpu.atlas_patches.clear();
}

// The view formats a render may target: 8-bit SDR, gamma (UNORM) or encoding (_SRGB). HDR
// targets (scRGB, HDR10) are refused until their paper-white path exists.
auto is_supported(u32 format) -> bool {
    const auto view = static_cast<DXGI_FORMAT>(format);
    return view == DXGI_FORMAT_R8G8B8A8_UNORM
           || view == DXGI_FORMAT_R8G8B8A8_UNORM_SRGB
           || view == DXGI_FORMAT_B8G8R8A8_UNORM
           || view == DXGI_FORMAT_B8G8R8A8_UNORM_SRGB
           || view == DXGI_FORMAT_B8G8R8X8_UNORM
           || view == DXGI_FORMAT_B8G8R8X8_UNORM_SRGB;
}

auto is_same_size(draw::pixel_size left, draw::pixel_size right) -> bool {
    return left.width == right.width && left.height == right.height;
}

}

renderer::renderer(std::unique_ptr<resources> owned)
    : m_resources(std::move(owned)) {}

renderer::renderer(renderer&& other) noexcept = default;
auto renderer::operator=(renderer&& other) noexcept -> renderer& = default;
renderer::~renderer() = default;

auto renderer::from_device(ID3D11Device* device, ID3D11DeviceContext* context) -> result<renderer> {
    LUCENT_INVARIANT(device != nullptr && context != nullptr);
    if (device->GetFeatureLevel() < D3D_FEATURE_LEVEL_11_0) {
        return std::unexpected(error{.code = error_code::unsupported});
    }
    auto owned = std::make_unique<resources>();
    owned->gpu.device = device;
    owned->gpu.context = context;
    return renderer{std::move(owned)};
}

auto renderer::state() const -> renderer_state {
    return m_resources->gpu.attempts.state();
}

auto renderer::is_multithreaded() const -> bool {
    return (m_resources->gpu.device->GetCreationFlags()
               & static_cast<UINT>(D3D11_CREATE_DEVICE_SINGLETHREADED))
           == 0;
}

auto renderer::build() -> result<void> {
    gpu_state& gpu = m_resources->gpu;
    if (gpu.attempts.state() == renderer_state::ready) {
        return {};
    }
    if (!gpu.attempts.can_start()) {
        return std::unexpected(error{.code = error_code::unsupported});
    }
    gpu.attempts.start();
    result<device_objects> made = build_device_objects(gpu.device.Get());
    if (!made) {
        gpu.attempts.fail();
        return std::unexpected(made.error());
    }
    gpu.objects = std::move(*made);
    gpu.attempts.succeed();
    return {};
}

auto renderer::render(const draw::frame_data& frame, const render_target& target) -> result<void> {
    LUCENT_INVARIANT(state() == renderer_state::ready);
    LUCENT_INVARIANT(target.view != nullptr && target.texture != nullptr);
    LUCENT_TRY(draw::check(frame));
    if (!is_same_size(frame.target, target.size)) {
        return std::unexpected(error{.code = error_code::malformed});
    }
    if (!is_supported(target.format)) {
        return std::unexpected(error{.code = error_code::unsupported});
    }
    gpu_state& gpu = m_resources->gpu;
    collect_light(gpu);
    for (const isize evicted : gpu.pool.next_frame()) {
        gpu.scratch.erase(gpu.scratch.begin() + evicted);
    }
    gpu.frame += 1;
    apply_atlas_patches(gpu);
    const pipeline_guard saved{gpu.context.Get()};
    return draw_frame(gpu, frame, target);
}

auto renderer::create_image(const image_pixels& pixels) -> result<draw::image_handle> {
    const draw::pixel_size size = pixels.size;
    const bool has_valid_size = size.width > 0
                                && size.height > 0
                                && size.width <= max_image_side
                                && size.height <= max_image_side;
    if (!has_valid_size
        || !is_covered(
            pixels.rgba, pixels.row_pitch, isize{size.width} * bytes_per_pixel, size.height
        )) {
        return std::unexpected(error{.code = error_code::malformed});
    }
    gpu_state& gpu = m_resources->gpu;
    const std::vector<std::byte> texels = premultiplied(pixels);
    const D3D11_TEXTURE2D_DESC description{
        .Width = narrow<UINT>(size.width),
        .Height = narrow<UINT>(size.height),
        .MipLevels = 1,
        .ArraySize = 1,
        .Format = DXGI_FORMAT_R8G8B8A8_UNORM,
        .SampleDesc = DXGI_SAMPLE_DESC{.Count = 1, .Quality = 0},
        .Usage = D3D11_USAGE_IMMUTABLE,
        .BindFlags = D3D11_BIND_SHADER_RESOURCE,
        .CPUAccessFlags = 0,
        .MiscFlags = 0,
    };
    const D3D11_SUBRESOURCE_DATA initial{
        .pSysMem = texels.data(),
        .SysMemPitch = narrow<UINT>(isize{size.width} * bytes_per_pixel),
        .SysMemSlicePitch = 0,
    };
    ComPtr<ID3D11Texture2D> texture;
    LUCENT_TRY(
        checked(gpu.device->CreateTexture2D(&description, &initial, texture.GetAddressOf()))
    );
    ComPtr<ID3D11ShaderResourceView> view;
    LUCENT_TRY(
        checked(gpu.device->CreateShaderResourceView(texture.Get(), nullptr, view.GetAddressOf()))
    );
    const std::optional<allocated_image> allocated = gpu.images.allocate();
    if (!allocated) {
        return std::unexpected(error{.code = error_code::unsupported});
    }
    const auto slot = narrow<usize>(allocated->slot);
    if (slot >= gpu.image_views.size()) {
        gpu.image_views.resize(slot + 1);
    }
    gpu.image_views.at(slot) = std::move(view);
    return allocated->image;
}

auto renderer::destroy_image(draw::image_handle image) -> void {
    gpu_state& gpu = m_resources->gpu;
    const std::optional<isize> slot = gpu.images.slot_of(image);
    if (!slot) {
        return;
    }
    gpu.image_views.at(narrow<usize>(*slot)).Reset();
    gpu.images.release(image);
}

auto renderer::upload_atlas(std::span<const atlas_upload> uploads) -> void {
    gpu_state& gpu = m_resources->gpu;
    for (const atlas_upload& upload : uploads) {
        LUCENT_INVARIANT(is_valid(upload));
        gpu.atlas_patches.push_back(packed(upload));
    }
}

auto renderer::sampled_light(draw::light_key key) const -> std::optional<draw::color> {
    const gpu_state& gpu = m_resources->gpu;
    const auto found = gpu.lights.find(key);
    if (found == gpu.lights.end()) {
        return std::nullopt;
    }
    return found->second.light;
}

}
