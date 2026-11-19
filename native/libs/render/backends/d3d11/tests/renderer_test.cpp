#include <lucent/d3d11/renderer.hpp>

#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdlib>
#include <optional>
#include <ranges>
#include <span>
#include <thread>
#include <utility>

#include <d3d11.h>

#include <catch2/catch_test_macros.hpp>
#include <dxgiformat.h>
#include <wrl/client.h>

#include <lucent/d3d11/offscreen.hpp>
#include <lucent/draw/color.hpp>
#include <lucent/draw/draw_list.hpp>
#include <lucent/draw/frame_data.hpp>
#include <lucent/draw/layer.hpp>
#include <lucent/draw/paint.hpp>
#include <lucent/draw/rounded_rect.hpp>

namespace lucent::d3d11::testing {
namespace {

constexpr draw::pixel_size size{.width = 32, .height = 32};
constexpr draw::color backdrop{.r = 10, .g = 20, .b = 30, .a = 255};
constexpr draw::color ink{.r = 200, .g = 120, .b = 40, .a = 255};

auto spec_of(DXGI_FORMAT format) -> target_spec {
    return {
        .size = size,
        .format = static_cast<u32>(format),
        .view_format = static_cast<u32>(format),
        .sample_count = 1,
    };
}

// Blocks until the GPU has finished everything submitted so far, through an event query.
auto finish_gpu_work(const warp_device& device) -> void {
    const D3D11_QUERY_DESC described{.Query = D3D11_QUERY_EVENT, .MiscFlags = 0};
    Microsoft::WRL::ComPtr<ID3D11Query> fence;
    REQUIRE(SUCCEEDED(device.device()->CreateQuery(&described, &fence)));
    device.context()->End(fence.Get());
    BOOL is_done = FALSE;
    while (device.context()->GetData(fence.Get(), &is_done, sizeof(is_done), 0) != S_OK) {
        std::this_thread::yield();
    }
}

// A device, a cleared 32x32 target and a built renderer.
struct bench {
    warp_device device;
    test_target target;
    renderer drawer;
};

auto bench_on(DXGI_FORMAT format) -> result<bench> {
    warp_device device = LUCENT_TRY(warp_device::create());
    test_target target = LUCENT_TRY(test_target::create(device, spec_of(format)));
    target.clear(backdrop);
    renderer drawer = LUCENT_TRY(renderer::from_device(device.device(), device.context()));
    LUCENT_TRY(drawer.build());
    return bench{
        .device = std::move(device),
        .target = std::move(target),
        .drawer = std::move(drawer),
    };
}

auto filled_list() -> draw::draw_list {
    draw::draw_list list;
    list.reset({.size = size, .pixels_per_unit = 1});
    list.fill(
        draw::rounded_rect{
            .bounds = {.min = {.x = 0, .y = 0}, .max = {.x = 32, .y = 32}},
            .radii = draw::uniform(0),
        },
        draw::solid(ink)
    );
    return list;
}

auto is_filled_with(const image& pixels, draw::color fill) -> bool {
    const std::array expected{
        std::byte{fill.r},
        std::byte{fill.g},
        std::byte{fill.b},
        std::byte{fill.a},
    };
    return std::ranges::all_of(pixels.rgba | std::views::chunk(4), [&expected](const auto& texel) {
        return std::ranges::equal(texel, expected);
    });
}

// Within 2 per channel: the probe averages a blurred backdrop through float texels.
auto is_near(draw::color seen, draw::color expected) -> bool {
    const auto close = [](u8 left, u8 right) { return std::abs(i32{left} - i32{right}) <= 2; };
    return close(seen.r, expected.r)
           && close(seen.g, expected.g)
           && close(seen.b, expected.b)
           && seen.a == expected.a;
}

TEST_CASE("a frame that fails its check is refused whole and draws nothing") {
    result<bench> made = bench_on(DXGI_FORMAT_R8G8B8A8_UNORM);
    REQUIRE(made.has_value());
    const draw::draw_list list = filled_list();
    draw::frame_data frame = list.frame();
    const std::array<draw::command, 2> commands{frame.commands.front(), draw::layer_end{}};
    frame.commands = commands;

    const result<void> drawn = made->drawer.render(frame, made->target.as_render_target());

    CHECK(drawn.error_or(error{}).code == error_code::malformed);
    const result<image> pixels = read_back(made->device, made->target);
    REQUIRE(pixels.has_value());
    CHECK(is_filled_with(*pixels, backdrop));
}

TEST_CASE("an HDR target is refused as unsupported") {
    result<bench> made = bench_on(DXGI_FORMAT_R16G16B16A16_FLOAT);
    REQUIRE(made.has_value());
    const draw::draw_list list = filled_list();

    const result<void> drawn = made->drawer.render(list.frame(), made->target.as_render_target());

    CHECK(drawn.error_or(error{}).code == error_code::unsupported);
}

TEST_CASE("the caller's pipeline state is the same after a render as before it") {
    result<bench> made = bench_on(DXGI_FORMAT_R8G8B8A8_UNORM);
    REQUIRE(made.has_value());
    ID3D11DeviceContext* context = made->device.context();
    const D3D11_VIEWPORT viewport{
        .TopLeftX = 3,
        .TopLeftY = 4,
        .Width = 5,
        .Height = 6,
        .MinDepth = 0,
        .MaxDepth = 1,
    };
    context->RSSetViewports(1, &viewport);
    context->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_LINELIST);
    const draw::draw_list list = filled_list();

