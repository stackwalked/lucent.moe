#pragma once

#include <array>
#include <concepts>

#include <d3d11.h>

#include <wrl/client.h>

namespace lucent::d3d11 {

// The slots the renderer binds, and so the slots the guard puts back. Everything else in the
// pipeline the renderer never touches.
inline constexpr UINT bound_constant_buffers = 3;
inline constexpr UINT bound_resources = 4;

// A shader and the class instances it was bound with (almost always none).
template <std::derived_from<ID3D11DeviceChild> Shader>
struct bound_shader {
    Microsoft::WRL::ComPtr<Shader> shader;
    std::array<Microsoft::WRL::ComPtr<ID3D11ClassInstance>, D3D11_SHADER_MAX_INTERFACES> instances;
    UINT instance_count = 0;
};

// Saves the caller's pipeline state on construction and restores all of it on destruction, so the
// game never sees what the renderer bound; hull, domain and geometry shaders are cleared between,
// since a tessellation stage left bound makes a triangle draw invalid.
class pipeline_guard final {
public:
    explicit pipeline_guard(ID3D11DeviceContext* context);

    pipeline_guard(const pipeline_guard&) = delete ("restores one context once");
    auto operator=(const pipeline_guard&) -> pipeline_guard& = delete ("restores one context once");
    pipeline_guard(pipeline_guard&&) = delete ("restores one context once");
    auto operator=(pipeline_guard&&) -> pipeline_guard& = delete ("restores one context once");
    ~pipeline_guard();

private:
    using buffers = std::array<Microsoft::WRL::ComPtr<ID3D11Buffer>, bound_constant_buffers>;
    using resources = std::array<Microsoft::WRL::ComPtr<ID3D11ShaderResourceView>, bound_resources>;
    using targets = std::array<
        Microsoft::WRL::ComPtr<ID3D11RenderTargetView>,
        D3D11_SIMULTANEOUS_RENDER_TARGET_COUNT>;
    using rects = std::array<D3D11_RECT, D3D11_VIEWPORT_AND_SCISSORRECT_OBJECT_COUNT_PER_PIPELINE>;
    using viewports =
        std::array<D3D11_VIEWPORT, D3D11_VIEWPORT_AND_SCISSORRECT_OBJECT_COUNT_PER_PIPELINE>;

    Microsoft::WRL::ComPtr<ID3D11DeviceContext> m_context;

    Microsoft::WRL::ComPtr<ID3D11InputLayout> m_input_layout;
    Microsoft::WRL::ComPtr<ID3D11Buffer> m_vertex_buffer;
    UINT m_vertex_stride = 0;
    UINT m_vertex_offset = 0;
    Microsoft::WRL::ComPtr<ID3D11Buffer> m_index_buffer;
    DXGI_FORMAT m_index_format = DXGI_FORMAT_UNKNOWN;
    UINT m_index_offset = 0;
    D3D11_PRIMITIVE_TOPOLOGY m_topology = D3D11_PRIMITIVE_TOPOLOGY_UNDEFINED;

    bound_shader<ID3D11VertexShader> m_vertex_shader;
    buffers m_vertex_constants;
    resources m_vertex_resources;
    bound_shader<ID3D11HullShader> m_hull_shader;
    bound_shader<ID3D11DomainShader> m_domain_shader;
    bound_shader<ID3D11GeometryShader> m_geometry_shader;
    bound_shader<ID3D11PixelShader> m_pixel_shader;
    buffers m_pixel_constants;
    resources m_pixel_resources;
    Microsoft::WRL::ComPtr<ID3D11SamplerState> m_sampler;

    Microsoft::WRL::ComPtr<ID3D11RasterizerState> m_rasterizer;
    viewports m_viewports{};
    // In: how many fit; out: how many the caller had.
    UINT m_viewport_count = D3D11_VIEWPORT_AND_SCISSORRECT_OBJECT_COUNT_PER_PIPELINE;
    rects m_scissors{};
    UINT m_scissor_count = D3D11_VIEWPORT_AND_SCISSORRECT_OBJECT_COUNT_PER_PIPELINE;

    Microsoft::WRL::ComPtr<ID3D11BlendState> m_blend;
    std::array<FLOAT, 4> m_blend_factor{};
    UINT m_sample_mask = 0;
    Microsoft::WRL::ComPtr<ID3D11DepthStencilState> m_depth_stencil;
    UINT m_stencil_reference = 0;
    targets m_targets;
    Microsoft::WRL::ComPtr<ID3D11DepthStencilView> m_depth_view;
};

}
