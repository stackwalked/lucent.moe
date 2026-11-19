#include <lucent/d3d11/offscreen.hpp>

#include <algorithm>
#include <array>
#include <bit>
#include <cmath>
#include <cstddef>
#include <expected>
#include <filesystem>
#include <iterator>
#include <ranges>
#include <span>
#include <utility>
#include <vector>

#include <Windows.h>

#include <d3d11.h>

#include <dxgiformat.h>
#include <wincodec.h>
#include <wrl/client.h>

#include <lucent/core/narrow.hpp>
#include <lucent/d3d11/renderer.hpp>
#include <lucent/draw/color.hpp>
#include <lucent/draw/frame_data.hpp>

namespace lucent::d3d11::testing {
namespace {

using Microsoft::WRL::ComPtr;

constexpr isize bytes_per_pixel = 4;

auto succeeded(HRESULT code) -> result<void> {
    if (FAILED(code)) {
        // An HRESULT, not a GetLastError() value; both are Windows' codes for what went wrong.
        return std::unexpected(
            error{.code = error_code::system, .system_code = std::bit_cast<u32>(code)}
        );
    }
    return {};
}

auto pixel_count(draw::pixel_size size) -> isize {
    return isize{size.width} * isize{size.height};
}

// COM for this thread for as long as it lives. An apartment the thread already has is used as it
// is; WIC works in either kind.
class com_scope final {
public:
    com_scope()
        : m_is_owed(SUCCEEDED(CoInitializeEx(nullptr, COINIT_MULTITHREADED))) {}

    com_scope(const com_scope&) = delete ("balances one CoInitializeEx");
    auto operator=(const com_scope&) -> com_scope& = delete ("balances one CoInitializeEx");
    com_scope(com_scope&&) = delete ("balances one CoInitializeEx");
    auto operator=(com_scope&&) -> com_scope& = delete ("balances one CoInitializeEx");

