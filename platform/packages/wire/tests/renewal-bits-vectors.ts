import { join } from "node:path";
import { type RenewalBits, toRenewalBitsBytes } from "../src/renewal-bits.ts";
import { toVectorJson } from "./cloud-vectors.ts";

// What contracts/wire/v1/renewal_bits_* hold, made by this side's encoder: native has no
// generator for them. `bun tests/renewal-bits-vectors.ts` writes them; renewal-bits.test.ts checks
// the committed files equal what this makes.

export type RenewalBitsVector = { readonly bytes: Uint8Array; readonly json: unknown };

const hex64 = (value: bigint) => value.toString(16).padStart(16, "0");

const NONE = {
    debugger: false,
    hardwareBreakpoints: false,
    kernelDebugging: false,
    testSigning: false,
    signatureEnforcementOff: false,
    codeWritable: false,
} as const;

function bitsJson(bits: RenewalBits): unknown {
    return {
        debugger: bits.flags.debugger,
        hardware_breakpoints: bits.flags.hardwareBreakpoints,
        kernel_debugging: bits.flags.kernelDebugging,
        test_signing: bits.flags.testSigning,
        signature_enforcement_off: bits.flags.signatureEnforcementOff,
        code_writable: bits.flags.codeWritable,
        vm_vendor: bits.vmVendor,
        windows_build: bits.windowsBuild,
        module_slots: bits.moduleSlots.map(hex64),
    };
}

export function renewalBitsVectors(): Readonly<Record<string, RenewalBitsVector>> {
    const table: Readonly<Record<string, RenewalBits>> = {
        // What a module on a clean machine sends, and what every module sent before slice 3.
        renewal_bits_clean: {
            flags: NONE,
            vmVendor: null,
            windowsBuild: 0,
            moduleSlots: [0n, 0n, 0n, 0n],
        },
        // Every flag, the last vendor, a build above 0xff so its bytes' order shows, and all four
        // slots out of order, the largest with its top bit set.
        renewal_bits_everything: {
            flags: {
                debugger: true,
                hardwareBreakpoints: true,
                kernelDebugging: true,
                testSigning: true,
                signatureEnforcementOff: true,
                codeWritable: true,
            },
            vmVendor: "other_hypervisor",
            windowsBuild: 26_100,
            moduleSlots: [
                0xfedc_ba98_7654_3210n,
                0x0000_0000_0000_0001n,
                0x7fff_ffff_ffff_ffffn,
                0x0123_4567_89ab_cdefn,
            ],
        },
        // One flag, a Hyper-V guest, and one module named twice around an unused slot.
        renewal_bits_some: {
            flags: { ...NONE, testSigning: true },
            vmVendor: "hyperv_guest",
            windowsBuild: 19_045,
            moduleSlots: [0n, 0x5a5a_0000_0000_a5a5n, 0n, 0x5a5a_0000_0000_a5a5n],
        },
    };
    return Object.fromEntries(
        Object.entries(table).map(([name, bits]) => [
            name,
            { bytes: toRenewalBitsBytes(bits), json: bitsJson(bits) },
        ]),
    );
}

if (import.meta.main) {
    const out = join(import.meta.dir, "..", "..", "..", "..", "contracts", "wire", "v1");
    for (const [name, vector] of Object.entries(renewalBitsVectors())) {
        await Bun.write(join(out, `${name}.bin`), vector.bytes);
        await Bun.write(join(out, `${name}.json`), toVectorJson(vector.json));
    }
}
