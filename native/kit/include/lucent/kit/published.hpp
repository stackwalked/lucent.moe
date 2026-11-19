#pragma once

#include <array>
#include <atomic>
#include <concepts>
#include <optional>
#include <utility>

#include <lucent/core/narrow.hpp>

namespace lucent::kit {

// An immutable value one thread replaces whole and any thread reads: a reader sees one published
// value from start to end, never a mix of two. Neither side waits on the other: a reader retries
// only while a publish lands under it, and a publish that finds every other slot still being read
// hands its value back for the next try.
template <std::movable T>
class published final {
    struct slot {
        std::optional<T> value;
        std::atomic<i32> readers{0};
    };

public:
    // Pins the value it was read from: no publish reuses its slot until it is dropped. Keep it for
    // one read, not across ticks: a reader that holds two of these can keep every publish out.
    class reading final {
    public:
        reading(const reading&) = delete ("pins one slot");
        auto operator=(const reading&) -> reading& = delete ("pins one slot");
        reading(reading&&) = delete ("pins one slot");
        auto operator=(reading&&) -> reading& = delete ("pins one slot");

        ~reading() {
            // Release: this reader's reads of the value happen before a publish that sees the
            // count fall and overwrites the slot.
            m_slot->readers.fetch_sub(1, std::memory_order_release);
        }

        auto operator*() const -> const T& {
            return *m_value;
        }

        auto operator->() const -> const T* {
            return m_value;
        }

    private:
        friend class published;

        reading(slot& pinned, const T& value)
            : m_slot{&pinned}
            , m_value{&value} {}

        slot* m_slot;
        const T* m_value;
    };

    explicit published(T first) {
        m_slots[0].value.emplace(std::move(first));
    }

    published(const published&) = delete ("readers hold its address");
    auto operator=(const published&) -> published& = delete ("readers hold its address");
    published(published&&) = delete ("readers hold its address");
    auto operator=(published&&) -> published& = delete ("readers hold its address");
    ~published() = default;

    // Any thread. The returned reading must not outlive this object.
    auto read() -> reading {
        while (true) {
            // seq_cst on the index and the count, here and in publish(): a reader that pins a
            // slot and then still finds it current is seen by any publish that later looks at
            // that slot's count, so no publish writes a slot under a reader.
            const isize current = m_current.load(std::memory_order_seq_cst);
            slot& candidate = m_slots.at(narrow<usize>(current));
            candidate.readers.fetch_add(1, std::memory_order_seq_cst);
            // The current slot always holds a value; only one never published is empty.
            if (m_current.load(std::memory_order_seq_cst) == current && candidate.value) {
                return reading{candidate, *candidate.value};
            }
            // Relaxed: nothing of the slot was read.
            candidate.readers.fetch_sub(1, std::memory_order_relaxed);
        }
    }

    // One thread only, the same each time: the value back when every slot but the current one
    // is still being read, so it can be offered again later.
    auto publish(T next) -> std::optional<T> {
        // Relaxed: this thread is the only one that stores the index.
        const isize current = m_current.load(std::memory_order_relaxed);
        for (isize index = 0; index < slot_count; ++index) {
            slot& candidate = m_slots.at(narrow<usize>(index));
            if (index == current || candidate.readers.load(std::memory_order_seq_cst) != 0) {
                continue;
            }
            candidate.value.emplace(std::move(next));
            // Publishes the value written above to readers that load the index.
            m_current.store(index, std::memory_order_seq_cst);
            return std::nullopt;
        }
        return next;
    }

private:
    // The current value, one a slow reader may still hold, and one free to write.
    static constexpr isize slot_count = 3;

    std::array<slot, slot_count> m_slots;
    std::atomic<isize> m_current{0};
};

}
