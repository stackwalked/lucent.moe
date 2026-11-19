#pragma once

namespace lucent::integrity {

// The hypervisor under this machine, by its CPUID signature. Hyper-V is split by partition:
// `hyperv_root` is Windows running on its own hypervisor (VBS, or Hyper-V enabled), which is no
// virtual machine and is reported apart so that a VBS host never reads as one.
enum class vm_vendor : u8 {
    none,
    hyperv_root,
    hyperv_guest,
    vmware,
    virtualbox,
    kvm,
    xen,
    parallels,
    qemu,
    bhyve,
    other,
};

auto hypervisor_vendor() -> vm_vendor;

}
