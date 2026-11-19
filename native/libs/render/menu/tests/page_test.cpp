#include <lucent/menu/page.hpp>

#include <array>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include <catch2/catch_test_macros.hpp>

#include <lucent/draw/rect.hpp>
#include <lucent/draw/vec2.hpp>
#include <lucent/kit/clock.hpp>
#include <lucent/kit/context.hpp>
#include <lucent/kit/feature.hpp>
#include <lucent/kit/published.hpp>
#include <lucent/kit/registry.hpp>
#include <lucent/kit/settings.hpp>
#include <lucent/kit/wiring.hpp>
#include <lucent/menu/catalog.hpp>
#include <lucent/menu/table_catalog.hpp>
#include <lucent/menu/text_key.hpp>
#include <lucent/ui/box_style.hpp>
#include <lucent/ui/context.hpp>
#include <lucent/ui/element_id.hpp>
#include <lucent/ui/input_snapshot.hpp>

#include "fixture.hpp"

// The page is generated, so nobody looks at each row of it: a setting kind that lost its control,
// a row that switches a feature it shouldn't, or an edit that bypasses the registry would all go
// unnoticed until someone in a game tried it.

namespace lucent::menu {
namespace {

enum class marker : u8 { dot, ring };

struct box_settings {
    bool is_outlined = false;
    f32 thickness = 2.0F;
    marker shape = marker::dot;
    kit::color tint{.r = 200, .g = 40, .b = 40, .a = 255};

    static constexpr auto describe() -> std::array<kit::setting<box_settings>, 4> {
        return {
            kit::toggle<"box/outline", &box_settings::is_outlined>(),
            kit::number<"box/thickness", &box_settings::thickness>(
                {.min = 1.0F, .max = 5.0F, .step = 1.0F}
            ),
            kit::choice<"box/marker", &box_settings::shape, "dot", "ring">(),
            kit::color_of<"box/tint", &box_settings::tint>(),
        };
    }
};

class box_feature {
public:
    static constexpr kit::feature_id id = kit::feature_id_of<"box">;
    static constexpr kit::feature_tag tag{"visuals"};
    using needs = kit::needs<>;
    using wants = kit::wants<>;
    using settings = box_settings;

    auto tick(const kit::context<box_feature>& /*parts*/) -> void {}
};

constexpr kit::feature_id box = box_feature::id;
constexpr kit::feature_id radar = kit::feature_key("radar");
constexpr kit::feature_id aimbot = kit::feature_key("aimbot");
constexpr kit::feature_id chams = kit::feature_key("chams");
constexpr kit::setting_id outline = kit::setting_key("box/outline");
constexpr kit::setting_id thickness = kit::setting_key("box/thickness");
constexpr kit::setting_id shape = kit::setting_key("box/marker");
constexpr kit::setting_id tint = kit::setting_key("box/tint");

constexpr ui::element_id page = ui::child_id(ui::root_id(ui::key<"menu">()), ui::key<"page">());

constexpr auto control_of(kit::setting_id setting) -> ui::element_id {
    return setting_control_id(page, {.feature = box, .setting = setting});
}

auto initial_values() -> std::vector<kit::setting_value> {
    std::vector<kit::setting_value> values;
    values.reserve(kit::descriptions_of<box_settings>.size());
    for (const kit::setting_description& setting : kit::descriptions_of<box_settings>) {
        values.push_back(setting.initial);
    }
    return values;
}

auto snapshot_with(kit::feature_state box_state) -> kit::registry_snapshot {
    return {
        .revision = 1,
        .features = {
            {
                .id = box,
                .state = box_state,
                .descriptions = kit::descriptions_of<box_settings>,
                .settings = initial_values(),
            },
            {
                .id = radar,
                .state = kit::feature_state::unavailable,
                .descriptions = {},
                .settings = {},
            },
            {
                .id = aimbot,
                .state = kit::feature_state::unentitled,
                .descriptions = {},
                .settings = {},
            },
            {.id = chams, .state = kit::feature_state::failed, .descriptions = {}, .settings = {}},
        },
    };
}

// The dev names, as a dev build would fill the catalog from them.
auto add_english(table_catalog& text) -> void {
    text.add(feature_text{box}, "Box ESP");
    text.add(feature_text{radar}, "Radar");
    text.add(feature_text{aimbot}, "Aimbot");
    text.add(feature_text{chams}, "Chams");
    text.add(setting_text{.feature = box, .setting = outline}, "Outline");
    text.add(setting_text{.feature = box, .setting = thickness}, "Thickness");
    text.add(setting_text{.feature = box, .setting = shape}, "Marker");
    text.add(setting_text{.feature = box, .setting = tint}, "Tint");
    text.add(
        option_text{.feature = box, .setting = shape, .option = kit::setting_key("dot")}, "Dot"
    );
    text.add(
        option_text{.feature = box, .setting = shape, .option = kit::setting_key("ring")}, "Ring"
    );
    text.add(phrase_text{phrases::search}, "Search");
    text.add(phrase_text{phrases::unavailable}, "Unavailable");
    text.add(phrase_text{phrases::unentitled}, "Not in your plan");
    text.add(phrase_text{phrases::failed}, "Failed");
    text.add(phrase_text{phrases::reset}, "Reset");
}

// The page in a window, frame by frame, keeping the query between frames as the glue would.
class menu_run final {
public:
    menu_run(ui::testing::fixture_text& fixture, const catalog& words, kit::registry_snapshot shown)
        : m_run{
              fixture.text,
              ui::testing::test_theme(fixture.plex, ui::testing::motion_preference::full),
          }
        , m_words{&words}
        , m_shown{std::move(shown)} {}