    ~com_scope() {
        if (m_is_owed) {
            CoUninitialize();
        }
    }

private:
    bool m_is_owed;
};

auto imaging_factory() -> result<ComPtr<IWICImagingFactory>> {
    ComPtr<IWICImagingFactory> factory;
    LUCENT_TRY(succeeded(CoCreateInstance(
        CLSID_WICImagingFactory,
        nullptr,
        CLSCTX_INPROC_SERVER,
        IID_IWICImagingFactory,
        IID_PPV_ARGS_Helper(factory.GetAddressOf())
    )));
    return factory;
}

auto is_srgb(u32 format) -> bool {
    return format == static_cast<u32>(DXGI_FORMAT_R8G8B8A8_UNORM_SRGB)
           || format == static_cast<u32>(DXGI_FORMAT_B8G8R8A8_UNORM_SRGB);
}

auto linear_from_srgb(u8 encoded) -> f32 {
    const f64 value = static_cast<f64>(encoded) / 255.0;
    if (value <= 0.04045) {
        return static_cast<f32>(value / 12.92);
    }
    return static_cast<f32>(std::pow((value + 0.055) / 1.055, 2.4));
}

auto unorm(u8 value) -> f32 {
    return static_cast<f32>(value) / 255.0F;
}

enum class texel_layout : u8 {
    rgba8,
    bgra8,
    // The X byte is undefined: the texel is opaque whatever it holds.
    bgrx8,
    rgb10a2,
};

auto layout_of(u32 view_format) -> result<texel_layout> {
    const auto format = static_cast<DXGI_FORMAT>(view_format);
    if (format == DXGI_FORMAT_R8G8B8A8_UNORM || format == DXGI_FORMAT_R8G8B8A8_UNORM_SRGB) {
        return texel_layout::rgba8;
    }
    if (format == DXGI_FORMAT_B8G8R8A8_UNORM || format == DXGI_FORMAT_B8G8R8A8_UNORM_SRGB) {
        return texel_layout::bgra8;
    }
    if (format == DXGI_FORMAT_B8G8R8X8_UNORM) {
        return texel_layout::bgrx8;
    }
    if (format == DXGI_FORMAT_R10G10B10A2_UNORM) {
        return texel_layout::rgb10a2;
    }
    return std::unexpected(error{.code = error_code::unsupported});
}

auto ten_bits_to_8(u32 value) -> std::byte {
    return static_cast<std::byte>((((value & 0x3ffU) * 255U) + 511U) / 1023U);
}

auto rgba_of(std::array<std::byte, 4> texel, texel_layout layout) -> std::array<std::byte, 4> {
    switch (layout) {
    case texel_layout::rgba8:
        return {texel[0], texel[1], texel[2], texel[3]};
    case texel_layout::bgra8:
        return {texel[2], texel[1], texel[0], texel[3]};
    case texel_layout::bgrx8:
        return {texel[2], texel[1], texel[0], std::byte{255}};
    case texel_layout::rgb10a2: {
        // Little-endian, as D3D lays out every format and as x64 reads a u32.
        const auto packed = std::bit_cast<u32>(texel);
        return {
            ten_bits_to_8(packed),
            ten_bits_to_8(packed >> 10U),
            ten_bits_to_8(packed >> 20U),
            static_cast<std::byte>((packed >> 30U) * 85U),
        };
    }
    }
    LUCENT_UNREACHABLE();
}

// The texture read_back copies to staging: the target itself, or for MSAA a single-sampled copy
// resolved in the view's format (a typeless texture can't be resolved as itself).
auto single_sampled(const warp_device& device, const render_target& target)
    -> result<ComPtr<ID3D11Texture2D>> {
    D3D11_TEXTURE2D_DESC description{};
    target.texture->GetDesc(&description);
    if (description.SampleDesc.Count == 1) {
        return ComPtr<ID3D11Texture2D>{target.texture};
    }
    description.Format = static_cast<DXGI_FORMAT>(target.format);
    description.SampleDesc = DXGI_SAMPLE_DESC{.Count = 1, .Quality = 0};
    description.BindFlags = 0;
    ComPtr<ID3D11Texture2D> resolved;
    LUCENT_TRY(
        succeeded(device.device()->CreateTexture2D(&description, nullptr, resolved.GetAddressOf()))
    );
    device.context()->ResolveSubresource(
        resolved.Get(), 0, target.texture, 0, static_cast<DXGI_FORMAT>(target.format)
    );
    return resolved;
}

auto staging_copy(const warp_device& device, ID3D11Texture2D* source)
    -> result<ComPtr<ID3D11Texture2D>> {
    D3D11_TEXTURE2D_DESC description{};
    source->GetDesc(&description);
    description.Usage = D3D11_USAGE_STAGING;
    description.BindFlags = 0;
    description.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
    description.MiscFlags = 0;
    ComPtr<ID3D11Texture2D> staging;
    LUCENT_TRY(
        succeeded(device.device()->CreateTexture2D(&description, nullptr, staging.GetAddressOf()))
    );
    device.context()->CopyResource(staging.Get(), source);
    return staging;
}

auto converted(
    std::span<const std::byte> mapped, isize row_pitch, draw::pixel_size size, texel_layout layout
) -> image {
    image pixels{.size = size, .rgba = {}};
    pixels.rgba.reserve(narrow<usize>(pixel_count(size) * bytes_per_pixel));
    for (const isize row : std::views::iota(isize{0}, isize{size.height})) {
        const std::span<const std::byte> texels = mapped.subspan(
            narrow<usize>(row * row_pitch), narrow<usize>(size.width * bytes_per_pixel)
        );
        for (const auto chunk : texels | std::views::chunk(bytes_per_pixel)) {
            std::array<std::byte, 4> texel{};
            std::ranges::copy(chunk, texel.begin());
            pixels.rgba.append_range(rgba_of(texel, layout));
        }
    }
    return pixels;
}

// A PNG encoder's frame, made for a file at path and sized, ready for pixels.
struct png_frame {
    ComPtr<IWICStream> stream;
    ComPtr<IWICBitmapEncoder> encoder;
    ComPtr<IWICBitmapFrameEncode> frame;
};

auto png_frame_for(const std::filesystem::path& path, draw::pixel_size size) -> result<png_frame> {
    const ComPtr<IWICImagingFactory> factory = LUCENT_TRY(imaging_factory());
    png_frame made;
    LUCENT_TRY(succeeded(factory->CreateStream(made.stream.GetAddressOf())));
    LUCENT_TRY(succeeded(made.stream->InitializeFromFilename(path.c_str(), GENERIC_WRITE)));
    LUCENT_TRY(succeeded(
        factory->CreateEncoder(GUID_ContainerFormatPng, nullptr, made.encoder.GetAddressOf())
    ));
    LUCENT_TRY(succeeded(made.encoder->Initialize(made.stream.Get(), WICBitmapEncoderNoCache)));
    LUCENT_TRY(succeeded(made.encoder->CreateNewFrame(made.frame.GetAddressOf(), nullptr)));
    LUCENT_TRY(succeeded(made.frame->Initialize(nullptr)));
    LUCENT_TRY(succeeded(made.frame->SetSize(narrow<UINT>(size.width), narrow<UINT>(size.height))));
    return made;
}

auto bgra_of(const image& pixels) -> std::vector<BYTE> {
    std::vector<BYTE> bgra;
    bgra.reserve(pixels.rgba.size());
    for (const auto chunk : pixels.rgba | std::views::chunk(bytes_per_pixel)) {
        std::array<std::byte, 4> texel{};
        std::ranges::copy(chunk, texel.begin());
        bgra.append_range(
            std::array{
                std::to_integer<BYTE>(texel[2]),
                std::to_integer<BYTE>(texel[1]),
                std::to_integer<BYTE>(texel[0]),
                std::to_integer<BYTE>(texel[3]),
            }
        );
    }
    return bgra;
}

auto is_well_formed(const image& pixels) -> bool {
    return std::cmp_equal(pixels.rgba.size(), pixel_count(pixels.size) * bytes_per_pixel);
}

}

warp_device::warp_device(ComPtr<ID3D11Device> device, ComPtr<ID3D11DeviceContext> context)
    : m_device(std::move(device))
    , m_context(std::move(context)) {}

auto warp_device::create() -> result<warp_device> {
    constexpr std::array levels{D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0};
    ComPtr<ID3D11Device> device;
    ComPtr<ID3D11DeviceContext> context;
    LUCENT_TRY(succeeded(D3D11CreateDevice(
        nullptr,
        D3D_DRIVER_TYPE_WARP,
        nullptr,
        0,
        levels.data(),
        static_cast<UINT>(levels.size()),
        D3D11_SDK_VERSION,
        device.GetAddressOf(),
        nullptr,
        context.GetAddressOf()
    )));
    return warp_device{std::move(device), std::move(context)};
}

auto warp_device::device() const -> ID3D11Device* {
    return m_device.Get();
}

auto warp_device::context() const -> ID3D11DeviceContext* {
    return m_context.Get();
}

test_target::test_target(parts owned)
    : m_context(std::move(owned.context))
    , m_texture(std::move(owned.texture))
    , m_view(std::move(owned.view))
    , m_spec(owned.spec) {}

auto test_target::create(const warp_device& device, const target_spec& spec)
    -> result<test_target> {
    LUCENT_INVARIANT(spec.size.width > 0 && spec.size.height > 0 && spec.sample_count >= 1);
    if (spec.sample_count > 1) {
        UINT quality_levels = 0;
        const HRESULT checked = device.device()->CheckMultisampleQualityLevels(
            static_cast<DXGI_FORMAT>(spec.view_format), spec.sample_count, &quality_levels
        );
        if (FAILED(checked) || quality_levels == 0) {
            return std::unexpected(error{.code = error_code::unsupported});
        }
    }
    const D3D11_TEXTURE2D_DESC texture_description{
        .Width = narrow<UINT>(spec.size.width),
        .Height = narrow<UINT>(spec.size.height),
        .MipLevels = 1,
        .ArraySize = 1,
        .Format = static_cast<DXGI_FORMAT>(spec.format),
        .SampleDesc = DXGI_SAMPLE_DESC{.Count = spec.sample_count, .Quality = 0},
        .Usage = D3D11_USAGE_DEFAULT,
        .BindFlags = D3D11_BIND_RENDER_TARGET,
        .CPUAccessFlags = 0,
        .MiscFlags = 0,
    };
    ComPtr<ID3D11Texture2D> texture;
    LUCENT_TRY(succeeded(
        device.device()->CreateTexture2D(&texture_description, nullptr, texture.GetAddressOf())
    ));
    D3D11_RENDER_TARGET_VIEW_DESC view_description{};
    view_description.Format = static_cast<DXGI_FORMAT>(spec.view_format);
    view_description.ViewDimension =
        spec.sample_count > 1 ? D3D11_RTV_DIMENSION_TEXTURE2DMS : D3D11_RTV_DIMENSION_TEXTURE2D;
    ComPtr<ID3D11RenderTargetView> view;
    LUCENT_TRY(succeeded(device.device()->CreateRenderTargetView(
        texture.Get(), &view_description, view.GetAddressOf()
    )));
    return test_target{parts{
        .context = ComPtr<ID3D11DeviceContext>{device.context()},
        .texture = std::move(texture),
        .view = std::move(view),
        .spec = spec,
    }};
}

auto test_target::as_render_target() const -> render_target {
    return {
        .view = m_view.Get(),
        .texture = m_texture.Get(),
        .size = m_spec.size,
        .format = m_spec.view_format,
        .sample_count = m_spec.sample_count,
    };
}

auto test_target::clear(draw::color straight_srgb) -> void {
    // An _SRGB view encodes what it is given, so it is given the colour decoded; a UNORM view
    // stores it as it is.
    const bool is_encoding = is_srgb(m_spec.view_format);
    const auto channel = [is_encoding](u8 value) {
        return is_encoding ? linear_from_srgb(value) : unorm(value);
    };
    const std::array<f32, 4> value{
        channel(straight_srgb.r),
        channel(straight_srgb.g),
        channel(straight_srgb.b),
        unorm(straight_srgb.a),
    };
    m_context->ClearRenderTargetView(m_view.Get(), value.data());
}

auto read_back(const warp_device& device, const test_target& target) -> result<image> {
    const render_target held = target.as_render_target();
    const texel_layout layout = LUCENT_TRY(layout_of(held.format));
    const ComPtr<ID3D11Texture2D> source = LUCENT_TRY(single_sampled(device, held));
    const ComPtr<ID3D11Texture2D> staging = LUCENT_TRY(staging_copy(device, source.Get()));
    D3D11_MAPPED_SUBRESOURCE mapped{};
    LUCENT_TRY(succeeded(device.context()->Map(staging.Get(), 0, D3D11_MAP_READ, 0, &mapped)));
    const auto row_pitch = isize{mapped.RowPitch};
    const isize mapped_size =
        (row_pitch * (held.size.height - 1)) + (isize{held.size.width} * bytes_per_pixel);
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wunsafe-buffer-usage-in-container" // Map's rows, pitch apart
    const std::span<const std::byte> bytes{
        static_cast<const std::byte*>(mapped.pData), narrow<usize>(mapped_size)
    };
#pragma clang diagnostic pop
    image pixels = converted(bytes, row_pitch, held.size, layout);
    device.context()->Unmap(staging.Get(), 0);
    return pixels;
}

auto write_png(const std::filesystem::path& path, const image& pixels) -> result<void> {
    LUCENT_INVARIANT(is_well_formed(pixels));
    const com_scope com;
    const png_frame png = LUCENT_TRY(png_frame_for(path, pixels.size));
    // found: on build 26100 WIC's PNG encoder answers a request for 32bppRGBA with another
    //        format; 32bppBGRA it takes as it is.
    WICPixelFormatGUID format = GUID_WICPixelFormat32bppBGRA;
    LUCENT_TRY(succeeded(png.frame->SetPixelFormat(&format)));
    if (format != GUID_WICPixelFormat32bppBGRA) {
        return std::unexpected(error{.code = error_code::unsupported});
    }
    std::vector<BYTE> bgra = bgra_of(pixels);
    LUCENT_TRY(succeeded(png.frame->WritePixels(
        narrow<UINT>(pixels.size.height),
        narrow<UINT>(pixels.size.width * bytes_per_pixel),
        narrow<UINT>(bgra.size()),
        bgra.data()
    )));
    LUCENT_TRY(succeeded(png.frame->Commit()));
    LUCENT_TRY(succeeded(png.encoder->Commit()));
    return {};
}

auto read_png(const std::filesystem::path& path) -> result<image> {
    const com_scope com;
    const ComPtr<IWICImagingFactory> factory = LUCENT_TRY(imaging_factory());
    ComPtr<IWICBitmapDecoder> decoder;
    LUCENT_TRY(succeeded(factory->CreateDecoderFromFilename(
        path.c_str(), nullptr, GENERIC_READ, WICDecodeMetadataCacheOnDemand, decoder.GetAddressOf()
    )));
    ComPtr<IWICBitmapFrameDecode> frame;
    LUCENT_TRY(succeeded(decoder->GetFrame(0, frame.GetAddressOf())));
    ComPtr<IWICBitmapSource> as_rgba;
    LUCENT_TRY(succeeded(
        WICConvertBitmapSource(GUID_WICPixelFormat32bppRGBA, frame.Get(), as_rgba.GetAddressOf())
    ));
    UINT width = 0;
    UINT height = 0;
    LUCENT_TRY(succeeded(as_rgba->GetSize(&width, &height)));
    const draw::pixel_size size{.width = narrow<i32>(width), .height = narrow<i32>(height)};
    std::vector<BYTE> rgba(narrow<usize>(pixel_count(size) * bytes_per_pixel));
    LUCENT_TRY(succeeded(as_rgba->CopyPixels(
        nullptr,
        narrow<UINT>(isize{size.width} * bytes_per_pixel),
        narrow<UINT>(rgba.size()),
        rgba.data()
    )));
    image pixels{.size = size, .rgba = {}};
    pixels.rgba.reserve(rgba.size());
    std::ranges::transform(rgba, std::back_inserter(pixels.rgba), [](BYTE value) {
        return std::byte{value};
    });
    return pixels;
}

}
