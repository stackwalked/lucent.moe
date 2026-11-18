#include <lucent/core/result.hpp>

#include <Windows.h>

namespace lucent {

auto last_system_error() -> error {
    return error{.code = error_code::system, .system_code = GetLastError()};
}

}
