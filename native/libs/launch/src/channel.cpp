#include <lucent/launch/channel.hpp>

#include <utility>

#include <lucent/kit/boot_info.hpp>
#include <lucent/kit/session.hpp>
#include <lucent/os/pipe.hpp>
#include <lucent/os/process.hpp>

namespace lucent::launch {

auto open_channel(const os::process& target) -> result<host_channel> {
    os::pipe to_module = LUCENT_TRY(os::create_pipe());
    os::pipe to_host = LUCENT_TRY(os::create_pipe());
    void* const module_inbound = LUCENT_TRY(os::transfer_to(target, std::move(to_module.read_end)));
    void* const module_outbound = LUCENT_TRY(os::transfer_to(target, std::move(to_host.write_end)));
    return host_channel{
        .session = kit::session{kit::session_ends{
            .inbound = std::move(to_host.read_end),
            .outbound = std::move(to_module.write_end),
        }},
        .boot = kit::boot_info{
            .version = kit::boot_info_version,
            .from_host = module_inbound,
            .to_host = module_outbound,
        },
    };
}

}
