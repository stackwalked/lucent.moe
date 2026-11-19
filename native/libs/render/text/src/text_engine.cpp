#include "text_engine.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <expected>
#include <flat_map>
#include <memory>
#include <optional>
#include <ranges>
#include <span>
#include <string>
#include <string_view>
#include <tuple>
#include <utility>
#include <vector>

#include <dwrite_3.h>
#include <wrl/client.h>

#include <lucent/core/narrow.hpp>
#include <lucent/core/text.hpp>
#include <lucent/text/glyph_atlas.hpp>
#include <lucent/text/text_layout.hpp>
#include <lucent/text/text_system.hpp>

#include "direct_write.hpp"
#include "latin_shaping.hpp"

namespace lucent::text {
namespace {

using Microsoft::WRL::ComPtr;

constexpr const wchar_t* english = L"en-us";

auto ordered(const layout_key_view& key) {
    return std::tie(
        key.utf8,
        key.face,
        key.size,
        key.max_width,
        key.wrap,
        key.overflow,
        key.max_lines,
        key.pixels_per_unit
    );
}

auto view_of(const layout_key& key) -> layout_key_view {
    return {
        .utf8 = key.utf8,
        .face = key.face,
        .size = key.size,
        .max_width = key.max_width,
        .wrap = key.wrap,
        .overflow = key.overflow,
        .max_lines = key.max_lines,
        .pixels_per_unit = key.pixels_per_unit,
    };
}

// A width that wraps and cuts nothing is left out of the key, so it can't split the cache.
auto key_of(const layout_request& request) -> layout_key_view {
    const bool uses_width =
        request.wrap == text_wrap::words || request.overflow == text_overflow::ellipsis;
    return {
        .utf8 = request.utf8,
        .face = request.style.face,
        .size = request.style.size,
        .max_width = uses_width ? request.max_width : 0.0F,
        .wrap = request.wrap,
        .overflow = request.overflow,
        .max_lines = request.max_lines,
        .pixels_per_unit = request.pixels_per_unit,
    };
}

auto owned(const layout_key_view& key) -> layout_key {
    return {
        .utf8 = std::string{key.utf8},
        .face = key.face,
        .size = key.size,
        .max_width = key.max_width,
        .wrap = key.wrap,
        .overflow = key.overflow,
        .max_lines = key.max_lines,
        .pixels_per_unit = key.pixels_per_unit,
    };
}

auto is_valid(const layout_request& request) -> bool {
    return std::isfinite(request.style.size)
           && request.style.size > 0.0F
           && std::isfinite(request.pixels_per_unit)
           && request.pixels_per_unit > 0.0F
           && std::isfinite(request.max_width)
           && request.max_width >= 0.0F
           && (!request.max_lines || *request.max_lines > 0);
}

// WOFF and WOFF2 unpacked to the OpenType they wrap; anything else is taken as OpenType already.
auto opentype_bytes(IDWriteFactory5& factory, std::span<const std::byte> bytes)
    -> result<std::vector<std::byte>> {
    const auto size = narrow<UINT32>(std::ssize(bytes));
    const DWRITE_CONTAINER_TYPE container = factory.AnalyzeContainerType(bytes.data(), size);
    if (container == DWRITE_CONTAINER_TYPE_UNKNOWN) {
        return std::vector<std::byte>{bytes.begin(), bytes.end()};
    }
    ComPtr<IDWriteFontFileStream> stream;
    LUCENT_TRY(checked(factory.UnpackFontFile(container, bytes.data(), size, &stream)));
    UINT64 unpacked_size = 0;
    LUCENT_TRY(checked(stream->GetFileSize(&unpacked_size)));
    const void* fragment = nullptr;
    void* fragment_context = nullptr;
    LUCENT_TRY(checked(stream->ReadFileFragment(&fragment, 0, unpacked_size, &fragment_context)));
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wunsafe-buffer-usage-in-container" // the stream's own size
    const std::span unpacked{static_cast<const std::byte*>(fragment), narrow<usize>(unpacked_size)};
#pragma clang diagnostic pop
    std::vector<std::byte> copied{unpacked.begin(), unpacked.end()};
    stream->ReleaseFileFragment(fragment_context);
    return copied;
}

auto english_or_first(IDWriteLocalizedStrings& names) -> result<std::wstring> {
    UINT32 index = 0;
    BOOL exists = FALSE;
    LUCENT_TRY(checked(names.FindLocaleName(english, &index, &exists)));
    if (exists == FALSE) {
        index = 0;
    }
    UINT32 length = 0;
    LUCENT_TRY(checked(names.GetStringLength(index, &length)));
    std::wstring name(narrow<usize>(length) + 1, L'\0');
    LUCENT_TRY(checked(names.GetString(index, name.data(), length + 1)));
    name.resize(narrow<usize>(length));
    return name;
}

auto name_of(IDWriteFontFace3& face) -> result<face_name> {
    ComPtr<IDWriteLocalizedStrings> families;
    LUCENT_TRY(checked(face.GetFamilyNames(&families)));
    return face_name{
        .family = LUCENT_TRY(english_or_first(*families.Get())),
        .weight = face.GetWeight(),
        .style = face.GetStyle(),
        .stretch = face.GetStretch(),
    };
}

}

auto layout_order::operator()(const layout_key& left, const layout_key& right) const -> bool {
    return ordered(view_of(left)) < ordered(view_of(right));
}

auto layout_order::operator()(const layout_key& left, const layout_key_view& right) const -> bool {
    return ordered(view_of(left)) < ordered(right);
}

auto layout_order::operator()(const layout_key_view& left, const layout_key& right) const -> bool {
    return ordered(left) < ordered(view_of(right));
}

auto text_engine::create(const text_options& options) -> result<std::unique_ptr<text_engine>> {
    LUCENT_INVARIANT(options.raster_budget >= 0 && options.layout_lifetime >= 0);
    ComPtr<IUnknown> unknown;
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wlanguage-extension-token" // COM names interfaces by __uuidof
    const IID& factory_interface = __uuidof(IDWriteFactory5);
#pragma clang diagnostic pop
    LUCENT_TRY(
        checked(DWriteCreateFactory(DWRITE_FACTORY_TYPE_ISOLATED, factory_interface, &unknown))
    );
    engine_parts parts;
    LUCENT_TRY(checked(unknown.As(&parts.factory)));
    LUCENT_TRY(checked(parts.factory->CreateInMemoryFontFileLoader(&parts.loader)));
    LUCENT_TRY(checked(parts.factory->RegisterFontFileLoader(parts.loader.Get())));
    LUCENT_TRY(checked(parts.factory->GetSystemFontFallback(&parts.system_fallback)));
    ComPtr<IDWriteTextAnalyzer> analyzer;
    LUCENT_TRY(checked(parts.factory->CreateTextAnalyzer(&analyzer)));
    LUCENT_TRY(checked(analyzer.As(&parts.analyzer)));
    parts.latin = LUCENT_TRY(latin_script(*parts.analyzer.Get()));
    return std::make_unique<text_engine>(options, std::move(parts));
}

text_engine::text_engine(const text_options& options, engine_parts parts)
    : m_options{options}
    , m_factory{std::move(parts.factory)}
    , m_loader{std::move(parts.loader)}
    , m_system_fallback{std::move(parts.system_fallback)}
    , m_analyzer{std::move(parts.analyzer)}
    , m_latin{parts.latin}
    , m_atlas{options.atlas} {}

auto text_engine::add_face(std::span<const std::byte> bytes) -> result<face_id> {
    const std::vector<std::byte> opentype = LUCENT_TRY(opentype_bytes(*m_factory.Get(), bytes));
    ComPtr<IDWriteFontFile> file;
    // With no owner the loader keeps a copy of its own.
    LUCENT_TRY(checked(m_loader->CreateInMemoryFontFileReference(
        m_factory.Get(), opentype.data(), narrow<UINT32>(std::ssize(opentype)), nullptr, &file
    )));
    BOOL is_supported = FALSE;
    DWRITE_FONT_FILE_TYPE file_type{};
    DWRITE_FONT_FACE_TYPE face_type{};
    UINT32 face_count = 0;
    LUCENT_TRY(checked(file->Analyze(&is_supported, &file_type, &face_type, &face_count)));
    if (is_supported == FALSE || face_count == 0) {
        return std::unexpected(error{.code = error_code::malformed, .system_code = 0});
    }
    const std::array<IDWriteFontFile*, 1> files{file.Get()};
    ComPtr<IDWriteFontFace> created;
    LUCENT_TRY(checked(m_factory->CreateFontFace(
        face_type, 1, files.data(), 0, DWRITE_FONT_SIMULATIONS_NONE, &created
    )));
    ComPtr<IDWriteFontFace3> found;
    LUCENT_TRY(checked(created.As(&found)));
    face_name name = LUCENT_TRY(name_of(*found.Get()));
    m_files.push_back(file);
    LUCENT_TRY(rebuild_collection());
    ComPtr<IDWriteFontFace3> resolved = LUCENT_TRY(resolved_face(name));
    const face_id id = register_face(std::move(resolved), std::move(name));
    LUCENT_TRY(rebuild_fallback());
    return id;
}

auto text_engine::set_fallback(std::span<const face_id> chain) -> result<void> {
    LUCENT_INVARIANT(std::ranges::all_of(chain, [this](face_id id) { return is_ours(id); }));
    m_chain.assign_range(chain);
    return rebuild_fallback();
}

auto text_engine::is_ours(face_id face) const -> bool {
    const auto index = isize{std::to_underlying(face)};
    return index < std::ssize(m_faces) && m_faces.at(narrow<usize>(index)).name.has_value();
}

auto text_engine::begin_frame() -> void {
    ++m_frame;
    m_rasterized = 0;
    m_atlas.begin_frame();
    const i64 oldest = m_frame - m_options.layout_lifetime;
    std::erase_if(m_layouts, [oldest](const auto& cached) {
        return cached.second.last_used < oldest;
    });
}

auto text_engine::layout(const layout_request& request) -> result<const text_layout*> {
    LUCENT_INVARIANT(is_valid(request) && is_ours(request.style.face));
    const layout_key_view key = key_of(request);
    if (const auto found = m_layouts.find(key); found != m_layouts.end()) {
        found->second.last_used = m_frame;
        return found->second.laid_out.get();
    }
    const std::wstring wide = to_wide(request.utf8);
    std::optional<text_layout> made = LUCENT_TRY(fast_layout(request, wide));
    if (!made) {
        made = LUCENT_TRY(shaped_layout(request, wide));
    }
    const auto [placed, _] = m_layouts.emplace(
        owned(key),
        cached_layout{
            .laid_out = std::make_unique<text_layout>(*std::move(made)),
            .last_used = m_frame,
        }
    );
    return placed->second.laid_out.get();
}

auto text_engine::layout_by(const layout_request& request, layout_path path)
    -> result<std::optional<text_layout>> {
    LUCENT_INVARIANT(is_valid(request) && is_ours(request.style.face));
    const std::wstring wide = to_wide(request.utf8);
    switch (path) {
    case layout_path::fast:
        return fast_layout(request, wide);
    case layout_path::shaped:
        return LUCENT_TRY(shaped_layout(request, wide));
    }
    LUCENT_UNREACHABLE();
}

auto text_engine::atlas() -> glyph_atlas& {
    return m_atlas;
}

auto text_engine::atlas() const -> const glyph_atlas& {
    return m_atlas;
}

auto text_engine::face(face_id id) -> known_face& {
    return m_faces.at(std::to_underlying(id));
}

// DirectWrite hands back the face object it holds, which needn't be the one we made: faces are
// matched by what they are, and one never seen (a system face fallback chose) is registered.
auto text_engine::face_of(IDWriteFontFace* found) -> result<face_id> {
    for (const auto [index, known] : std::views::enumerate(m_faces)) {
        if (static_cast<IDWriteFontFace*>(known.face.Get()) == found) {
            return face_id{narrow<u16>(index)};
        }
    }
    ComPtr<IDWriteFontFace3> newer;
    LUCENT_TRY(checked(found->QueryInterface(newer.GetAddressOf())));
    ComPtr<IDWriteFontFaceReference> newer_reference;
    LUCENT_TRY(checked(newer->GetFontFaceReference(&newer_reference)));
    for (const auto [index, known] : std::views::enumerate(m_faces)) {
        ComPtr<IDWriteFontFaceReference> known_reference;
        LUCENT_TRY(checked(known.face->GetFontFaceReference(&known_reference)));
        if (known_reference->Equals(newer_reference.Get()) != FALSE) {
            return face_id{narrow<u16>(index)};
        }
    }
    return register_face(std::move(newer), std::nullopt);
}

auto text_engine::register_face(ComPtr<IDWriteFontFace3> found, std::optional<face_name> name)
    -> face_id {
    DWRITE_FONT_METRICS metrics{};
    found->GetMetrics(&metrics);
    const UINT16 glyph_count = found->GetGlyphCount();
    const bool is_color = found->IsColorFont() != FALSE;
    m_faces.push_back({
        .face = std::move(found),
        .name = std::move(name),
        .metrics =
            {
                .units_per_em = static_cast<f32>(metrics.designUnitsPerEm),
                .ascent = static_cast<f32>(metrics.ascent),
                .descent = static_cast<f32>(metrics.descent),
                .line_gap = static_cast<f32>(metrics.lineGap),
            },
        .is_color = is_color,
        .advances = std::vector<std::optional<i32>>(glyph_count),
        .substitutable = std::vector<std::optional<bool>>(glyph_count),
        .kerning = {},
    });
    return face_id{narrow<u16>(std::ssize(m_faces) - 1)};
}

auto text_engine::rebuild_collection() -> result<void> {
    ComPtr<IDWriteFontSetBuilder1> builder;
    LUCENT_TRY(checked(m_factory->CreateFontSetBuilder(&builder)));
    for (const ComPtr<IDWriteFontFile>& file : m_files) {
        LUCENT_TRY(checked(builder->AddFontFile(file.Get())));
    }
    ComPtr<IDWriteFontSet> fonts;
    LUCENT_TRY(checked(builder->CreateFontSet(&fonts)));
    LUCENT_TRY(checked(m_factory->CreateFontCollectionFromFontSet(fonts.Get(), &m_collection)));
    for (known_face& known : m_faces) {
        if (known.name) {
            known.face = LUCENT_TRY(resolved_face(*known.name));
        }
    }
    m_formats.clear();
    m_layouts.clear();
    return {};
}

// Our chain first, every one of its faces offered for every code point, then the system's.
auto text_engine::rebuild_fallback() -> result<void> {
    ComPtr<IDWriteFontFallbackBuilder> builder;
    LUCENT_TRY(checked(m_factory->CreateFontFallbackBuilder(&builder)));
    const DWRITE_UNICODE_RANGE everything{.first = 0, .last = 0x10'ffff};
    for (const face_id id : m_chain) {
        const std::optional<face_name>& name = face(id).name;
        LUCENT_INVARIANT(name.has_value());
        const wchar_t* family = name->family.c_str();
        LUCENT_TRY(checked(builder->AddMapping(
            &everything, 1, &family, 1, m_collection.Get(), nullptr, nullptr, 1.0F
        )));
    }
    LUCENT_TRY(checked(builder->AddMappings(m_system_fallback.Get())));
    LUCENT_TRY(checked(builder->CreateFontFallback(&m_fallback)));
    m_formats.clear();
    m_layouts.clear();
    return {};
}

auto text_engine::format_for(face_id id, f32 em_size, line_spacing spacing)
    -> result<IDWriteTextFormat1*> {
    const format_key key{.face = id, .em_size = em_size};
    if (const auto found = m_formats.find(key); found != m_formats.end()) {
        return found->second.Get();
    }
    const std::optional<face_name>& named = face(id).name;
    LUCENT_INVARIANT(named.has_value());
    const face_name& name = *named;
    ComPtr<IDWriteTextFormat> made;
    LUCENT_TRY(checked(m_factory->CreateTextFormat(
        name.family.c_str(),
        m_collection.Get(),
        name.weight,
        name.style,
        name.stretch,
        em_size,
        english,
        &made
    )));
    ComPtr<IDWriteTextFormat1> format;
    LUCENT_TRY(checked(made.As(&format)));
    LUCENT_TRY(checked(format->SetFontFallback(m_fallback.Get())));
    LUCENT_TRY(checked(
        format->SetLineSpacing(DWRITE_LINE_SPACING_METHOD_UNIFORM, spacing.height, spacing.baseline)
    ));
    const auto [placed, _] = m_formats.emplace(key, std::move(format));
    return placed->second.Get();
}

// Whole pixels, so every baseline lands on one and vertical hinting holds.
auto text_engine::spacing_of(face_id id, f32 em_size) -> line_spacing {
    const face_metrics& metrics = face(id).metrics;
    const f32 scale = em_size / metrics.units_per_em;
    return {
        .height = std::round((metrics.ascent + metrics.descent + metrics.line_gap) * scale),
        .baseline = std::round(metrics.ascent * scale),
    };
}

auto text_engine::design_advances(face_id id, std::span<const u16> glyphs)
    -> result<std::vector<i32>> {
    known_face& known = face(id);
    std::vector<u16> missing;
    for (const u16 glyph : glyphs) {
        if (!known.advances.at(glyph)) {
            missing.push_back(glyph);
        }
    }
    if (!missing.empty()) {
        std::vector<i32> found(missing.size());
        LUCENT_TRY(checked(known.face->GetDesignGlyphAdvances(
            narrow<UINT32>(std::ssize(missing)), missing.data(), found.data(), FALSE
        )));
        for (const auto [glyph, advance] : std::views::zip(missing, found)) {
            known.advances.at(glyph) = advance;
        }
    }
    std::vector<i32> advances;
    advances.reserve(glyphs.size());
    for (const u16 glyph : glyphs) {
        const std::optional<i32>& advance = known.advances.at(glyph);
        LUCENT_INVARIANT(advance.has_value());
        advances.push_back(*advance);
    }
    return advances;
}

auto text_engine::is_substitutable(face_id id, u16 glyph) -> result<bool> {
    known_face& known = face(id);
    std::optional<bool>& cached = known.substitutable.at(glyph);
    if (!cached) {
        cached = LUCENT_TRY(
            text::is_substitutable(*m_analyzer.Get(), *known.face.Get(), m_latin, glyph)
        );
    }
    return *cached;
}

auto text_engine::kerning_of(
    face_id id, std::wstring_view text, std::span<const u16> glyphs, std::span<const i32> advances
) -> result<std::optional<i32>> {
    known_face& known = face(id);
    const u64 key = (u64{glyphs.size()} << 32U) | (u64{glyphs.front()} << 16U) | u64{glyphs.back()};
    if (const auto found = known.kerning.find(key); found != known.kerning.end()) {
        return found->second;
    }
    const std::optional<i32> kerning = LUCENT_TRY(pair_kerning(
        *m_analyzer.Get(),
        *known.face.Get(),
        m_latin,
        {.text = text, .glyphs = glyphs, .advances = advances}
    ));
    known.kerning.emplace(key, kerning);
    return kerning;
}

// The face a text format resolves the name to in our collection: the one IDWriteTextLayout draws
// with, so the fast path measures what the shaped path would.
auto text_engine::resolved_face(const face_name& name) -> result<ComPtr<IDWriteFontFace3>> {
    UINT32 index = 0;
    BOOL exists = FALSE;
    LUCENT_TRY(checked(m_collection->FindFamilyName(name.family.c_str(), &index, &exists)));
    if (exists == FALSE) {
        return std::unexpected(error{.code = error_code::not_found, .system_code = 0});
    }
    ComPtr<IDWriteFontFamily1> family;
    LUCENT_TRY(checked(m_collection->GetFontFamily(index, &family)));
    ComPtr<IDWriteFont> font;
    LUCENT_TRY(checked(family->GetFirstMatchingFont(name.weight, name.stretch, name.style, &font)));
    ComPtr<IDWriteFontFace> made;
    LUCENT_TRY(checked(font->CreateFontFace(&made)));
    ComPtr<IDWriteFontFace3> resolved;
    LUCENT_TRY(checked(made.As(&resolved)));
    return resolved;
}

}
