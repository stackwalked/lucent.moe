#include <lucent/integrity/vm_vendor.hpp>

#include <array>
#include <string_view>

#include <intrin.h>

namespace lucent::integrity {
namespace {

// CPUID facts.
// found: Intel SDM vol. 2A, CPUID leaf 1 (ECX bit 31 is reserved for hypervisors to set); the
// hypervisor leaves 0x40000000 and up follow the convention every vendor's documentation shares:
// the highest leaf in EAX and a 12-byte signature in EBX, ECX, EDX. Hyper-V's partition
// privileges are leaf 0x40000003 EBX, CreatePartitions bit 0, which only the root partition holds
// (Hypervisor Top Level Functional Specification, "Partition Privilege Flags").
// breaks: an unknown signature reads as `other`; a wrong root bit reports every VBS host as a
// Hyper-V guest.
constexpr i32 feature_leaf = 1;
constexpr u32 hypervisor_present = 1U << 31U;
constexpr i32 hypervisor_leaf = 0x40000000;
constexpr i32 privileges_leaf = 0x40000003;
constexpr u32 create_partitions = 1U;

struct signature {
    u32 ebx = 0;
    u32 ecx = 0;
    u32 edx = 0;

    auto operator==(const signature&) const -> bool = default;
};

struct registers {
    u32 eax = 0;
    u32 ebx = 0;
    u32 ecx = 0;
    u32 edx = 0;
};

consteval auto word_of(std::string_view text) -> u32 {
    u32 word = 0;
    for (usize index = 0; index < 4; ++index) {
        word |= u32{static_cast<u8>(text.at(index))} << (8U * index);
    }
    return word;
}

// Evaluated at compile time only, so no signature text lands in the image.
consteval auto signature_of(std::string_view text) -> signature {
    return signature{
        .ebx = word_of(text.substr(0, 4)),
        .ecx = word_of(text.substr(4, 4)),
        .edx = word_of(text.substr(8, 4)),
    };
}

struct known_vendor {
    signature id;
    vm_vendor vendor = vm_vendor::other;
};

constexpr std::array known_vendors{
    known_vendor{.id = signature_of("VMwareVMware"), .vendor = vm_vendor::vmware},
    known_vendor{.id = signature_of("VBoxVBoxVBox"), .vendor = vm_vendor::virtualbox},
    // KVM pads its signature with NULs.
    known_vendor{
        .id = signature_of(std::string_view{"KVMKVMKVM\0\0\0", 12}),
        .vendor = vm_vendor::kvm,
    },
    known_vendor{.id = signature_of("XenVMMXenVMM"), .vendor = vm_vendor::xen},
    known_vendor{.id = signature_of("prl hyperv  "), .vendor = vm_vendor::parallels},
    known_vendor{.id = signature_of(" lrpepyh  vr"), .vendor = vm_vendor::parallels},
    known_vendor{.id = signature_of("TCGTCGTCGTCG"), .vendor = vm_vendor::qemu},
    known_vendor{.id = signature_of("bhyve bhyve "), .vendor = vm_vendor::bhyve},
};

constexpr signature hyperv = signature_of("Microsoft Hv");

auto cpuid(i32 leaf) -> registers {
    std::array<i32, 4> raw{};
    __cpuidex(raw.data(), leaf, 0);
    return registers{
        .eax = static_cast<u32>(raw[0]),
        .ebx = static_cast<u32>(raw[1]),
        .ecx = static_cast<u32>(raw[2]),
        .edx = static_cast<u32>(raw[3]),
    };
}

auto hyperv_partition(u32 highest_leaf) -> vm_vendor {
    if (highest_leaf < static_cast<u32>(privileges_leaf)) {
        return vm_vendor::hyperv_guest;
    }
    const bool is_root = (cpuid(privileges_leaf).ebx & create_partitions) != 0;
    return is_root ? vm_vendor::hyperv_root : vm_vendor::hyperv_guest;
}

}

auto hypervisor_vendor() -> vm_vendor {
    if ((cpuid(feature_leaf).ecx & hypervisor_present) == 0) {
        return vm_vendor::none;
    }
    const registers vendor_leaf = cpuid(hypervisor_leaf);
    const signature found{.ebx = vendor_leaf.ebx, .ecx = vendor_leaf.ecx, .edx = vendor_leaf.edx};
    if (found == hyperv) {
        return hyperv_partition(vendor_leaf.eax);
    }
    for (const known_vendor& known : known_vendors) {
        if (known.id == found) {
            return known.vendor;
        }
    }
    return vm_vendor::other;
}

}
