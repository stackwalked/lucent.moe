#include "app/run.hpp"

#include <chrono>
#include <cstddef>
#include <cstdio>
#include <expected>
#include <filesystem>
#include <format>
#include <optional>
#include <print>
#include <stop_token>
#include <string>
#include <string_view>
#include <thread>
#include <utility>
#include <vector>

#include <Windows.h>

#include <lucent/core/match.hpp>
#include <lucent/crypto/crypto.hpp>
#include <lucent/kit/session.hpp>
#include <lucent/kit/session_message.hpp>
#include <lucent/os/process.hpp>
#include <lucent/wire/ids.hpp>
#include <lucent/wire/refusal.hpp>
#include <lucent/wire/release_seal.hpp>

#include "account/enrollment.hpp"
#include "account/sign_in.hpp"
#include "api/server.hpp"
#include "app/describe.hpp"
#include "app/options.hpp"
#include "build/inputs.hpp"
#include "cng/device_key.hpp"
#include "http/client.hpp"
#include "session/live_link.hpp"
#include "session/relay.hpp"
#include "start/game.hpp"
#include "start/start_module.hpp"
#include "store/saved_state.hpp"
#include "update/decision.hpp"
#include "update/install.hpp"

namespace lucent::loader {
namespace {

constexpr std::chrono::seconds game_poll_interval{2};
// The loader seal is a few hundred bytes; the bound is the wire's.
constexpr usize max_seal_size = usize{1} << 20U;

auto channel_name(wire::channel chosen) -> std::string_view {
    switch (chosen) {
    case wire::channel::stable:
        return "stable";
    case wire::channel::alpha:
        return "alpha";
    case wire::channel::debug:
        return "debug";
    }
    LUCENT_UNREACHABLE();
}

auto stage_name(kit::stage reached) -> std::string_view {
    switch (reached) {
    case kit::stage::boot:
        return "booting";
    case kit::stage::attach:
        return "attaching";
    case kit::stage::run:
        return "running";
    case kit::stage::detach:
        return "stopping";
    case kit::stage::unload:
        return "unloading";
    }
    LUCENT_UNREACHABLE();
}

// Why the loader stops: printed once, and the exit code.
struct stopped {
    std::string reason;
};

auto failed(std::string_view what, const error& failure) -> stopped {
    return stopped{.reason = std::format("{}: {}", what, describe(failure))};
}

auto refused(wire::refusal_code code) -> stopped {
    return stopped{.reason = std::format("refused: {}", describe(code))};
}

// Everything a run holds once the PC's key and the server are reached.
class session_context final {
public:
    session_context(std::filesystem::path root, saved_state state, server& api)
        : m_root{std::move(root)}
        , m_state{std::move(state)}
        , m_api{&api}
        , m_tokens{m_state.refresh_token} {}

    auto state() -> saved_state& {
        return m_state;
    }

    auto root() const -> const std::filesystem::path& {
        return m_root;
    }

    auto api() -> server& {
        return *m_api;
    }

    auto tokens() -> credentials& {
        return m_tokens;
    }

    auto save() -> result<void> {
        return save_state(m_root, m_state);
    }

    // Saves each rotated refresh token before it is used.
    auto keep_refresh_token(std::string_view refresh_token) -> result<void> {
        m_state.refresh_token = std::string{refresh_token};
        return save();
    }

    // An access token, signing in through the browser when there's none to refresh.
    auto access_token() -> std::expected<std::string, stopped> {
        const auto keep = [this](std::string_view refresh_token) {
            return keep_refresh_token(refresh_token);
        };
        const result<std::optional<std::string>> held = m_tokens.access_token(*m_api, keep);
        if (!held) {
            return std::unexpected(failed("couldn't reach the server", held.error()));
        }
        if (*held) {
            return **held;
        }
        return sign_in_now();
    }

private:
    auto sign_in_now() -> std::expected<std::string, stopped> {
        std::println("signing in: approve this loader in your browser");
        const auto show = [](std::string_view url) {
            std::println("if no browser opened, go to {}", url);
        };
        const result<sign_in_outcome> outcome = sign_in(*m_api, server_origins().web, show);
        if (!outcome) {
            return std::unexpected(failed("sign-in failed", outcome.error()));
        }
        return match(
            *outcome,
            [this](const token_set& tokens) -> std::expected<std::string, stopped> {
                m_tokens.replace(tokens);
                if (const result<void> kept = keep_refresh_token(tokens.refresh_token); !kept) {
                    return std::unexpected(failed("couldn't save the sign-in", kept.error()));
                }
                std::println("signed in");
                return tokens.access_token;
            },
            [](const oauth_refusal& refusal) -> std::expected<std::string, stopped> {
                return std::unexpected(
                    stopped{.reason = std::format("sign-in refused: {}", refusal.reason)}
                );
            }
        );
    }

