import { createWriter, type FormatError, malformed, openReader } from "@lucent/bundle/wire";
import { invariant } from "@lucent/core/contain";
import type { Result } from "@lucent/core/result";
import { finish } from "./codec.ts";
import { SIGNALS_SIZE } from "./lease.ts";

// The renewal's 64-byte signals field (lease.ts), as the module fills it each renewal:
//   byte 0, bits 0 to 5: a debugger on the game, host or loader; hardware breakpoints; kernel
//     debugging; test signing; driver signature enforcement off; code pages of our own image
//     (loader or module) writable, never the game's. Bits 6 and 7 are zero.
//   byte 1: VM vendor, 0 for none, else VM_VENDORS below.
//   bytes 2 to 3: the Windows build, u16.
//   bytes 4 to 31: reserved, zero.
//   bytes 32 to 63: four u64 slots, each the first 8 bytes of an unsigned module's BLAKE2b hash
//     read little-endian; a slot of zeros is unused.
// A set reserved bit or byte, or a vendor past the list, is MALFORMED.
//
// Provenance: approved by the human on 2026-11-25 as packet 04b's layout. The golden vectors
// contracts/wire/v1/renewal_bits_* were produced by this encoder, not by native/libs/wire;
// native's encoder and decoder must match them byte for byte. Native's renewal_frame vector
// carries a field this side reads too (renewal-bits.test.ts).
//
// The hash slots are a set held in place: any slot may be used, in any order, a hash may repeat.
// The decoder keeps them positionally, so every field it accepts encodes back to its own bytes.

// Byte 1's values from 1, in order. A machine that is itself the Hyper-V root partition (VBS,
// memory integrity) is no guest and reports 0. Chosen by the lead on 2026-11-25, pending the
// human's yes: this list is the one place the values live.
export const VM_VENDORS = [
    "vmware",
    "virtualbox",
    "hyperv_guest",
    "kvm_qemu",
    "xen",
    "parallels",
    "other_hypervisor",
] as const;
export type VmVendor = (typeof VM_VENDORS)[number];

export const MODULE_SLOTS = 4;

const FLAGS = [
    "debugger",
    "hardwareBreakpoints",
    "kernelDebugging",
    "testSigning",
    "signatureEnforcementOff",
    "codeWritable",
] as const;
export type IntegrityFlag = (typeof FLAGS)[number];

export const INTEGRITY_FLAGS: readonly IntegrityFlag[] = FLAGS;

const FLAG_MASK = (1 << FLAGS.length) - 1;
const RESERVED_FROM = 4;
const HASHES_AT = 32;

export type RenewalBits = {
    readonly flags: Readonly<Record<IntegrityFlag, boolean>>;
    // Null for none.
    readonly vmVendor: VmVendor | null;
    readonly windowsBuild: number;
    // Exactly MODULE_SLOTS, as the field holds them; 0 is an unused slot.
    readonly moduleSlots: readonly bigint[];
};

// The distinct unsigned modules the slots name, ascending.
export function unsignedModulesOf(bits: RenewalBits): readonly bigint[] {
    return [...new Set(bits.moduleSlots.filter((slot) => slot !== 0n))].sort((a, b) =>
        a < b ? -1 : 1,
    );
}

export function toRenewalBitsBytes(bits: RenewalBits): Uint8Array<ArrayBuffer> {
    invariant(
        Number.isInteger(bits.windowsBuild) &&
            bits.windowsBuild >= 0 &&
            bits.windowsBuild <= 0xffff,
        "windows build",
    );
    invariant(
        bits.moduleSlots.length === MODULE_SLOTS &&
            bits.moduleSlots.every((slot) => slot >= 0n && slot <= 0xffff_ffff_ffff_ffffn),
        "module slots",
    );
    const out = createWriter();
    out.u8(FLAGS.reduce((byte, flag, bit) => (bits.flags[flag] ? byte | (1 << bit) : byte), 0));
    out.u8(bits.vmVendor === null ? 0 : VM_VENDORS.indexOf(bits.vmVendor) + 1);
    out.u16(bits.windowsBuild);
    out.bytes(new Uint8Array(HASHES_AT - RESERVED_FROM));
    for (const slot of bits.moduleSlots) {
        out.u64(slot);
    }
    const bytes = out.finish();
    invariant(bytes.byteLength === SIGNALS_SIZE, "signals size");
    return bytes;
}

// Canonical or nothing: 64 bytes, bits 6 and 7 of byte 0 and bytes 4 to 31 zero, a known vendor.
export function parseRenewalBits(signals: Uint8Array): Result<RenewalBits, FormatError> {
    if (signals.byteLength !== SIGNALS_SIZE) {
        return malformed();
    }
    const input = openReader(signals);
    const byte = input.u8();
    const vendor = input.u8();
    const windowsBuild = input.u16();
    const reserved = input.bytes(HASHES_AT - RESERVED_FROM);
    if (
        (byte & ~FLAG_MASK) !== 0 ||
        vendor > VM_VENDORS.length ||
        reserved.some((value) => value !== 0)
    ) {
        return malformed();
    }
    const moduleSlots: bigint[] = [];
    for (let slot = 0; slot < MODULE_SLOTS; slot += 1) {
        moduleSlots.push(input.u64());
    }
    const set = (flag: IntegrityFlag) => (byte & (1 << FLAGS.indexOf(flag))) !== 0;
    const flags = {
        debugger: set("debugger"),
        hardwareBreakpoints: set("hardwareBreakpoints"),
        kernelDebugging: set("kernelDebugging"),
        testSigning: set("testSigning"),
        signatureEnforcementOff: set("signatureEnforcementOff"),
        codeWritable: set("codeWritable"),
    };
    return finish(input, {
        flags,
        vmVendor: VM_VENDORS[vendor - 1] ?? null,
        windowsBuild,
        moduleSlots,
    });
}
