#include <cstddef>
#include <cstdio>
#include <cstdlib>
#include <print>
#include <source_location>
#include <span>

#include <lucent/core/invariant.hpp>
#include <lucent/fuzzing/run_one.hpp>

namespace {

// The default handler fails fast, which ends the process before libFuzzer can save the input.
// abort() reaches libFuzzer's crash handler, which writes it to crash-<sha1>.
[[noreturn]] auto abort_on_violation(std::source_location where) -> void {
    std::println(stderr, "invariant violated at {}:{}", where.file_name(), where.line());
    std::abort();
}

}

// libFuzzer's entry points, under the names and signatures its runtime calls; no header of its own
// declares them. The input is declared as std::byte rather than libFuzzer's uint8_t: the same
// one-byte object type, so the same call.
// NOLINTBEGIN(readability-identifier-naming,misc-const-correctness): libFuzzer's names and signatures.
extern "C" auto LLVMFuzzerInitialize(int* argc, char*** argv) noexcept -> int;
extern "C" auto LLVMFuzzerTestOneInput(const std::byte* data, lucent::usize size) noexcept -> int;

extern "C" auto
LLVMFuzzerInitialize([[maybe_unused]] int* argc, [[maybe_unused]] char*** argv) noexcept -> int {
    lucent::set_invariant_handler(&abort_on_violation);
    return 0;
}

extern "C" auto LLVMFuzzerTestOneInput(const std::byte* data, lucent::usize size) noexcept -> int {
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wunsafe-buffer-usage-in-container" // libFuzzer's own buffer
    lucent::fuzzing::run_one(std::span<const std::byte>{data, size});
#pragma clang diagnostic pop
    return 0;
}

// NOLINTEND(readability-identifier-naming,misc-const-correctness)