    std::filesystem::path m_root;
    saved_state m_state;
    server* m_api;
    credentials m_tokens;
};

// The loader seal the server serves, or why not.
auto served_loader_seal(session_context& context, std::string_view token)
    -> std::expected<std::vector<std::byte>, stopped> {
    constexpr std::string_view path = "/v1/loader";
    const result<answer> served = context.api().send(
        call{
            .method = "GET",
            .path = path,
            .access_token = token,
            .body = {},
            .kind = operation::none,
            .max_body = max_seal_size,
        }
    );
    if (!served) {
        return std::unexpected(failed("couldn't reach the server", served.error()));
    }
    return match(
        *served,
        [](const std::vector<std::byte>& body) -> std::expected<std::vector<std::byte>, stopped> {
            return body;
        },
        [](const wire::refusal& refusal) -> std::expected<std::vector<std::byte>, stopped> {
            return std::unexpected(refused(refusal.code));
        }
    );
}

enum class update_step : u8 { carry_on, handed_over };

// The seal the server decided on, and whether it is the release this build already is.
struct served_choice {
    wire::release_seal seal;
    bool is_current;
};

auto rollback_stop(const rollback_refused& rollback) -> stopped {
    return stopped{
        .reason = std::format(
            "the server offers loader release {}, older than {} seen before; not going back",
            rollback.served,
            rollback.highest
        ),
    };
}

auto served_choice_of(const update_decision& decided) -> std::expected<served_choice, stopped> {
    return match(
        decided,
        [](const up_to_date& same) -> std::expected<served_choice, stopped> {
            return served_choice{.seal = same.seal, .is_current = true};
        },
        [](const update_needed& newer) -> std::expected<served_choice, stopped> {
            return served_choice{.seal = newer.seal, .is_current = false};
        },
        [](const rollback_refused& rollback) -> std::expected<served_choice, stopped> {
            return std::unexpected(rollback_stop(rollback));
        }
    );
}

// Makes this run the release served: installs it and hands over when it isn't, and once it is,
// moves the shortcut to it and drops every release but it and the one before it.
auto update_if_needed(session_context& context, const crypto::public_key& code_key)
    -> std::expected<update_step, stopped> {
    const std::optional<wire::release_id> own = own_release();
    if (!own) {
        std::println("dev build: not updating itself");
        return update_step::carry_on;
    }
    const std::string token = LUCENT_TRY(context.access_token());
    const std::vector<std::byte> seal_bytes = LUCENT_TRY(served_loader_seal(context, token));
    const result<update_decision> decided = decide_update(
        update_inputs{
            .seal = seal_bytes,
            .code_key = code_key,
            .own = own,
            .highest_seen = context.state().highest_loader_seal,
        }
    );
    if (!decided) {
        return std::unexpected(failed("the server's loader seal doesn't verify", decided.error()));
    }
    const served_choice choice = LUCENT_TRY(served_choice_of(*decided));
    const std::optional<u64> running = running_release(context.root());
    if (choice.is_current && running == choice.seal.number) {
        raise_loader_seal(context.state(), choice.seal.number);
        if (const result<void> saved = context.save(); !saved) {
            return std::unexpected(failed("couldn't save the release seen", saved.error()));
        }
        // The shortcut moves only now: this release runs, so it is the way forward.
        const std::filesystem::path self =
            release_directory(context.root(), choice.seal.number) / loader_file;
        if (const result<void> pointed = point_shortcut(self); !pointed) {
            std::println(
                stderr, "couldn't update the start menu shortcut: {}", describe(pointed.error())
            );
        }
        prune_releases(context.root(), choice.seal.number);
        return update_step::carry_on;
    }
    // Installed under the served seal's number yet not its release: installing again would start
    // this same binary, and that one would do the same.
    if (running == choice.seal.number) {
        return std::unexpected(
            stopped{
                .reason = std::format(
                    "loader release {} is installed, but this build isn't the release its seal "
                    "names",
                    choice.seal.number
                ),
            }
        );
    }
    // Not the release served, or the right one running from outside its install (a fresh
    // download): install what the seal names and start it from there.
    const wire::release_seal& seal = choice.seal;
    std::println("installing loader release {}", seal.number);
    const result<install_outcome> outcome =
        install_release(context.api(), token, context.root(), seal, seal_bytes);
    if (!outcome) {
        return std::unexpected(failed("couldn't install the update", outcome.error()));
    }
    return match(
        *outcome,
        [](const installed& done) -> std::expected<update_step, stopped> {
            if (const result<void> started = hand_over(done.loader); !started) {
                return std::unexpected(failed("couldn't start the update", started.error()));
            }
            return update_step::handed_over;
        },
        [](const wire::refusal& refusal) -> std::expected<update_step, stopped> {
            return std::unexpected(refused(refusal.code));
        }
    );
}

auto enroll_if_needed(session_context& context, const device_key& key)
    -> std::expected<void, stopped> {
    if (context.state().is_enrolled) {
        return {};
    }
    std::println("this PC isn't approved yet: approve it under devices on the site");
    const auto token = [&context] -> result<std::string> {
        std::expected<std::string, stopped> held = context.access_token();
        if (!held) {
            return std::unexpected(error{.code = error_code::closed});
        }
        return *std::move(held);
    };
    const auto show = [](std::string_view code) { std::println("match code: {}", code); };
    const result<enrollment_outcome> outcome = enroll(context.api(), key, token, show);
    if (!outcome) {
        return std::unexpected(failed("enrollment failed", outcome.error()));
    }
    const std::expected<void, stopped> verdict = match(
        *outcome,
        [](const enrolled& /*done*/) -> std::expected<void, stopped> { return {}; },
        [](const not_approved& /*denied*/) -> std::expected<void, stopped> {
            return std::unexpected(stopped{.reason = "this PC wasn't approved"});
        },
        [](const wire::refusal& refusal) -> std::expected<void, stopped> {
            return std::unexpected(refused(refusal.code));
        }
    );
    if (!verdict) {
        return std::unexpected(verdict.error());
    }
    context.state().is_enrolled = true;
    if (const result<void> saved = context.save(); !saved) {
        return std::unexpected(failed("couldn't save the enrollment", saved.error()));
    }
    std::println("this PC is approved");
    return {};
}

auto wait_for_game(const game_product& product) -> std::expected<os::process, stopped> {
    bool has_said = false;
    while (true) {
        result<os::process> game = open_game(product);
        if (game && is_ready(product, *game)) {
            return *std::move(game);
        }
        if (!game && game.error().code != error_code::not_found) {
            return std::unexpected(
                failed(std::format("couldn't open {}", product.executable), game.error())
            );
        }
        if (!has_said) {
            std::println("waiting for {}", product.executable);
            has_said = true;
        }
        std::this_thread::sleep_for(game_poll_interval);
    }
}

// Enter in the console asks the module to unload. Polled, so the thread ends with the session
// rather than sitting in a read.
auto watch_for_enter(const std::stop_token& stop, kit::session& channel) -> void {
    void* const input = GetStdHandle(STD_INPUT_HANDLE);
    // Not a console (input redirected): nothing to watch, and a pipe would signal forever.
    DWORD mode = 0;
    if (GetConsoleMode(input, &mode) == FALSE) {
        return;
    }
    while (!stop.stop_requested()) {
        if (WaitForSingleObject(input, 200) != WAIT_OBJECT_0) {
            continue;
        }
        INPUT_RECORD record{};
        DWORD read = 0;
        if (ReadConsoleInputW(input, &record, 1, &read) == FALSE || read == 0) {
            continue;
        }
        // NOLINTNEXTLINE(cppcoreguidelines-pro-type-union-access): INPUT_RECORD is the console API's tagged union.
        const KEY_EVENT_RECORD& key = record.Event.KeyEvent;
        if (record.EventType == KEY_EVENT
            && key.bKeyDown != FALSE
            && key.wVirtualKeyCode == VK_RETURN) {
            std::ignore = channel.send(kit::unload_request{});
        }
    }
}

// Says which stage the module reached, and when to press Enter.
auto announce(const kit::session_message& message) -> void {
    match(
        message,
        [](const kit::stage_reached& reached) {
            std::println("{}", stage_name(reached.reached));
            if (reached.reached == kit::stage::run) {
                std::println("press Enter to unload");
            }
        },
        [](const kit::dev_text& /*text*/) {},
        [](const kit::unload_request& /*request*/) {},
        [](const kit::start_refused& /*refusal*/) {},
        [](const kit::server_request& /*request*/) {},
        [](const kit::server_reply& /*reply*/) {}
    );
}

// Relays the module's session until its end closes; the refusal, if one ended it.
auto relay_session(session_context& context, started_module& started)
    -> std::optional<wire::refusal_code> {
    const auto keep = [&context](std::string_view refresh_token) {
        return context.keep_refresh_token(refresh_token);
    };
    live_link link{context.api(), context.tokens(), keep};
    relay state{started.start};
    kit::session& channel = started.channel.session;
    const std::jthread watcher{[&channel](const std::stop_token& stop) {
        watch_for_enter(stop, channel);
    }};
    while (true) {
        const result<kit::session_message> received = channel.receive();
        if (!received) {
            break;
        }
        announce(*received);
        const std::optional<kit::session_message> reply = state.on_message(*received, link);
        if (reply) {
            std::ignore = channel.send(*reply);
        }
    }
    if (const std::optional<wire::session_id> session = state.session()) {
        std::ignore = link.close(*session);
    }
    return state.refused();
}

auto run_product(
    session_context& context, const crypto::public_key& code_key, const options& chosen
) -> std::expected<void, stopped> {
    const std::optional<game_product> product = find_game_product(chosen.product);
    if (!product) {
        return std::unexpected(
            stopped{.reason = std::format("no product named {}", chosen.product)}
        );
    }
    const os::process game = LUCENT_TRY(wait_for_game(*product));
    const std::string token = LUCENT_TRY(context.access_token());
    std::println("starting {} on {}", product->id, channel_name(context.state().chosen));
    result<start_outcome> outcome = start_module(
        context.api(),
        token,
        game,
        start_request_inputs{
            .product = *product,
            .chosen = context.state().chosen,
            .loader_release = own_release().value_or(wire::release_id{}),
            .code_key = code_key,
            .highest_seen =
                highest_module_seal_of(context.state(), product->id, context.state().chosen),
        }
    );
    if (!outcome) {
        return std::unexpected(failed("couldn't start", outcome.error()));
    }
    return match(
        *outcome,
        [&context, &product](started_module& started) -> std::expected<void, stopped> {
            raise_module_seal(
                context.state(), product->id, context.state().chosen, started.seal_number
            );
            if (const result<void> saved = context.save(); !saved) {
                std::println(stderr, "couldn't save the release seen: {}", describe(saved.error()));
            }
            const std::optional<wire::refusal_code> ended = relay_session(context, started);
            if (ended) {
                return std::unexpected(refused(*ended));
            }
            std::println("unloaded");
            return {};
        },
        [&context](const wire::refusal& refusal) -> std::expected<void, stopped> {
            // A removed PC enrolls again next time.
            if (refusal.code == wire::refusal_code::device_revoked) {
                context.state().is_enrolled = false;
                std::ignore = context.save();
            }
            return std::unexpected(refused(refusal.code));
        },
        [](const stale_release& stale) -> std::expected<void, stopped> {
            return std::unexpected(
                stopped{
                    .reason = std::format(
                        "the server offers release {}, older than {} seen before; not going back",
                        stale.served,
                        stale.highest
                    ),
                }
            );
        }
    );
}

// One loader per Windows user at a time: two would share the state file, and each refreshing the
// other's rotated token revokes its whole family. Held until the process exits; a loader handing
// over to its update waits for the one before it to let go.
auto claim_single_instance() -> std::expected<void, stopped> {
    constexpr DWORD patience_ms = 15'000;
    void* const guard = CreateMutexW(nullptr, FALSE, L"Local\\lucent-loader");
    if (guard == nullptr) {
        return std::unexpected(failed("couldn't take the loader's lock", last_system_error()));
    }
    const DWORD waited = WaitForSingleObject(guard, patience_ms);
    if (waited != WAIT_OBJECT_0 && waited != WAIT_ABANDONED) {
        CloseHandle(guard);
        return std::unexpected(stopped{.reason = "another loader is running"});
    }
    return {};
}

auto run_all(const options& chosen) -> std::expected<void, stopped> {
    LUCENT_TRY(claim_single_instance());
    const std::optional<crypto::public_key> code_key = loader::code_key();
    if (!code_key) {
        return std::unexpected(
            stopped{.reason = "this build names no code key, so it trusts no release"}
        );
    }
    const result<std::filesystem::path> root = install_root();
    if (!root) {
        return std::unexpected(failed("no place to keep state", root.error()));
    }
    saved_state state = load_saved_state(*root);
    if (chosen.chosen) {
        state.chosen = *chosen.chosen;
    }
    const result<device_key> key = device_key::open_or_create();
    if (!key) {
        return std::unexpected(failed("couldn't open this PC's key", key.error()));
    }
    result<http::client> link = http::client::open(server_origins().api);
    if (!link) {
        return std::unexpected(failed("couldn't reach the server", link.error()));
    }
    server api{*std::move(link), *key};
    session_context context{*root, std::move(state), api};
    if (const result<void> saved = context.save(); !saved) {
        return std::unexpected(failed("couldn't save state", saved.error()));
    }
    if (LUCENT_TRY(update_if_needed(context, *code_key)) == update_step::handed_over) {
        return {};
    }
    LUCENT_TRY(enroll_if_needed(context, *key));
    return run_product(context, *code_key, chosen);
}

}

auto run(const options& chosen) -> i32 {
    const std::expected<void, stopped> ran = run_all(chosen);
    if (!ran) {
        std::println(stderr, "{}", ran.error().reason);
        return 1;
    }
    return 0;
}

}
