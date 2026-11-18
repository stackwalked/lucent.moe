#include "pipeline_guard.hpp"

#include <array>
#include <concepts>
#include <ranges>

#include <d3d11.h>

#include <wrl/client.h>

namespace lucent::d3d11 {
namespace {

using Microsoft::WRL::ComPtr;

template <std::derived_from<IUnknown> T>
using getter = void (STDMETHODCALLTYPE ID3D11DeviceContext::*)(UINT, UINT, T**);
template <std::derived_from<IUnknown> T>
using setter = void (STDMETHODCALLTYPE ID3D11DeviceContext::*)(UINT, UINT, T* const*);

// The references a Get call hands out, owned.
template <std::derived_from<IUnknown> T, usize Count>
auto adopted(const std::array<T*, Count>& raw) -> std::array<ComPtr<T>, Count> {
    std::array<ComPtr<T>, Count> owned;
    for (auto [held, pointer] : std::views::zip(owned, raw)) {
        held.Attach(pointer);
    }
    return owned;
}

template <std::derived_from<IUnknown> T, usize Count>
auto borrowed(const std::array<ComPtr<T>, Count>& owned) -> std::array<T*, Count> {
    std::array<T*, Count> raw{};
    for (auto [pointer, held] : std::views::zip(raw, owned)) {
        pointer = held.Get();
    }
    return raw;
}

template <std::derived_from<IUnknown> T, usize Count>
auto saved(ID3D11DeviceContext* context, getter<T> get) -> std::array<ComPtr<T>, Count> {
    std::array<T*, Count> raw{};
    (context->*get)(0, Count, raw.data());
    return adopted(raw);
}

template <std::derived_from<IUnknown> T, usize Count>
auto restore(ID3D11DeviceContext* context, setter<T> set, const std::array<ComPtr<T>, Count>& owned)
    -> void {
    const std::array<T*, Count> raw = borrowed(owned);
    (context->*set)(0, Count, raw.data());
}

template <std::derived_from<ID3D11DeviceChild> Shader>
using shader_getter = void (STDMETHODCALLTYPE ID3D11DeviceContext::*)(
    Shader**, ID3D11ClassInstance**, UINT*
);
template <std::derived_from<ID3D11DeviceChild> Shader>
using shader_setter = void (STDMETHODCALLTYPE ID3D11DeviceContext::*)(
    Shader*, ID3D11ClassInstance* const*, UINT
);

template <std::derived_from<ID3D11DeviceChild> Shader>
auto saved_shader(ID3D11DeviceContext* context, shader_getter<Shader> get) -> bound_shader<Shader> {
    std::array<ID3D11ClassInstance*, D3D11_SHADER_MAX_INTERFACES> instances{};
    bound_shader<Shader> saved;
    saved.instance_count = static_cast<UINT>(instances.size());
    (context->*get)(saved.shader.GetAddressOf(), instances.data(), &saved.instance_count);
    saved.instances = adopted(instances);
    return saved;
}

template <std::derived_from<ID3D11DeviceChild> Shader>
auto restore_shader(
    ID3D11DeviceContext* context, shader_setter<Shader> set, const bound_shader<Shader>& saved
) -> void {
    const std::array<ID3D11ClassInstance*, D3D11_SHADER_MAX_INTERFACES> instances =
        borrowed(saved.instances);
    (context->*set)(saved.shader.Get(), instances.data(), saved.instance_count);
}

}

pipeline_guard::pipeline_guard(ID3D11DeviceContext* context)
    : m_context(context) {
    m_context->IAGetInputLayout(m_input_layout.GetAddressOf());
    m_context->IAGetVertexBuffers(
        0, 1, m_vertex_buffer.GetAddressOf(), &m_vertex_stride, &m_vertex_offset
    );
    m_context->IAGetIndexBuffer(m_index_buffer.GetAddressOf(), &m_index_format, &m_index_offset);
    m_context->IAGetPrimitiveTopology(&m_topology);

    m_vertex_shader = saved_shader(context, &ID3D11DeviceContext::VSGetShader);
    m_vertex_constants = saved<ID3D11Buffer, bound_constant_buffers>(
        context, &ID3D11DeviceContext::VSGetConstantBuffers
    );
    m_vertex_resources = saved<ID3D11ShaderResourceView, bound_resources>(
        context, &ID3D11DeviceContext::VSGetShaderResources
    );
    m_hull_shader = saved_shader(context, &ID3D11DeviceContext::HSGetShader);
    m_domain_shader = saved_shader(context, &ID3D11DeviceContext::DSGetShader);
    m_geometry_shader = saved_shader(context, &ID3D11DeviceContext::GSGetShader);
    m_pixel_shader = saved_shader(context, &ID3D11DeviceContext::PSGetShader);
    m_pixel_constants = saved<ID3D11Buffer, bound_constant_buffers>(
        context, &ID3D11DeviceContext::PSGetConstantBuffers
    );
    m_pixel_resources = saved<ID3D11ShaderResourceView, bound_resources>(
        context, &ID3D11DeviceContext::PSGetShaderResources
    );
    m_context->PSGetSamplers(0, 1, m_sampler.GetAddressOf());

    m_context->RSGetState(m_rasterizer.GetAddressOf());
    m_context->RSGetViewports(&m_viewport_count, m_viewports.data());
    m_context->RSGetScissorRects(&m_scissor_count, m_scissors.data());

    m_context->OMGetBlendState(m_blend.GetAddressOf(), m_blend_factor.data(), &m_sample_mask);
    m_context->OMGetDepthStencilState(m_depth_stencil.GetAddressOf(), &m_stencil_reference);
    std::array<ID3D11RenderTargetView*, D3D11_SIMULTANEOUS_RENDER_TARGET_COUNT> targets{};
    m_context->OMGetRenderTargets(
        static_cast<UINT>(targets.size()), targets.data(), m_depth_view.GetAddressOf()
    );
    m_targets = adopted(targets);

    m_context->HSSetShader(nullptr, nullptr, 0);
    m_context->DSSetShader(nullptr, nullptr, 0);
    m_context->GSSetShader(nullptr, nullptr, 0);
}

pipeline_guard::~pipeline_guard() {
    const std::array<ID3D11RenderTargetView*, D3D11_SIMULTANEOUS_RENDER_TARGET_COUNT> targets =
        borrowed(m_targets);
    m_context->OMSetRenderTargets(
        static_cast<UINT>(targets.size()), targets.data(), m_depth_view.Get()
    );
    m_context->OMSetDepthStencilState(m_depth_stencil.Get(), m_stencil_reference);
    m_context->OMSetBlendState(m_blend.Get(), m_blend_factor.data(), m_sample_mask);

    m_context->RSSetState(m_rasterizer.Get());
    m_context->RSSetViewports(m_viewport_count, m_viewports.data());
    m_context->RSSetScissorRects(m_scissor_count, m_scissors.data());

    // Resources before shaders and targets: a view the caller had bound as a resource is never
    // also our render target by now, so nothing is unbound behind its back.
    restore(m_context.Get(), &ID3D11DeviceContext::PSSetShaderResources, m_pixel_resources);
    restore(m_context.Get(), &ID3D11DeviceContext::PSSetConstantBuffers, m_pixel_constants);
    const std::array<ID3D11SamplerState*, 1> samplers{m_sampler.Get()};
    m_context->PSSetSamplers(0, 1, samplers.data());
    restore_shader(m_context.Get(), &ID3D11DeviceContext::PSSetShader, m_pixel_shader);
    restore_shader(m_context.Get(), &ID3D11DeviceContext::GSSetShader, m_geometry_shader);
    restore_shader(m_context.Get(), &ID3D11DeviceContext::DSSetShader, m_domain_shader);
    restore_shader(m_context.Get(), &ID3D11DeviceContext::HSSetShader, m_hull_shader);
    restore(m_context.Get(), &ID3D11DeviceContext::VSSetShaderResources, m_vertex_resources);
    restore(m_context.Get(), &ID3D11DeviceContext::VSSetConstantBuffers, m_vertex_constants);
    restore_shader(m_context.Get(), &ID3D11DeviceContext::VSSetShader, m_vertex_shader);

    m_context->IASetPrimitiveTopology(m_topology);
    m_context->IASetIndexBuffer(m_index_buffer.Get(), m_index_format, m_index_offset);
    const std::array<ID3D11Buffer*, 1> vertex_buffers{m_vertex_buffer.Get()};
    m_context->IASetVertexBuffers(0, 1, vertex_buffers.data(), &m_vertex_stride, &m_vertex_offset);
    m_context->IASetInputLayout(m_input_layout.Get());
}

}
