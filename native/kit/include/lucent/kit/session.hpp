#pragma once

#include <lucent/kit/session_message.hpp>
#include <lucent/os/unique_handle.hpp>

namespace lucent::kit {

// The two one-way pipes between host and module. One pipe per direction, because synchronous
// I/O on a single handle is serialized: a blocked read would hold up every write.
struct session_ends {
    os::unique_handle inbound;
    os::unique_handle outbound;
};

class session final {
public:
    explicit session(session_ends ends);

    // Safe from several threads at once: each frame goes out in a single write.
    auto send(const session_message& message) -> result<void>;

    // Blocks until a message arrives, or fails with error_code::closed once the peer is gone.
    auto receive() -> result<session_message>;

private:
    os::unique_handle m_inbound;
    os::unique_handle m_outbound;
};

}
