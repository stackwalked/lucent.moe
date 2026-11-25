import { expect, test } from "bun:test";
import { join } from "node:path";
import { z } from "zod";
import { SIGNALS_SIZE } from "../src/lease.ts";
import {
    parseRenewalBits,
    type RenewalBits,
    toRenewalBitsBytes,
    unsignedModulesOf,
    VM_VENDORS,
} from "../src/renewal-bits.ts";
import { toVectorJson } from "./cloud-vectors.ts";
import { hexBytes, hexU64, readContractFile, readContractJson } from "./fixtures.ts";
import { renewalBitsVectors } from "./renewal-bits-vectors.ts";

const contractPath = (file: string) =>
    join(import.meta.dir, "..", "..", "..", "..", "contracts", "wire", "v1", file);

// contracts/wire/v1/renewal_bits_*, produced by src/renewal-bits.ts's encoder through
// renewal-bits-vectors.ts; native/libs/wire must match them. The refusals below patch bytes at
// offsets written out here, so they state the layout independently of the encoder.

const MALFORMED = { ok: false, error: { code: "MALFORMED" } } as const;

const NAMES = ["renewal_bits_clean", "renewal_bits_everything", "renewal_bits_some"];

const CLEAN_FLAGS = {
    debugger: false,
    hardwareBreakpoints: false,
    kernelDebugging: false,
    testSigning: false,
    signatureEnforcementOff: false,
    codeWritable: false,
} as const;

const BitsVector = z
    .strictObject({
        debugger: z.boolean(),
        hardware_breakpoints: z.boolean(),
        kernel_debugging: z.boolean(),
        test_signing: z.boolean(),
        signature_enforcement_off: z.boolean(),
        code_writable: z.boolean(),
        vm_vendor: z.enum(VM_VENDORS).nullable(),
        windows_build: z.number().int(),
        module_slots: z.array(hexU64).length(4),
    })
    .transform(
        (json): RenewalBits => ({
            flags: {
                debugger: json.debugger,
                hardwareBreakpoints: json.hardware_breakpoints,
                kernelDebugging: json.kernel_debugging,
                testSigning: json.test_signing,
                signatureEnforcementOff: json.signature_enforcement_off,
                codeWritable: json.code_writable,
            },
            vmVendor: json.vm_vendor,
            windowsBuild: json.windows_build,
            moduleSlots: json.module_slots,
        }),
    );

async function bytesOf(name: string): Promise<Uint8Array<ArrayBuffer>> {
    return new Uint8Array(await readContractFile("wire", `${name}.bin`));
}

function withByte(bytes: Uint8Array, offset: number, value: number): Uint8Array {
    const out = bytes.slice();
    out[offset] = value;
    return out;
}

// The field with these u64s in its four hash slots (32, 40, 48, 56).
function withSlots(slots: readonly bigint[]): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(SIGNALS_SIZE);
    const view = new DataView(out.buffer);
    slots.forEach((slot, index) => {
        view.setBigUint64(32 + index * 8, slot, true);
    });
    return out;
}

test("the committed renewal bits vectors are what renewal-bits-vectors.ts makes", async () => {
    const made = renewalBitsVectors();

    expect(Object.keys(made).sort()).toEqual(NAMES);
    for (const [name, vector] of Object.entries(made)) {
        expect(await bytesOf(name)).toEqual(new Uint8Array(vector.bytes));
        expect(await Bun.file(contractPath(`${name}.json`)).text()).toBe(toVectorJson(vector.json));
    }
});

test("the renewal bits vectors decode to what they state, and encode back to their bytes", async () => {
    for (const name of NAMES) {
        const bytes = await bytesOf(name);
        const stated = BitsVector.parse(await readContractJson("wire", `${name}.json`));

        expect(parseRenewalBits(bytes)).toEqual({ ok: true, value: stated });
        expect(toRenewalBitsBytes(stated)).toEqual(bytes);
    }
});

// native/libs/wire made renewal_frame and its field before the layout was assigned; the two
// sides stay pinned to each other through it.
test("native's renewal_frame vector carries a field this side reads: a debugger, one hash in slot 4", async () => {
    const stated = z
        .object({ renewal: z.object({ signals: hexBytes(SIGNALS_SIZE) }) })
        .parse(await readContractJson("wire", "renewal_frame.json"));
    const parsed = parseRenewalBits(stated.renewal.signals);

    expect(parsed).toEqual({
        ok: true,
        value: {
            flags: { ...CLEAN_FLAGS, debugger: true },
            vmVendor: null,
            windowsBuild: 0,
            moduleSlots: [0n, 0n, 0n, 0x8000_0000_0000_0000n],
        },
    });
    expect(parsed.ok && unsignedModulesOf(parsed.value)).toEqual([0x8000_0000_0000_0000n]);
});