    const result<void> drawn = made->drawer.render(list.frame(), made->target.as_render_target());

    REQUIRE(drawn.has_value());
    UINT viewport_count = 1;
    D3D11_VIEWPORT after{};
    context->RSGetViewports(&viewport_count, &after);
    D3D11_PRIMITIVE_TOPOLOGY topology = D3D11_PRIMITIVE_TOPOLOGY_UNDEFINED;
    context->IAGetPrimitiveTopology(&topology);
    std::array<ID3D11RenderTargetView*, 1> targets{};
    context->OMGetRenderTargets(1, targets.data(), nullptr);
    Microsoft::WRL::ComPtr<ID3D11RenderTargetView> target;
    target.Attach(targets.front());
    CHECK(viewport_count == 1);
    CHECK(static_cast<i32>(after.TopLeftX) == 3);
    CHECK(static_cast<i32>(after.Width) == 5);
    CHECK(topology == D3D11_PRIMITIVE_TOPOLOGY_LINELIST);
    CHECK(target == nullptr);
    const result<image> pixels = read_back(made->device, made->target);
    REQUIRE(pixels.has_value());
    CHECK(is_filled_with(*pixels, ink));
}

TEST_CASE("a layer's sampled light is reported once a later frame finds its readback done") {
    result<bench> made = bench_on(DXGI_FORMAT_R8G8B8A8_UNORM);
    REQUIRE(made.has_value());
    draw::draw_list list = filled_list();
    constexpr draw::light_key key{3};
    list.push_layer({
        .bounds = {.min = {.x = 4, .y = 4}, .max = {.x = 28, .y = 28}},
        .radius = 0,
        .opacity = 1,
        .blur = 2,
        .rim = 0,
        .light = key,
    });
    list.pop_layer();

    std::optional<draw::color> light;
    // The readback never waits, so it lands a frame or more later. Each frame is finished on the
    // GPU before the next, so when it lands depends on the renderer, not on how busy WARP's
    // threads were: counting frames alone flaked under load.
    for (i32 frame = 0; frame < 8 && !light; ++frame) {
        REQUIRE(made->drawer.render(list.frame(), made->target.as_render_target()).has_value());
        finish_gpu_work(made->device);
        light = made->drawer.sampled_light(key);
    }

    REQUIRE(light.has_value());
    CHECK(is_near(light.value_or(draw::transparent), ink));
    CHECK(made->drawer.sampled_light(draw::light_key{4}) == std::nullopt);
}

}
}
