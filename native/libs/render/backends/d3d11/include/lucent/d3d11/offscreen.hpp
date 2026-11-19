#pragma once

#include <cstddef>
#include <filesystem>
#include <vector>

#include <d3d11.h>

#include <wrl/client.h>

#include <lucent/d3d11/renderer.hpp>
#include <lucent/draw/color.hpp>
#include <lucent/draw/frame_data.hpp>

namespace lucent::d3d11::testing {

// Four bytes a pixel (r, g, b, a), rows tightly packed.
struct image {
    draw::pixel_size size;
    std::vector<std::byte> rgba;
};

// A D3D11 device on WARP, Windows' software rasterizer: the same pixels on every machine with the
// same OS build, and no GPU needed.
class warp_device final {
public:
    static auto create() -> result<warp_device>;

    warp_device(const warp_device&) = delete ("it owns one device");
    auto operator=(const warp_device&) -> warp_device& = delete ("it owns one device");
    warp_device(warp_device&&) noexcept = default;
    auto operator=(warp_device&&) noexcept -> warp_device& = default;
    ~warp_device() = default;

    auto device() const -> ID3D11Device*;
    auto context() const -> ID3D11DeviceContext*;

private:
    warp_device(
        Microsoft::WRL::ComPtr<ID3D11Device> device,
        Microsoft::WRL::ComPtr<ID3D11DeviceContext> context
    );

    Microsoft::WRL::ComPtr<ID3D11Device> m_device;
    Microsoft::WRL::ComPtr<ID3D11DeviceContext> m_context;
};

// format is the texture's DXGI_FORMAT and view_format its render target view's: they differ for a
// typeless texture. sample_count is 1, or the MSAA count.
struct target_spec {
    draw::pixel_size size;
    u32 format = 0;
    u32 view_format = 0;
    u32 sample_count = 1;
};

// A texture and its render target view, made like a swap chain's back buffer: bound only as a
// render target.
class test_target final {
public:
    static auto create(const warp_device& device, const target_spec& spec) -> result<test_target>;

    test_target(const test_target&) = delete ("it owns one texture");
    auto operator=(const test_target&) -> test_target& = delete ("it owns one texture");
    test_target(test_target&&) noexcept = default;
    auto operator=(test_target&&) noexcept -> test_target& = default;
    ~test_target() = default;

    // What renderer::render takes. Borrows this target's texture and view.
    auto as_render_target() const -> render_target;
    // Stores the colour's bytes as they are, straight alpha: on an _SRGB view the stored value is
    // the colour itself, already encoded.
    auto clear(draw::color straight_srgb) -> void;

private:
    struct parts {
        Microsoft::WRL::ComPtr<ID3D11DeviceContext> context;
        Microsoft::WRL::ComPtr<ID3D11Texture2D> texture;
        Microsoft::WRL::ComPtr<ID3D11RenderTargetView> view;
        target_spec spec;
    };

    explicit test_target(parts owned);

    Microsoft::WRL::ComPtr<ID3D11DeviceContext> m_context;
    Microsoft::WRL::ComPtr<ID3D11Texture2D> m_texture;
    Microsoft::WRL::ComPtr<ID3D11RenderTargetView> m_view;
    target_spec m_spec;
};

// Resolves an MSAA target, copies it to staging and converts what it holds to 8-bit RGBA: BGRA is
// swizzled, R10G10B10A2 taken to 8 bits, scRGB's half floats encoded as sRGB with paper white at
// 255. Stored values come back as they are: an _SRGB target's bytes are already sRGB-encoded.
auto read_back(const warp_device& device, const test_target& target) -> result<image>;

auto write_png(const std::filesystem::path& path, const image& pixels) -> result<void>;
auto read_png(const std::filesystem::path& path) -> result<image>;

}