test("an all-zero field is a clean machine", () => {
    expect(parseRenewalBits(new Uint8Array(SIGNALS_SIZE))).toEqual({
        ok: true,
        value: {
            flags: CLEAN_FLAGS,
            vmVendor: null,
            windowsBuild: 0,
            moduleSlots: [0n, 0n, 0n, 0n],
        },
    });
});

test("the field is exactly 64 bytes", () => {
    expect(parseRenewalBits(new Uint8Array(SIGNALS_SIZE - 1))).toEqual(MALFORMED);
    expect(parseRenewalBits(new Uint8Array(SIGNALS_SIZE + 1))).toEqual(MALFORMED);
});

test("each of bits 0 to 5 of byte 0 is its own flag, and bits 6 and 7 are malformed", () => {
    const flags = [
        "debugger",
        "hardwareBreakpoints",
        "kernelDebugging",
        "testSigning",
        "signatureEnforcementOff",
        "codeWritable",
    ] as const;
    flags.forEach((flag, bit) => {
        const parsed = parseRenewalBits(withByte(new Uint8Array(SIGNALS_SIZE), 0, 1 << bit));

        expect(parsed.ok && Object.entries(parsed.value.flags).filter(([, set]) => set)).toEqual([
            [flag, true],
        ]);
    });
    for (const bit of [6, 7]) {
        expect(parseRenewalBits(withByte(new Uint8Array(SIGNALS_SIZE), 0, 1 << bit))).toEqual(
            MALFORMED,
        );
    }
});

test("a set byte anywhere in 4 to 31 is malformed", async () => {
    const everything = await bytesOf("renewal_bits_everything");
    for (let offset = 4; offset < 32; offset += 1) {
        expect(parseRenewalBits(withByte(everything, offset, 0x01))).toEqual(MALFORMED);
        expect(parseRenewalBits(withByte(new Uint8Array(SIGNALS_SIZE), offset, 0x80))).toEqual(
            MALFORMED,
        );
    }
});

test("the VM vendor is 0 or one of the listed ones, and the build is a u16", () => {
    const vendorOf = (byte: number) => {
        const parsed = parseRenewalBits(withByte(new Uint8Array(SIGNALS_SIZE), 1, byte));
        return parsed.ok ? parsed.value.vmVendor : "MALFORMED";
    };

    expect(vendorOf(0)).toBeNull();
    VM_VENDORS.forEach((vendor, index) => {
        expect(vendorOf(index + 1)).toBe(vendor);
    });
    expect(vendorOf(VM_VENDORS.length + 1)).toBe("MALFORMED");
    expect(vendorOf(0xff)).toBe("MALFORMED");
    const build = withByte(withByte(new Uint8Array(SIGNALS_SIZE), 2, 0xf4), 3, 0x65);
    const parsed = parseRenewalBits(build);
    expect(parsed.ok && parsed.value.windowsBuild).toBe(26_100);
});

test("the hash slots are a set held in place: any slot, any order, repeats allowed", () => {
    const table: readonly [string, readonly bigint[], readonly bigint[]][] = [
        ["none", [0n, 0n, 0n, 0n], []],
        ["one in the first slot", [5n, 0n, 0n, 0n], [5n]],
        ["one in the last slot", [0n, 0n, 0n, 0x8000_0000_0000_0000n], [0x8000_0000_0000_0000n]],
        ["a gap between two", [5n, 0n, 6n, 0n], [5n, 6n]],
        ["descending", [6n, 5n, 0n, 0n], [5n, 6n]],
        ["a repeat, counted once", [5n, 5n, 0n, 5n], [5n]],
        [
            "four distinct",
            [4n, 0xffff_ffff_ffff_ffffn, 1n, 2n],
            [1n, 2n, 4n, 0xffff_ffff_ffff_ffffn],
        ],
    ];
    for (const [label, slots, modules] of table) {
        const parsed = parseRenewalBits(withSlots(slots));

        expect({ label, slots: parsed.ok && parsed.value.moduleSlots }).toEqual({ label, slots });
        expect({ label, modules: parsed.ok && unsignedModulesOf(parsed.value) }).toEqual({
            label,
            modules,
        });
        if (parsed.ok) {
            expect(toRenewalBitsBytes(parsed.value)).toEqual(withSlots(slots));
        }
    }
});
