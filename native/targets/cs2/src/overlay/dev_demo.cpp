#include "dev_demo.hpp"

#include <cstddef>
#include <expected>
#include <optional>
#include <span>
#include <string_view>
#include <vector>

#include <Windows.h>

#include <dwrite.h>
#include <wrl/client.h>

#include <lucent/core/narrow.hpp>
#include <lucent/draw/circle.hpp>
#include <lucent/draw/color.hpp>
#include <lucent/draw/draw_list.hpp>
#include <lucent/draw/paint.hpp>
#include <lucent/draw/rect.hpp>
#include <lucent/draw/rounded_rect.hpp>
#include <lucent/draw/stroke_style.hpp>
#include <lucent/draw/vec2.hpp>
#include <lucent/text/text_layout.hpp>
#include <lucent/text/text_system.hpp>

#include "hresult.hpp"

namespace lucent::cs2::overlay {
namespace {

using Microsoft::WRL::ComPtr;

// Latin and Greek on the fast path's face, Arabic joined and laid right to left, Japanese from a
// face the system's fallback finds: shaping, bidi, fallback and the atlas, in one line.
constexpr std::string_view demo_line = "lucent overlay — Ελληνι"
                                       "κά, العربية, "
                                       "日本語";

constexpr draw::vec2 plate_origin{.x = 24.0F, .y = 24.0F};
constexpr f32 plate_padding = 12.0F;
constexpr f32 text_size = 20.0F;
constexpr draw::color plate_color{.r = 16, .g = 18, .b = 24, .a = 200};
constexpr draw::color edge_color{.r = 255, .g = 255, .b = 255, .a = 40};
constexpr draw::color accent{.r = 255, .g = 0, .b = 153, .a = 255};

// The regular face of a family the system has installed.
auto system_face(const wchar_t* family_name) -> result<ComPtr<IDWriteFontFace>> {
    ComPtr<IUnknown> unknown;
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wlanguage-extension-token" // COM names interfaces by __uuidof
    const IID& factory_interface = __uuidof(IDWriteFactory);
#pragma clang diagnostic pop
    LUCENT_TRY(
        checked(DWriteCreateFactory(DWRITE_FACTORY_TYPE_ISOLATED, factory_interface, &unknown))
    );
    ComPtr<IDWriteFactory> factory;
    LUCENT_TRY(checked(unknown.As(&factory)));
    ComPtr<IDWriteFontCollection> installed;
    LUCENT_TRY(checked(factory->GetSystemFontCollection(&installed, FALSE)));
    UINT32 index = 0;
    BOOL exists = FALSE;
    LUCENT_TRY(checked(installed->FindFamilyName(family_name, &index, &exists)));
    if (exists == FALSE) {
        return std::unexpected(error{.code = error_code::not_found});
    }
    ComPtr<IDWriteFontFamily> family;
    LUCENT_TRY(checked(installed->GetFontFamily(index, &family)));
    ComPtr<IDWriteFont> font;
    LUCENT_TRY(checked(family->GetFirstMatchingFont(
        DWRITE_FONT_WEIGHT_NORMAL, DWRITE_FONT_STRETCH_NORMAL, DWRITE_FONT_STYLE_NORMAL, &font
    )));
    ComPtr<IDWriteFontFace> face;
    LUCENT_TRY(checked(font->CreateFontFace(&face)));
    return face;
}

// The bytes of a face's file, read through DirectWrite's own loader for it rather than from a path.
auto file_bytes(IDWriteFontFace& face) -> result<std::vector<std::byte>> {
    UINT32 file_count = 1;
    ComPtr<IDWriteFontFile> file;
    LUCENT_TRY(checked(face.GetFiles(&file_count, &file)));
    const void* key = nullptr;
    UINT32 key_size = 0;
    LUCENT_TRY(checked(file->GetReferenceKey(&key, &key_size)));
    ComPtr<IDWriteFontFileLoader> loader;
    LUCENT_TRY(checked(file->GetLoader(&loader)));
    ComPtr<IDWriteFontFileStream> stream;
    LUCENT_TRY(checked(loader->CreateStreamFromKey(key, key_size, &stream)));
    UINT64 size = 0;
    LUCENT_TRY(checked(stream->GetFileSize(&size)));
    const void* fragment = nullptr;
    void* fragment_context = nullptr;
    LUCENT_TRY(checked(stream->ReadFileFragment(&fragment, 0, size, &fragment_context)));
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wunsafe-buffer-usage-in-container" // the stream's own size
    const std::span bytes{static_cast<const std::byte*>(fragment), narrow<usize>(size)};
#pragma clang diagnostic pop
    std::vector<std::byte> copied{bytes.begin(), bytes.end()};
    stream->ReleaseFileFragment(fragment_context);
    return copied;
}

}

auto dev_demo::create(text::text_system& text) -> result<dev_demo> {
    const ComPtr<IDWriteFontFace> face = LUCENT_TRY(system_face(L"Segoe UI"));
    const std::vector<std::byte> bytes = LUCENT_TRY(file_bytes(*face.Get()));
    return dev_demo{LUCENT_TRY(text.add_face(bytes))};
}

dev_demo::dev_demo(text::face_id face)
    : m_face{face} {}

auto dev_demo::draw(text::text_system& text, draw::draw_list& list) const -> result<void> {
    const text::text_layout* const line = LUCENT_TRY(text.layout({
        .utf8 = demo_line,
        .style = {.face = m_face, .size = text_size},
        .max_width = 0.0F,
        .wrap = text::text_wrap::none,
        .overflow = text::text_overflow::visible,
        .max_lines = std::nullopt,
        .pixels_per_unit = 1.0F,
    }));
    const draw::vec2 text_origin =
        plate_origin + draw::vec2{.x = plate_padding, .y = plate_padding};
    const draw::rounded_rect plate{
        .bounds =
            {
                .min = plate_origin,
                .max =
                    text_origin + line->size + draw::vec2{.x = plate_padding, .y = plate_padding},
            },
        .radii = draw::uniform(8.0F),
    };
    list.fill(plate, draw::solid(plate_color));
    list.stroke(plate, draw::solid(edge_color), draw::stroke_style{});
    const f32 middle = (plate.bounds.min.y + plate.bounds.max.y) / 2.0F;
    const draw::circle dot{
        .centre = {.x = plate.bounds.max.x + 20.0F, .y = middle},
        .radius = 8.0F,
    };
    list.fill(dot, draw::solid(accent));
    return text.draw(list, *line, text_origin, draw::white);
}

}
