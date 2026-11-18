#include <lucent/core/contain.hpp>

#include <bit>
#include <expected>
#include <optional>

#include <Windows.h>

#include <excpt.h>

#include <lucent/core/fault.hpp>
#include <lucent/core/stdx/function_ref.hpp>

// The only file with throw, try and __try (ast-grep: exceptions-in-contain-only).

namespace lucent {
namespace {

// Everything else (stack overflow, illegal instruction, breakpoints, foreign C++ exceptions) is
// left alone: catching it would turn a real bug into a quietly disabled feature.
auto memory_fault_kind(DWORD code) -> std::optional<fault_kind> {
    switch (code) {
    case EXCEPTION_ACCESS_VIOLATION:
        return fault_kind::access_violation;
    case EXCEPTION_IN_PAGE_ERROR:
        return fault_kind::page_error;
    case EXCEPTION_DATATYPE_MISALIGNMENT:
        return fault_kind::misaligned;
    default:
        return std::nullopt;
    }
}

// build: Windows SDK 10.0.26100.0, winnt.h
// found: the EXCEPTION_RECORD documentation: for an access violation or in-page error,
//        ExceptionInformation[0] is the access (0 read, 1 write, 8 execute), [1] the address
// breaks: a fault reports the wrong address or access; containment itself is unaffected
constexpr ULONG_PTR access_write = 1;

// The __except filter. Its result must be an int, so what it learned leaves through `caught`.
auto filter(const EXCEPTION_POINTERS& pointers, fault& caught) -> i32 {
    const EXCEPTION_RECORD& record = *pointers.ExceptionRecord;
    const std::optional<fault_kind> kind = memory_fault_kind(record.ExceptionCode);
    if (!kind) {
        return EXCEPTION_CONTINUE_SEARCH;
    }
    const bool has_address = *kind != fault_kind::misaligned && record.NumberParameters >= 2;
    caught = fault{
        .kind = *kind,
        .where = {},
        .instruction = std::bit_cast<uptr>(record.ExceptionAddress),
        .address = has_address ? record.ExceptionInformation[1] : 0,
        .is_write = has_address && record.ExceptionInformation[0] == access_write,
    };
    return EXCEPTION_EXECUTE_HANDLER;
}

// The C++ layer, apart from the SEH layer because one function can't hold both try and __try.
auto raised_by(stdx::function_ref<void()> body) -> std::optional<fault> {
    try {
        body();
    } catch (const fault& thrown) {
        return thrown;
    }
    return std::nullopt;
}

}

auto raise(const fault& thrown) -> void {
    // NOLINTNEXTLINE(hicpp-exception-baseclass): one fault type, caught only by contain(); nothing inspects it as std::exception.
    throw thrown;
}

auto contain(stdx::function_ref<void()> body) -> contained<void> {
    fault caught{};
    std::optional<fault> raised;
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wlanguage-extension-token" // SEH has no standard spelling
    __try {
        raised = raised_by(body);
    } __except (filter(*GetExceptionInformation(), caught)) {
        return std::unexpected(caught);
    }
#pragma clang diagnostic pop
    if (raised) {
        return std::unexpected(*raised);
    }
    return {};
}

}
