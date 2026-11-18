#pragma once

#include <array>
#include <cstddef>
#include <flat_map>
#include <optional>
#include <span>
#include <vector>

#include <d3d11.h>

#include <wrl/client.h>

#include <lucent/d3d11/renderer.hpp>
#include <lucent/draw/color.hpp>
#include <lucent/draw/frame_data.hpp>
#include <lucent/draw/glyph_run.hpp>
#include <lucent/draw/layer.hpp>

#include "build_attempts.hpp"
#include "image_slots.hpp"
#include "scratch_pool.hpp"

namespace lucent::d3d11 {

// An HRESULT as a result: a failure carries it as the system code.
auto checked(HRESULT code) -> result<void>;

// The light probe: a blurred backdrop drawn down to this many texels a side, as floats so an sRGB
// frame survives the trip, then read back through a ring of staging copies.
inline constexpr i32 light_probe_size = 4;
inline constexpr isize light_ring_size = 3;

struct shader_programs {
    Microsoft::WRL::ComPtr<ID3D11VertexShader> quad_vertex;
    Microsoft::WRL::ComPtr<ID3D11VertexShader> path_vertex;
    Microsoft::WRL::ComPtr<ID3D11VertexShader> pass_vertex;
    Microsoft::WRL::ComPtr<ID3D11PixelShader> main_pixel;
    Microsoft::WRL::ComPtr<ID3D11PixelShader> blur_pixel;
    Microsoft::WRL::ComPtr<ID3D11PixelShader> downsample_pixel;
    Microsoft::WRL::ComPtr<ID3D11PixelShader> composite_pixel;
    Microsoft::WRL::ComPtr<ID3D11InputLayout> quad_layout;
    Microsoft::WRL::ComPtr<ID3D11InputLayout> path_layout;
};

struct pipeline_states {
    // 0, 1, 2, ... draw_list::max_records: the quad shader's per-instance record index.
    Microsoft::WRL::ComPtr<ID3D11Buffer> record_indices;
    Microsoft::WRL::ComPtr<ID3D11Buffer> frame_buffer;
    Microsoft::WRL::ComPtr<ID3D11Buffer> mask_buffer;
    Microsoft::WRL::ComPtr<ID3D11Buffer> pass_buffer;
    Microsoft::WRL::ComPtr<ID3D11BlendState> premultiplied_blend;
    Microsoft::WRL::ComPtr<ID3D11BlendState> replace_blend;
    Microsoft::WRL::ComPtr<ID3D11RasterizerState> rasterizer;
    Microsoft::WRL::ComPtr<ID3D11DepthStencilState> no_depth;
    Microsoft::WRL::ComPtr<ID3D11SamplerState> linear_clamp;
};

struct device_textures {
    Microsoft::WRL::ComPtr<ID3D11Texture2D> atlas;
    Microsoft::WRL::ComPtr<ID3D11ShaderResourceView> atlas_view;
    Microsoft::WRL::ComPtr<ID3D11Texture2D> light_probe;
    Microsoft::WRL::ComPtr<ID3D11RenderTargetView> light_probe_target;
    std::array<Microsoft::WRL::ComPtr<ID3D11Texture2D>, light_ring_size> light_staging;
};

// What build() makes: everything the renderer needs that doesn't depend on a frame.
struct device_objects {
    shader_programs programs;
    pipeline_states states;
    device_textures textures;
};

auto build_device_objects(ID3D11Device* device) -> result<device_objects>;

// A buffer the frame's data is copied into, grown geometrically and mapped once a frame.
struct growing_buffer {
    Microsoft::WRL::ComPtr<ID3D11Buffer> buffer;
    // The record buffer's view; the path buffer has none.
    Microsoft::WRL::ComPtr<ID3D11ShaderResourceView> view;
    isize capacity = 0;
};

struct scratch_surface {
    Microsoft::WRL::ComPtr<ID3D11Texture2D> texture;
    Microsoft::WRL::ComPtr<ID3D11RenderTargetView> target;
    Microsoft::WRL::ComPtr<ID3D11ShaderResourceView> view;
};

// Coverage waiting for the next render, rows tightly packed.
struct atlas_patch {
    draw::atlas_page page{};
    draw::pixel_rect area;
    std::vector<std::byte> coverage;
};

// One staging copy of the light probe on its way back.
struct light_readback {
    std::optional<draw::light_key> key;
    // The probe held linear values (an _SRGB target's), to be encoded again.
    bool is_linear = false;
    i64 issued = 0;
};

struct sampled_light {
    draw::color light;
    i64 issued = 0;
};

// Everything a renderer owns. Free functions work on it; the renderer is its public face.
struct gpu_state {
    Microsoft::WRL::ComPtr<ID3D11Device> device;
    Microsoft::WRL::ComPtr<ID3D11DeviceContext> context;
    build_attempts attempts;
    std::optional<device_objects> objects;

    growing_buffer records;
    growing_buffer paths;
    image_slots images;
    // By slot; empty where no image lives.
    std::vector<Microsoft::WRL::ComPtr<ID3D11ShaderResourceView>> image_views;
    std::vector<atlas_patch> atlas_patches;
    scratch_pool pool;
    // In the pool's order.
    std::vector<scratch_surface> scratch;

    std::array<light_readback, light_ring_size> light_ring;
    isize light_cursor = 0;
    std::flat_map<draw::light_key, sampled_light> lights;
    i64 frame = 0;
};

// Draws a checked frame into the target, the caller's pipeline state already saved.
auto draw_frame(gpu_state& gpu, const draw::frame_data& frame, const render_target& target)
    -> result<void>;

// Takes whatever light readbacks have landed, never waiting on one that hasn't.
auto collect_light(gpu_state& gpu) -> void;

}
