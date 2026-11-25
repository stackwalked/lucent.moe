import { join } from "node:path";
import { type RenewalBits, toRenewalBitsBytes } from "../src/renewal-bits.ts";
import { toVectorJson } from "./cloud-vectors.ts";

// What contracts/wire/v1/renewal_bits_* hold, made by this side's encoder: native has no
// generator for them. `bun tests/renewal-bits-vectors.ts` writes them; renewal-bits.test.ts checks
// the committed files equal what this makes. No vector names a VM vendor but 0 until the lead
// fixes its values.

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
        unsigned_modules: bits.unsignedModules.map(hex64),
    };
}

export function renewalBitsVectors(): Readonly<Record<string, RenewalBitsVector>> {
    const table: Readonly<Record<string, RenewalBits>> = {
        // What a module on a clean machine sends, and what every module sent before slice 3.
        renewal_bits_clean: { flags: NONE, vmVendor: 0, windowsBuild: 0, unsignedModules: [] },
        // Every flag, a build above 0xff so its bytes' order shows, and all four slots, the
        // largest with its top bit set.
        renewal_bits_everything: {
            flags: {
                debugger: true,
                hardwareBreakpoints: true,
                kernelDebugging: true,
                testSigning: true,
                signatureEnforcementOff: true,
                codeWritable: true,
            },
            vmVendor: 0,
            windowsBuild: 26_100,
            unsignedModules: [
                0x0000_0000_0000_0001n,
                0x0123_4567_89ab_cdefn,
                0x7fff_ffff_ffff_ffffn,
                0xfedc_ba98_7654_3210n,
            ],
        },
        // One flag and one module: the other slots stay zero.
        renewal_bits_some: {
            flags: { ...NONE, testSigning: true },
            vmVendor: 0,
            windowsBuild: 19_045,
            unsignedModules: [0x5a5a_0000_0000_a5a5n],
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
