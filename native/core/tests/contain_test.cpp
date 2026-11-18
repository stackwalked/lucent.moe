#include <lucent/core/contain.hpp>

#include <bit>
#include <source_location>
#include <string>
#include <thread>
#include <tuple>

#include <Windows.h>

#include <intrin.h>

#include <catch2/catch_test_macros.hpp>

#include <lucent/core/fault.hpp>

namespace lucent {
namespace {

// A committed page that nothing may touch, so reading or writing it is a real access violation.
class no_access_page final {
public:
    no_access_page()
        : m_base{VirtualAlloc(nullptr, 4096, MEM_RESERVE | MEM_COMMIT, PAGE_NOACCESS)} {
        REQUIRE(m_base != nullptr);
    }

    no_access_page(const no_access_page&) = delete ("owns the page");
    auto operator=(const no_access_page&) -> no_access_page& = delete ("owns the page");
    no_access_page(no_access_page&&) = delete ("owns the page");
    auto operator=(no_access_page&&) -> no_access_page& = delete ("owns the page");

    ~no_access_page() {
        VirtualFree(m_base, 0, MEM_RELEASE);
    }

    auto address() const -> uptr {
        return std::bit_cast<uptr>(m_base);
    }

    auto word() const -> u32* {
        return static_cast<u32*>(m_base);
    }

private:
    void* m_base;
};

TEST_CASE("contain turns a read of an inaccessible page into an access violation at that address") {
    const no_access_page page;
    u32 observed = 0;

    const contained<void> ran = contain([&] { observed = *page.word(); });

    REQUIRE_FALSE(ran.has_value());
    CHECK(ran.error().kind == fault_kind::access_violation);
    CHECK(ran.error().address == page.address());
    CHECK_FALSE(ran.error().is_write);
    CHECK(ran.error().instruction != 0);
    CHECK(observed == 0);
}

TEST_CASE("contain reports a write to an inaccessible page as a write") {
    const no_access_page page;

    const contained<void> ran = contain([&] { *page.word() = 1; });

    REQUIRE_FALSE(ran.has_value());
    CHECK(ran.error().kind == fault_kind::access_violation);
    CHECK(ran.error().address == page.address());
    CHECK(ran.error().is_write);
}

TEST_CASE("a failed ensure inside contain comes back as a fault located at the check") {
    bool should_hold = false;
    const u32 check_line = std::source_location::current().line() + 2;
    const contained<void> ran = contain([&] {
        LUCENT_ENSURE(should_hold);
        should_hold = true;
    });

    REQUIRE_FALSE(ran.has_value());
    CHECK(ran.error().kind == fault_kind::ensure_failed);
    CHECK(ran.error().where.line() == check_line);
    CHECK_FALSE(should_hold);
}

TEST_CASE("an inner contain keeps its fault from reaching the outer one") {
    const no_access_page page;
    u32 observed = 0;
    contained<void> inner;

    const contained<void> outer = contain([&] {
        inner = contain([&] { observed = *page.word(); });
        observed = 1;
    });

    CHECK(outer.has_value());
    CHECK_FALSE(inner.has_value());
    CHECK(observed == 1);
}

TEST_CASE("contain works on a thread other than the test's") {
    const no_access_page page;
    contained<void> ran;

    {
        const std::jthread worker{[&] {
            u32 observed = 0;
            ran = contain([&] { observed = *page.word(); });
            std::ignore = observed;
        }};
    }

    REQUIRE_FALSE(ran.has_value());
    CHECK(ran.error().address == page.address());
}

// Run only as the child of the test below: a crash in a child process is the only way to see
// that contain() let the exception through.
TEST_CASE("an illegal instruction inside contain crashes the process", "[.][child]") {
    SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX);
    std::ignore = contain([] { __ud2(); });
    // Reached only if contain() swallowed it; the parent test fails on the clean exit.
    SUCCEED();
}

TEST_CASE("contain lets every other exception through to crash the process") {
    std::wstring self(MAX_PATH, L'\0');
    self.resize(GetModuleFileNameW(nullptr, self.data(), MAX_PATH));
    REQUIRE_FALSE(self.empty());
    std::wstring command =
        L"\"" + self + L"\" \"an illegal instruction inside contain crashes the process\"";
    STARTUPINFOW startup{};
    startup.cb = sizeof(startup);
    PROCESS_INFORMATION child{};

    REQUIRE(
        CreateProcessW(
            nullptr,
            command.data(),
            nullptr,
            nullptr,
            FALSE,
            CREATE_NO_WINDOW,
            nullptr,
            nullptr,
            &startup,
            &child
        )
        != FALSE
    );
    const DWORD waited = WaitForSingleObject(child.hProcess, 30'000);
    DWORD exit_code = 0;
    GetExitCodeProcess(child.hProcess, &exit_code);
    CloseHandle(child.hThread);
    CloseHandle(child.hProcess);

    REQUIRE(waited == WAIT_OBJECT_0);
    CHECK(exit_code == EXCEPTION_ILLEGAL_INSTRUCTION);
}

}
}
