#pragma once

#include <chrono>
#include <memory>
#include <optional>
#include <span>

#include <lucent/draw/atlas_patch.hpp>
#include <lucent/draw/color.hpp>
#include <lucent/draw/frame_data.hpp>
#include <lucent/draw/glyph_run.hpp>
#include <lucent/draw/image_quad.hpp>
#include <lucent/draw/layer.hpp>

// Declared, not included: public headers carry no Windows headers. d3d11.h defines these COM
// interfaces without virtual destructors, which is right for them: they are released, never
// deleted. The check reports every redeclaration of them, these included, and their names are
// Windows'.
// NOLINTBEGIN(cppcoreguidelines-virtual-class-destructor,readability-identifier-naming): see above.
struct ID3D11Device;
struct ID3D11DeviceContext;
struct ID3D11RenderTargetView;
struct ID3D11Texture2D;
// NOLINTEND(cppcoreguidelines-virtual-class-destructor,readability-identifier-naming)

namespace lucent::d3d11 {

enum class renderer_state : u8 {
    // Made from a device; nothing built yet, or a build failed and may be tried again.
    idle,
    building,
    ready,
    // Three builds failed on this device; the overlay stays off until a new device.
    failed,
};

// scRGB's 1.0 is 80 nits. On an scRGB target the overlay's white is this many times that:
// BT.2408's 203-nit graphics white, so the overlay reads as paper beside the game's SDR UI rather
// than glaring at the display's peak.
inline constexpr f32 scrgb_paper_white = 203.0F / 80.0F;

// What render() draws into this frame. The glue makes the view from the back buffer each frame and
// releases it before Present returns, so no back buffer is held between frames. format is the
// view's DXGI_FORMAT (the texture may be typeless); it decides where blending happens: in the
// stored values for UNORM, in linear light for _SRGB, and in linear scRGB at scrgb_paper_white for
// R16G16B16A16_FLOAT. Other formats, HDR10's R10G10B10A2 among them, are refused as unsupported.
struct render_target {
    ID3D11RenderTargetView* view = nullptr;
    ID3D11Texture2D* texture = nullptr;
    draw::pixel_size size;
    u32 format = 0;
    u32 sample_count = 1;
};

// Pixels for an image: sRGB with straight alpha, four bytes a pixel (r, g, b, a), rows row_pitch
// bytes apart. Borrowed for the call only.
struct image_pixels {
    draw::pixel_size size;
    std::span<const std::byte> rgba;
    isize row_pitch = 0;
};

// What the renderer has done, for the dev build's frame stats.
struct renderer_stats {
    // In the last frame render() drew.
    isize draw_calls = 0;
    // Full-surface passes: blurs, downsamples, composites and light probes.
    isize passes = 0;
    // The latest timed frame's, once its timestamps have come back; absent while time_gpu() is
    // off or none has.
    std::optional<std::chrono::nanoseconds> gpu_time;
    // Since the renderer was made: image runs whose handle was stale, which drew no image.
    i64 stale_image_misses = 0;
};

// Draws frame data with Direct3D 11 into whatever target it is handed: it knows no hooks, so the
// same renderer runs in a game's swap chain and in a standalone window.
//
// Threads: build() on a kit worker (or the presenting thread when the device is single-threaded);
// everything else on the presenting thread.
class renderer final {
public:
    // Refuses a device below feature level 11_0. Holds a reference to both until destroyed.
    static auto from_device(ID3D11Device* device, ID3D11DeviceContext* context) -> result<renderer>;

    renderer(const renderer&) = delete ("it owns GPU resources of one device");
    auto operator=(const renderer&) -> renderer& = delete ("it owns GPU resources of one device");
    renderer(renderer&& other) noexcept;
    auto operator=(renderer&& other) noexcept -> renderer&;
    ~renderer();

    auto state() const -> renderer_state;
    // Whether build() may run on a worker: false for a device made single-threaded.
    auto is_multithreaded() const -> bool;

    // Creates every GPU resource the renderer needs up front. A failure leaves it idle to be tried
    // again; the third failure leaves it failed.
    auto build() -> result<void>;

    // Checks the frame (draw::check) and draws it, saving the pipeline state the caller had and
    // restoring it before returning. Ready only.
    auto render(const draw::frame_data& frame, const render_target& target) -> result<void>;

    // An image handle stays valid until destroy_image; a handle from another renderer, or a
    // destroyed one, never matches again and draws nothing.
    auto create_image(const image_pixels& pixels) -> result<draw::image_handle>;
    auto destroy_image(draw::image_handle image) -> void;

    // Copied now, uploaded at the next render.
    auto upload_atlas(std::span<const draw::atlas_patch> patches) -> void;

    // The latest averaged backdrop of the layer that asked for this key, once a readback for it has
    // completed; the readback never waits on the GPU.
    auto sampled_light(draw::light_key key) const -> std::optional<draw::color>;

    // Times every frame from now on through a ring of timestamp queries, read back without
    // waiting. Ready only. It costs queries every frame: dev builds turn it on.
    auto time_gpu() -> result<void>;
    auto stats() const -> renderer_stats;

private:
    struct resources;

    explicit renderer(std::unique_ptr<resources> owned);

    std::unique_ptr<resources> m_resources;
};

}
