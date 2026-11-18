#include <array>
#include <bit>
#include <cstddef>
#include <expected>
#include <numeric>
#include <span>
#include <vector>

#include <d3d11.h>

#include <wrl/client.h>

#include <lucent/core/narrow.hpp>
#include <lucent/d3d11/shaders/blur_ps.hpp>
#include <lucent/d3d11/shaders/composite_ps.hpp>
#include <lucent/d3d11/shaders/downsample_ps.hpp>
#include <lucent/d3d11/shaders/main_ps.hpp>
#include <lucent/d3d11/shaders/pass_vs.hpp>
#include <lucent/d3d11/shaders/path_vs.hpp>
#include <lucent/d3d11/shaders/quad_vs.hpp>
#include <lucent/draw/draw_list.hpp>
#include <lucent/draw/glyph_run.hpp>
#include <lucent/draw/path_vertex.hpp>

#include "constants.hpp"
#include "gpu_state.hpp"

namespace lucent::d3d11 {
namespace {

using Microsoft::WRL::ComPtr;

auto vertex_shader(ID3D11Device* device, std::span<const std::byte> bytecode)
    -> result<ComPtr<ID3D11VertexShader>> {
    ComPtr<ID3D11VertexShader> shader;
    LUCENT_TRY(checked(
        device->CreateVertexShader(bytecode.data(), bytecode.size(), nullptr, shader.GetAddressOf())
    ));
    return shader;
}

auto pixel_shader(ID3D11Device* device, std::span<const std::byte> bytecode)
    -> result<ComPtr<ID3D11PixelShader>> {
    ComPtr<ID3D11PixelShader> shader;
    LUCENT_TRY(checked(
        device->CreatePixelShader(bytecode.data(), bytecode.size(), nullptr, shader.GetAddressOf())
    ));
    return shader;
}

auto constant_buffer(ID3D11Device* device, usize size) -> result<ComPtr<ID3D11Buffer>> {
    const D3D11_BUFFER_DESC description{
        .ByteWidth = narrow<UINT>(size),
        .Usage = D3D11_USAGE_DYNAMIC,
        .BindFlags = D3D11_BIND_CONSTANT_BUFFER,
        .CPUAccessFlags = D3D11_CPU_ACCESS_WRITE,
        .MiscFlags = 0,
        .StructureByteStride = 0,
    };
    ComPtr<ID3D11Buffer> buffer;
    LUCENT_TRY(checked(device->CreateBuffer(&description, nullptr, buffer.GetAddressOf())));
    return buffer;
}

auto record_indices(ID3D11Device* device) -> result<ComPtr<ID3D11Buffer>> {
    std::vector<u32> indices(narrow<usize>(draw::draw_list::max_records));
    std::ranges::iota(indices, u32{0});
    const D3D11_BUFFER_DESC description{
        .ByteWidth = narrow<UINT>(indices.size() * sizeof(u32)),
        .Usage = D3D11_USAGE_IMMUTABLE,
        .BindFlags = D3D11_BIND_VERTEX_BUFFER,
        .CPUAccessFlags = 0,
        .MiscFlags = 0,
        .StructureByteStride = 0,
    };
    const D3D11_SUBRESOURCE_DATA initial{
        .pSysMem = indices.data(),
        .SysMemPitch = 0,
        .SysMemSlicePitch = 0,
    };
    ComPtr<ID3D11Buffer> buffer;
    LUCENT_TRY(checked(device->CreateBuffer(&description, &initial, buffer.GetAddressOf())));
    return buffer;
}

auto quad_layout(ID3D11Device* device) -> result<ComPtr<ID3D11InputLayout>> {
    const std::array elements{
        D3D11_INPUT_ELEMENT_DESC{
            .SemanticName = "RECORD",
            .SemanticIndex = 0,
            .Format = DXGI_FORMAT_R32_UINT,
            .InputSlot = 0,
            .AlignedByteOffset = 0,
            .InputSlotClass = D3D11_INPUT_PER_INSTANCE_DATA,
            .InstanceDataStepRate = 1,
        },
    };
    ComPtr<ID3D11InputLayout> layout;
    LUCENT_TRY(checked(device->CreateInputLayout(
        elements.data(),
        narrow<UINT>(elements.size()),
        shaders::quad_vs.data(),
        shaders::quad_vs.size(),
        layout.GetAddressOf()
    )));
    return layout;
}

auto path_layout(ID3D11Device* device) -> result<ComPtr<ID3D11InputLayout>> {
    const std::array elements{
        D3D11_INPUT_ELEMENT_DESC{
            .SemanticName = "POSITION",
            .SemanticIndex = 0,
            .Format = DXGI_FORMAT_R32G32_FLOAT,
            .InputSlot = 0,
            .AlignedByteOffset = offsetof(draw::path_vertex, position),
            .InputSlotClass = D3D11_INPUT_PER_VERTEX_DATA,
            .InstanceDataStepRate = 0,
        },
        // Red in the low byte, as draw packs it: R8G8B8A8_UNORM reads it in that order.
        D3D11_INPUT_ELEMENT_DESC{
            .SemanticName = "COLOR",
            .SemanticIndex = 0,
            .Format = DXGI_FORMAT_R8G8B8A8_UNORM,
            .InputSlot = 0,
            .AlignedByteOffset = offsetof(draw::path_vertex, tint),
            .InputSlotClass = D3D11_INPUT_PER_VERTEX_DATA,
            .InstanceDataStepRate = 0,
        },
    };
    ComPtr<ID3D11InputLayout> layout;
    LUCENT_TRY(checked(device->CreateInputLayout(
        elements.data(),
        narrow<UINT>(elements.size()),
        shaders::path_vs.data(),
        shaders::path_vs.size(),
        layout.GetAddressOf()
    )));
    return layout;
}

enum class blending : u8 { premultiplied, replace };

auto blend_state(ID3D11Device* device, blending mode) -> result<ComPtr<ID3D11BlendState>> {
    // Premultiplied: the shaders fold alpha into rgb, so the source is added whole.
    const D3D11_RENDER_TARGET_BLEND_DESC target{
        .BlendEnable = mode == blending::premultiplied ? TRUE : FALSE,
        .SrcBlend = D3D11_BLEND_ONE,
        .DestBlend = D3D11_BLEND_INV_SRC_ALPHA,
        .BlendOp = D3D11_BLEND_OP_ADD,
        .SrcBlendAlpha = D3D11_BLEND_ONE,
        .DestBlendAlpha = D3D11_BLEND_INV_SRC_ALPHA,
        .BlendOpAlpha = D3D11_BLEND_OP_ADD,
        .RenderTargetWriteMask = D3D11_COLOR_WRITE_ENABLE_ALL,
    };
    // Only the first is read (IndependentBlendEnable is off); all eight are written so none holds
    // a zero that names no blend.
    const D3D11_BLEND_DESC description{
        .AlphaToCoverageEnable = FALSE,
        .IndependentBlendEnable = FALSE,
        .RenderTarget = {target, target, target, target, target, target, target, target},
    };
    ComPtr<ID3D11BlendState> state;
    LUCENT_TRY(checked(device->CreateBlendState(&description, state.GetAddressOf())));
    return state;
}

auto rasterizer(ID3D11Device* device) -> result<ComPtr<ID3D11RasterizerState>> {
    const D3D11_RASTERIZER_DESC description{
        .FillMode = D3D11_FILL_SOLID,
        .CullMode = D3D11_CULL_NONE,
        .FrontCounterClockwise = FALSE,
        .DepthBias = 0,
        .DepthBiasClamp = 0.0F,
        .SlopeScaledDepthBias = 0.0F,
        .DepthClipEnable = TRUE,
        .ScissorEnable = TRUE,
        // Path triangles get the target's samples; the shapes antialias themselves.
        .MultisampleEnable = TRUE,
        .AntialiasedLineEnable = FALSE,
    };
    ComPtr<ID3D11RasterizerState> state;
    LUCENT_TRY(checked(device->CreateRasterizerState(&description, state.GetAddressOf())));
    return state;
}

auto no_depth(ID3D11Device* device) -> result<ComPtr<ID3D11DepthStencilState>> {
    const D3D11_DEPTH_STENCILOP_DESC unused_face{
        .StencilFailOp = D3D11_STENCIL_OP_KEEP,
        .StencilDepthFailOp = D3D11_STENCIL_OP_KEEP,
        .StencilPassOp = D3D11_STENCIL_OP_KEEP,
        .StencilFunc = D3D11_COMPARISON_ALWAYS,
    };
    const D3D11_DEPTH_STENCIL_DESC description{
        .DepthEnable = FALSE,
        .DepthWriteMask = D3D11_DEPTH_WRITE_MASK_ZERO,
        .DepthFunc = D3D11_COMPARISON_ALWAYS,
        .StencilEnable = FALSE,
        .StencilReadMask = D3D11_DEFAULT_STENCIL_READ_MASK,
        .StencilWriteMask = D3D11_DEFAULT_STENCIL_WRITE_MASK,
        .FrontFace = unused_face,
        .BackFace = unused_face,
    };
    ComPtr<ID3D11DepthStencilState> state;
    LUCENT_TRY(checked(device->CreateDepthStencilState(&description, state.GetAddressOf())));
    return state;
}

auto linear_clamp(ID3D11Device* device) -> result<ComPtr<ID3D11SamplerState>> {
    const D3D11_SAMPLER_DESC description{
        .Filter = D3D11_FILTER_MIN_MAG_MIP_LINEAR,
        .AddressU = D3D11_TEXTURE_ADDRESS_CLAMP,
        .AddressV = D3D11_TEXTURE_ADDRESS_CLAMP,
        .AddressW = D3D11_TEXTURE_ADDRESS_CLAMP,
        .MipLODBias = 0.0F,
        .MaxAnisotropy = 1,
        .ComparisonFunc = D3D11_COMPARISON_NEVER,
        .BorderColor = {0.0F, 0.0F, 0.0F, 0.0F},
        .MinLOD = 0.0F,
        .MaxLOD = D3D11_FLOAT32_MAX,
    };
    ComPtr<ID3D11SamplerState> state;
    LUCENT_TRY(checked(device->CreateSamplerState(&description, state.GetAddressOf())));
    return state;
}

struct atlas_texture {
    ComPtr<ID3D11Texture2D> texture;
    ComPtr<ID3D11ShaderResourceView> view;
};

// Every page starts clear: a slice nothing has been uploaded to covers nothing.
auto atlas(ID3D11Device* device) -> result<atlas_texture> {
    const D3D11_TEXTURE2D_DESC description{
        .Width = narrow<UINT>(draw::atlas_page_size),
        .Height = narrow<UINT>(draw::atlas_page_size),
        .MipLevels = 1,
        .ArraySize = narrow<UINT>(draw::atlas_page_count),
        .Format = DXGI_FORMAT_R8_UNORM,
        .SampleDesc = DXGI_SAMPLE_DESC{.Count = 1, .Quality = 0},
        .Usage = D3D11_USAGE_DEFAULT,
        .BindFlags = D3D11_BIND_SHADER_RESOURCE,
        .CPUAccessFlags = 0,
        .MiscFlags = 0,
    };
    const std::vector<std::byte> clear(
        narrow<usize>(isize{draw::atlas_page_size} * isize{draw::atlas_page_size})
    );
    std::array<D3D11_SUBRESOURCE_DATA, draw::atlas_page_count> pages{};
    pages.fill({
        .pSysMem = clear.data(),
        .SysMemPitch = narrow<UINT>(draw::atlas_page_size),
        .SysMemSlicePitch = 0,
    });
    atlas_texture made;
    LUCENT_TRY(
        checked(device->CreateTexture2D(&description, pages.data(), made.texture.GetAddressOf()))
    );
    LUCENT_TRY(checked(
        device->CreateShaderResourceView(made.texture.Get(), nullptr, made.view.GetAddressOf())
    ));
    return made;
}

auto light_texture(ID3D11Device* device, D3D11_USAGE usage) -> result<ComPtr<ID3D11Texture2D>> {
    const bool is_staging = usage == D3D11_USAGE_STAGING;
    const D3D11_TEXTURE2D_DESC description{
        .Width = narrow<UINT>(light_probe_size),
        .Height = narrow<UINT>(light_probe_size),
        .MipLevels = 1,
        .ArraySize = 1,
        .Format = DXGI_FORMAT_R32G32B32A32_FLOAT,
        .SampleDesc = DXGI_SAMPLE_DESC{.Count = 1, .Quality = 0},
        .Usage = usage,
        .BindFlags = is_staging ? 0U : static_cast<UINT>(D3D11_BIND_RENDER_TARGET),
        .CPUAccessFlags = is_staging ? static_cast<UINT>(D3D11_CPU_ACCESS_READ) : 0U,
        .MiscFlags = 0,
    };
    ComPtr<ID3D11Texture2D> texture;
    LUCENT_TRY(checked(device->CreateTexture2D(&description, nullptr, texture.GetAddressOf())));
    return texture;
}

auto programs(ID3D11Device* device) -> result<shader_programs> {
    return shader_programs{
        .quad_vertex = LUCENT_TRY(vertex_shader(device, shaders::quad_vs)),
        .path_vertex = LUCENT_TRY(vertex_shader(device, shaders::path_vs)),
        .pass_vertex = LUCENT_TRY(vertex_shader(device, shaders::pass_vs)),
        .main_pixel = LUCENT_TRY(pixel_shader(device, shaders::main_ps)),
        .blur_pixel = LUCENT_TRY(pixel_shader(device, shaders::blur_ps)),
        .downsample_pixel = LUCENT_TRY(pixel_shader(device, shaders::downsample_ps)),
        .composite_pixel = LUCENT_TRY(pixel_shader(device, shaders::composite_ps)),
        .quad_layout = LUCENT_TRY(quad_layout(device)),
        .path_layout = LUCENT_TRY(path_layout(device)),
    };
}

auto states(ID3D11Device* device) -> result<pipeline_states> {
    return pipeline_states{
        .record_indices = LUCENT_TRY(record_indices(device)),
        .frame_buffer = LUCENT_TRY(constant_buffer(device, sizeof(frame_constants))),
        .mask_buffer = LUCENT_TRY(constant_buffer(device, sizeof(mask_constants))),
        .pass_buffer = LUCENT_TRY(constant_buffer(device, sizeof(pass_constants))),
        .premultiplied_blend = LUCENT_TRY(blend_state(device, blending::premultiplied)),
        .replace_blend = LUCENT_TRY(blend_state(device, blending::replace)),
        .rasterizer = LUCENT_TRY(rasterizer(device)),
        .no_depth = LUCENT_TRY(no_depth(device)),
        .linear_clamp = LUCENT_TRY(linear_clamp(device)),
    };
}

auto textures(ID3D11Device* device) -> result<device_textures> {
    const atlas_texture pages = LUCENT_TRY(atlas(device));
    device_textures made;
    made.atlas = pages.texture;
    made.atlas_view = pages.view;
    made.light_probe = LUCENT_TRY(light_texture(device, D3D11_USAGE_DEFAULT));
    LUCENT_TRY(checked(device->CreateRenderTargetView(
        made.light_probe.Get(), nullptr, made.light_probe_target.GetAddressOf()
    )));
    for (ComPtr<ID3D11Texture2D>& staging : made.light_staging) {
        staging = LUCENT_TRY(light_texture(device, D3D11_USAGE_STAGING));
    }
    return made;
}

}

auto checked(HRESULT code) -> result<void> {
    if (FAILED(code)) {
        return std::unexpected(
            error{.code = error_code::system, .system_code = std::bit_cast<u32>(code)}
        );
    }
    return {};
}

auto build_device_objects(ID3D11Device* device) -> result<device_objects> {
    return device_objects{
        .programs = LUCENT_TRY(programs(device)),
        .states = LUCENT_TRY(states(device)),
        .textures = LUCENT_TRY(textures(device)),
    };
}

}
