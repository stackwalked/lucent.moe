#include <lucent/text/system_font.hpp>

#include <cstddef>
#include <expected>
#include <span>
#include <vector>

#include <Windows.h>

#include <dwrite.h>
#include <wrl/client.h>

#include <lucent/core/narrow.hpp>
#include <lucent/text/text_layout.hpp>
#include <lucent/text/text_system.hpp>

#include "direct_write.hpp"

namespace lucent::text {
namespace {

using Microsoft::WRL::ComPtr;

auto system_message_font() -> result<LOGFONTW> {
    NONCLIENTMETRICSW metrics{};
    metrics.cbSize = sizeof(metrics);
    if (SystemParametersInfoW(SPI_GETNONCLIENTMETRICS, sizeof(metrics), &metrics, 0) == FALSE) {
        return std::unexpected(last_system_error());
    }
    return metrics.lfMessageFont;
}

auto face_of(const LOGFONTW& described) -> result<ComPtr<IDWriteFontFace>> {
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
    ComPtr<IDWriteGdiInterop> interop;
    LUCENT_TRY(checked(factory->GetGdiInterop(&interop)));
    ComPtr<IDWriteFont> font;
    LUCENT_TRY(checked(interop->CreateFontFromLOGFONT(&described, &font)));
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

auto add_message_font(text_system& text) -> result<face_id> {
    const LOGFONTW described = LUCENT_TRY(system_message_font());
    const ComPtr<IDWriteFontFace> face = LUCENT_TRY(face_of(described));
    const std::vector<std::byte> bytes = LUCENT_TRY(file_bytes(*face.Get()));
    return text.add_face(bytes);
}

}
