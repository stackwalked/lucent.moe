#pragma once

namespace lucent::integrity {

// One environment bit as the server receives it. A probe the system refused is reported as such,
// never as clear: silence where a healthy session would speak is a signal of its own.
enum class observation : u8 { clear, raised, unavailable };

}
