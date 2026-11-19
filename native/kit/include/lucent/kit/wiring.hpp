#pragma once

#include <algorithm>
#include <memory>
#include <optional>
#include <span>
#include <vector>

#include <lucent/kit/canvas.hpp>
#include <lucent/kit/context.hpp>
#include <lucent/kit/draw_context.hpp>
#include <lucent/kit/feature.hpp>
#include <lucent/kit/settings.hpp>
#include <lucent/kit/view_set.hpp>

namespace lucent::kit {

// A feature that does its work in the tick, on its context.
template <typename F>
concept ticking =
    feature_like<F> && requires(F& running, const context<F>& parts) { running.tick(parts); };

// A feature that draws each frame on the render thread, on its draw context.
template <typename F>
concept drawing =
    feature_like<F> && requires(F& running, const draw_context<F>& parts) { running.draw(parts); };

// A feature the registry can run: it declares itself, and ticks, draws, or both.
template <typename F>
concept runnable = ticking<F> || drawing<F>;

enum class tick_outcome : u8 {
    ran,
    // A part it needs wasn't built this tick.
    skipped,
    // It has nothing to run there: a feature that only draws, at a tick, or one that only ticks,
    // at a draw.
    idle,
};

namespace detail {

// One wired feature, its type erased: what the registry needs to hold, set and run it.
class feature_entry {
public:
    feature_entry(const feature_entry&) = delete ("owned by the registry");
    auto operator=(const feature_entry&) -> feature_entry& = delete ("owned by the registry");
    feature_entry(feature_entry&&) = delete ("owned by the registry");
    auto operator=(feature_entry&&) -> feature_entry& = delete ("owned by the registry");
    virtual ~feature_entry() = default;

    virtual auto id() const -> feature_id = 0;
    virtual auto descriptions() const -> std::span<const setting_description> = 0;
    virtual auto is_available() const -> bool = 0;
    // In descriptions()' order.
    virtual auto values() const -> std::vector<setting_value> = 0;
    // Only for a setting it describes, with a value is_valid accepts.
    virtual auto set(setting_id setting, const setting_value& value) -> void = 0;
    // Called inside contain(); a fault may leave the feature's own state broken.
    virtual auto tick(const view_set& parts) -> tick_outcome = 0;
    // Called inside contain(), on the render thread, as tick.
    virtual auto draw(const view_set& parts, canvas& onto) -> tick_outcome = 0;
    // Drops the feature's own state for a fresh one; its settings stay.
    virtual auto restart() -> void = 0;

protected:
    feature_entry() = default;
};

template <runnable F>
class entry_of final : public feature_entry {
public:
    using settings_type = F::settings;

    auto id() const -> feature_id override {
        return F::id;
    }

    auto descriptions() const -> std::span<const setting_description> override {
        return descriptions_of<settings_type>;
    }

    auto is_available() const -> bool override {
        return are_needs_available<F>();
    }

    auto values() const -> std::vector<setting_value> override {
        std::vector<setting_value> read;
        read.reserve(settings_of<settings_type>.size());
        for (const setting<settings_type>& listed : settings_of<settings_type>) {
            read.push_back(listed.read(m_settings));
        }
        return read;
    }

    auto set(setting_id changed, const setting_value& value) -> void override {
        const auto found = std::ranges::find(
            settings_of<settings_type>, changed, [](const setting<settings_type>& listed) {
                return listed.description.id;
            }
        );
        LUCENT_INVARIANT(found != settings_of<settings_type>.end());
        LUCENT_INVARIANT(is_valid(found->description, value));
        found->write(m_settings, value);
    }

    auto tick(const view_set& parts) -> tick_outcome override {
        if constexpr (!ticking<F>) {
            return tick_outcome::idle;
        } else {
            if (!has_needs<F>(parts)) {
                return tick_outcome::skipped;
            }
            const context<F> running{parts, m_settings};
            m_feature.tick(running);
            return tick_outcome::ran;
        }
    }

    auto draw(const view_set& parts, canvas& onto) -> tick_outcome override {
        if constexpr (!drawing<F>) {
            return tick_outcome::idle;
        } else {
            if (!has_needs<F>(parts)) {
                return tick_outcome::skipped;
            }
            const draw_context<F> drawn{parts, m_settings, onto};
            m_feature.draw(drawn);
            return tick_outcome::ran;
        }
    }

    auto restart() -> void override {
        m_feature = F{};
    }

private:
    F m_feature;
    settings_type m_settings;
};

}

// The features one target ships, in the order they run: its explicit list (`features/all.cpp`)
// adds each by type, nothing registers itself. The registry takes them over.
class wiring final {
public:
    template <runnable F>
    auto add() -> void {
        static_assert(
            is_well_described<typename F::settings>(),
            "every setting path distinct, every default one its setting accepts"
        );
        LUCENT_INVARIANT(!std::ranges::contains(m_entries, F::id, &detail::feature_entry::id));
        m_entries.push_back(std::make_unique<detail::entry_of<F>>());
    }

private:
    friend class registry;

    std::vector<std::unique_ptr<detail::feature_entry>> m_entries;
};

}
