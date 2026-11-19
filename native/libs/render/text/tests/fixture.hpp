#pragma once

#include <cstddef>
#include <memory>
#include <string_view>
#include <vector>

#include <lucent/os/file.hpp>
#include <lucent/text/text_layout.hpp>
#include <lucent/text/text_system.hpp>

#include "../src/text_engine.hpp"

namespace lucent::text::testing {

// The fixture fonts' bytes; a missing fixture is a broken checkout, not a test outcome.
inline auto fixture_bytes(std::string_view name) -> std::vector<std::byte> {
    result<std::vector<std::byte>> bytes =
        os::read_file(std::string{LUCENT_TEXT_FIXTURES_DIR} + "/" + std::string{name});
    LUCENT_INVARIANT(bytes.has_value());
    return *std::move(bytes);
}

// An engine with IBM Plex Sans (Latin subset) as its one face of ours.
struct fixture_engine {
    std::unique_ptr<text_engine> engine;
    face_id plex{};
};

inline auto plex_engine(const text_options& options) -> fixture_engine {
    result<std::unique_ptr<text_engine>> made = text_engine::create(options);
    LUCENT_INVARIANT(made.has_value());
    fixture_engine fixture{.engine = *std::move(made), .plex = {}};
    const result<face_id> plex = fixture.engine->add_face(fixture_bytes("ibm-plex-sans-400.woff2"));
    LUCENT_INVARIANT(plex.has_value());
    fixture.plex = *plex;
    return fixture;
}

inline auto plex_engine() -> fixture_engine {
    return plex_engine({.raster_budget = 64, .layout_lifetime = 4, .atlas = atlas_limits{}});
}

}