    auto frame() -> ui::context& {
        return m_run.ui();
    }

    auto query() const -> const std::string& {
        return m_query;
    }

    // Shows a newer snapshot from the next frame on.
    auto show(kit::registry_snapshot shown) -> void {
        m_shown = std::move(shown);
    }

    auto step(ui::input_snapshot input) -> void {
        page_outcome outcome;
        ui::context& declared = m_run.ui();
        m_run.step(std::move(input), [&] {
            declared.window(
                {
                    .key = ui::key<"menu">(),
                    .position = {.x = 0.0F, .y = 0.0F},
                    .style =
                        {
                            .flow = ui::direction::column,
                            .width = ui::fixed(400.0F),
                            .height = ui::fit(),
                            .gap = 0.0F,
                            .main = ui::main_align::start,
                            .cross = ui::cross_align::stretch,
                        },
                },
                [&] {
                    outcome = settings_page(
                        declared,
                        ui::key<"page">(),
                        {
                            .snapshot = &m_shown,
                            .text = m_words,
                            .query = m_query,
                        }
                    );
                }
            );
        });
        m_query = std::move(outcome.query);
        m_changes = std::move(outcome.changes);
    }

    auto idle() -> void {
        step({});
    }

    // A press and a release at where.
    auto click_at(draw::vec2 where) -> void {
        step(ui::testing::press(where));
        REQUIRE(m_changes.empty());
        step(ui::testing::release(where));
    }

    auto click(ui::element_id id) -> void {
        click_at(ui::testing::centre(ui::testing::rect_of(frame(), id)));
    }

    // Just inside the element's left edge, clear of anything at its end.
    auto click_start(ui::element_id id) -> void {
        const draw::rect area = ui::testing::rect_of(frame(), id);
        click_at({.x = area.min.x + 2.0F, .y = ui::testing::centre(area).y});
    }

    // A press at the end of a slider's track.
    auto press_track_end(ui::element_id slider) -> void {
        const draw::rect track =
            ui::testing::rect_of(frame(), ui::child_id(slider, ui::key<"track">()));
        step(ui::testing::press({.x = track.max.x - 1.0F, .y = ui::testing::centre(track).y}));
    }

