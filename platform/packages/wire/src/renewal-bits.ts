import { createWriter, type FormatError, malformed, openReader } from "@lucent/bundle/wire";
import { invariant } from "@lucent/core/contain";
import type { Result } from "@lucent/core/result";
import { finish } from "./codec.ts";
import { SIGNALS_SIZE } from "./lease.ts";

// The renewal's 64-byte signals field (lease.ts), as the module fills it each renewal:
//   byte 0, bits 0 to 5: a debugger on the game, host or loader; hardware breakpoints; kernel
//     debugging; test signing; driver signature enforcement off; code pages writable. Bits 6 and
//     7 are zero.
//   byte 1: VM vendor, 0 for none.
//   bytes 2 to 3: the Windows build, u16.
//   bytes 4 to 31: reserved, zero.
//   bytes 32 to 63: four u64 slots, each the first 8 bytes of an unsigned module's BLAKE2b hash
//     read little-endian; unused slots are zero.
// A set reserved bit or byte is MALFORMED.
//
// Provenance: approved by the human on 2026-11-25 as packet 04b's layout. The golden vectors
// contracts/wire/v1/renewal_bits_* were produced by this encoder, not by native/libs/wire;
// native's encoder and decoder must match them byte for byte.
//
// Beyond the layout, this side reads the hash slots canonically: the used ones first, ascending
// and unique, so one set of modules has one encoding. The VM vendor's values are not assigned
// yet: it is read as an opaque byte, and no vector names one but 0.

export const MAX_UNSIGNED_MODULES = 4;

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
    // 0 for none.
    readonly vmVendor: number;
    readonly windowsBuild: number;
    // Ascending, unique, never 0.
    readonly unsignedModules: readonly bigint[];
};

function isModuleList(hashes: readonly bigint[]): boolean {
    return (
        hashes.length <= MAX_UNSIGNED_MODULES &&
        hashes.every(
            (hash, index) =>
                hash > 0n &&
                hash <= 0xffff_ffff_ffff_ffffn &&
                (index === 0 || (hashes[index - 1] ?? hash) < hash),
        )
    );
}

export function toRenewalBitsBytes(bits: RenewalBits): Uint8Array<ArrayBuffer> {
    invariant(
        Number.isInteger(bits.vmVendor) && bits.vmVendor >= 0 && bits.vmVendor <= 0xff,
        "vendor",
    );
    invariant(
        Number.isInteger(bits.windowsBuild) &&
            bits.windowsBuild >= 0 &&
            bits.windowsBuild <= 0xffff,
        "windows build",
    );
    invariant(isModuleList(bits.unsignedModules), "unsigned modules aren't canonical");
    const out = createWriter();
    out.u8(FLAGS.reduce((byte, flag, bit) => (bits.flags[flag] ? byte | (1 << bit) : byte), 0));
    out.u8(bits.vmVendor);
    out.u16(bits.windowsBuild);
    out.bytes(new Uint8Array(HASHES_AT - RESERVED_FROM));
    for (let slot = 0; slot < MAX_UNSIGNED_MODULES; slot += 1) {
        out.u64(bits.unsignedModules[slot] ?? 0n);
    }
    const bytes = out.finish();
    invariant(bytes.byteLength === SIGNALS_SIZE, "signals size");
    return bytes;
}

// Canonical or nothing: 64 bytes, bits 6 and 7 of byte 0 and bytes 4 to 31 zero, the used hash
// slots first, ascending and unique.
export function parseRenewalBits(signals: Uint8Array): Result<RenewalBits, FormatError> {
    if (signals.byteLength !== SIGNALS_SIZE) {
        return malformed();
    }
    const input = openReader(signals);
    const byte = input.u8();
    const vmVendor = input.u8();
    const windowsBuild = input.u16();
    const reserved = input.bytes(HASHES_AT - RESERVED_FROM);
    if ((byte & ~FLAG_MASK) !== 0 || reserved.some((value) => value !== 0)) {
        return malformed();
    }
    const slots: bigint[] = [];
    for (let slot = 0; slot < MAX_UNSIGNED_MODULES; slot += 1) {
        slots.push(input.u64());
    }
    const used = slots.findIndex((hash) => hash === 0n);
    const unsignedModules = used === -1 ? slots : slots.slice(0, used);
    if (slots.slice(unsignedModules.length).some((hash) => hash !== 0n)) {
        return malformed();
    }
    if (!isModuleList(unsignedModules)) {
        return malformed();
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
    return finish(input, { flags, vmVendor, windowsBuild, unsignedModules });
}