    // What the last frame's input asked of the registry.
    auto changes() const -> const std::vector<kit::registry_change>& {
        return m_changes;
    }

private:
    ui::testing::driver m_run;
    const catalog* m_words;
    kit::registry_snapshot m_shown;
    std::string m_query;
    std::vector<kit::registry_change> m_changes;
};

auto is_shown(const ui::context& frame, ui::element_id id) -> bool {
    return frame.rect(id).has_value();
}

auto typed(std::string text) -> ui::input_snapshot {
    ui::input_snapshot input;
    input.text = std::move(text);
    return input;
}

auto changed(kit::setting_id setting, kit::setting_value value)
    -> std::vector<kit::registry_change> {
    return {kit::change_setting{.feature = box, .setting = setting, .value = value}};
}

TEST_CASE("a toggle setting is a switch row whose click sends the flipped value") {
    ui::testing::fixture_text fixture = ui::testing::plex_text();
    table_catalog words;
    add_english(words);
    menu_run run{fixture, words, snapshot_with(kit::feature_state::off)};
    run.idle();

    run.click(control_of(outline));
    CHECK(run.changes() == changed(outline, kit::setting_value{true}));
}

TEST_CASE("a number setting is a slider over its range, stepped") {
    ui::testing::fixture_text fixture = ui::testing::plex_text();
    table_catalog words;
    add_english(words);
    menu_run run{fixture, words, snapshot_with(kit::feature_state::off)};
    run.idle();

    run.press_track_end(control_of(thickness));
    CHECK(run.changes() == changed(thickness, kit::setting_value{5.0F}));
}

TEST_CASE("a choice setting is a dropdown of its options' catalog text, sending the index") {
    ui::testing::fixture_text fixture = ui::testing::plex_text();
    table_catalog words;
    add_english(words);
    menu_run run{fixture, words, snapshot_with(kit::feature_state::off)};
    run.idle();

    run.click(control_of(shape));
    REQUIRE(run.frame().is_popup_open(control_of(shape)));
    run.click(ui::child_id(ui::popup_id(control_of(shape)), ui::key_from_index(1)));
    CHECK(run.changes() == changed(shape, kit::setting_value{isize{1}}));
}

TEST_CASE("a colour setting is a swatch whose popup sets each channel") {
    ui::testing::fixture_text fixture = ui::testing::plex_text();
    table_catalog words;
    add_english(words);
    menu_run run{fixture, words, snapshot_with(kit::feature_state::off)};
    run.idle();

    run.click(control_of(tint));
    REQUIRE(run.frame().is_popup_open(control_of(tint)));
    run.idle();
    run.press_track_end(ui::child_id(ui::popup_id(control_of(tint)), ui::key<"green">()));
    CHECK(
        run.changes()
        == changed(tint, kit::setting_value{kit::color{.r = 200, .g = 255, .b = 40, .a = 255}})
    );
}

TEST_CASE("a feature's switch requests enabling it when off and disabling it when on") {
    ui::testing::fixture_text fixture = ui::testing::plex_text();
    table_catalog words;
    add_english(words);
    menu_run run{fixture, words, snapshot_with(kit::feature_state::off)};
    run.idle();

    run.click(feature_switch_id(page, box));
    CHECK(run.changes() == std::vector<kit::registry_change>{kit::enable_feature{.feature = box}});
    run.show(snapshot_with(kit::feature_state::on));
    run.idle();
    run.click(feature_switch_id(page, box));
    CHECK(run.changes() == std::vector<kit::registry_change>{kit::disable_feature{.feature = box}});
}

TEST_CASE("unavailable and unentitled features show their state with no switch to click") {
    ui::testing::fixture_text fixture = ui::testing::plex_text();
    table_catalog words;
    add_english(words);
    menu_run run{fixture, words, snapshot_with(kit::feature_state::off)};
    run.idle();

    for (const kit::feature_id locked : {radar, aimbot}) {
        CHECK_FALSE(is_shown(run.frame(), feature_switch_id(page, locked)));
        CHECK_FALSE(is_shown(run.frame(), reset_button_id(page, locked)));
        run.click_start(feature_status_id(page, locked));
        CHECK(run.changes().empty());
    }
}

TEST_CASE("a failed feature can't be switched, and its reset requests the reset") {
    ui::testing::fixture_text fixture = ui::testing::plex_text();
    table_catalog words;
    add_english(words);
    menu_run run{fixture, words, snapshot_with(kit::feature_state::failed)};
    run.idle();

    CHECK_FALSE(is_shown(run.frame(), feature_switch_id(page, box)));
    run.click_start(feature_status_id(page, box));
    CHECK(run.changes().empty());
    run.click(reset_button_id(page, box));
    CHECK(run.changes() == std::vector<kit::registry_change>{kit::reset_feature{.feature = box}});
}

TEST_CASE("search keeps the rows whose label holds the query, ignoring case") {
    ui::testing::fixture_text fixture = ui::testing::plex_text();
    table_catalog words;
    add_english(words);
    menu_run run{fixture, words, snapshot_with(kit::feature_state::off)};
    const ui::context& frame = run.frame();
    run.idle();
    run.click(search_field_id(page));
    REQUIRE(frame.focused() == search_field_id(page));

    run.step(typed("THICK"));
    CHECK(run.query() == "THICK");
    CHECK(is_shown(frame, feature_id_in(page, box)));
    CHECK(is_shown(frame, control_of(thickness)));
    CHECK_FALSE(is_shown(frame, control_of(outline)));
    CHECK_FALSE(is_shown(frame, feature_id_in(page, radar)));
}

TEST_CASE("backspace erases the query, and a feature's name as the query shows all its settings") {
    ui::testing::fixture_text fixture = ui::testing::plex_text();
    table_catalog words;
    add_english(words);
    menu_run run{fixture, words, snapshot_with(kit::feature_state::off)};
    const ui::context& frame = run.frame();
    run.idle();
    run.click(search_field_id(page));

    run.step(typed("THICK"));
    run.step(
        ui::testing::keys(
            std::vector<ui::key_event>(5, ui::testing::pressed(ui::key_code::backspace))
        )
    );
    run.step(typed("box"));
    CHECK(run.query() == "box");
    for (const kit::setting_id setting : {outline, thickness, shape, tint}) {
        CHECK(is_shown(frame, control_of(setting)));
    }
    CHECK_FALSE(is_shown(frame, feature_id_in(page, chams)));
}

TEST_CASE("text the catalog lacks renders as each key's placeholder, which search finds") {
    ui::testing::fixture_text fixture = ui::testing::plex_text();
    const table_catalog empty;
    menu_run run{fixture, empty, snapshot_with(kit::feature_state::off)};
    run.idle();
    for (const kit::setting_id setting : {outline, thickness, shape, tint}) {
        CHECK(is_shown(run.frame(), control_of(setting)));
    }

    run.click(search_field_id(page));
    run.step(typed(placeholder(setting_text{.feature = box, .setting = tint})));
    CHECK(is_shown(run.frame(), control_of(tint)));
    CHECK_FALSE(is_shown(run.frame(), control_of(outline)));
    CHECK_FALSE(is_shown(run.frame(), feature_id_in(page, radar)));
}

TEST_CASE("a switch clicked in the menu turns the feature on at the registry's next safe point") {
    ui::testing::fixture_text fixture = ui::testing::plex_text();
    table_catalog words;
    add_english(words);
    const kit::test_clock time;
    kit::wiring wired;
    wired.add<box_feature>();
    kit::registry features{std::move(wired), {.is_everything = true, .features = {}}, time};
    const auto published = [&features] {
        const kit::published<kit::registry_snapshot>::reading seen = features.read();
        return *seen;
    };
    menu_run run{fixture, words, published()};
    run.idle();

    run.click(feature_switch_id(page, box));
    features.request(run.changes());
    CHECK(features.state(box) == kit::feature_state::off);
    features.safe_point();
    CHECK(features.state(box) == kit::feature_state::on);
    run.show(published());
    run.idle();
    run.click(feature_switch_id(page, box));
    CHECK(run.changes() == std::vector<kit::registry_change>{kit::disable_feature{.feature = box}});
}

}
}
