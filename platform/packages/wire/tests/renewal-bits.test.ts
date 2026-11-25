import { expect, test } from "bun:test";
import { join } from "node:path";
import { z } from "zod";
import { SIGNALS_SIZE } from "../src/lease.ts";
import { parseRenewalBits, type RenewalBits, toRenewalBitsBytes } from "../src/renewal-bits.ts";
import { toVectorJson } from "./cloud-vectors.ts";
import { hexU64, readContractFile, readContractJson } from "./fixtures.ts";
import { renewalBitsVectors } from "./renewal-bits-vectors.ts";

const contractPath = (file: string) =>
    join(import.meta.dir, "..", "..", "..", "..", "contracts", "wire", "v1", file);

// contracts/wire/v1/renewal_bits_*, produced by src/renewal-bits.ts's encoder through
// renewal-bits-vectors.ts; native/libs/wire must match them. The refusals below patch bytes at
// offsets written out here, so they state the layout independently of the encoder.

const MALFORMED = { ok: false, error: { code: "MALFORMED" } } as const;

const NAMES = ["renewal_bits_clean", "renewal_bits_everything", "renewal_bits_some"];

const BitsVector = z
    .strictObject({
        debugger: z.boolean(),
        hardware_breakpoints: z.boolean(),
        kernel_debugging: z.boolean(),
        test_signing: z.boolean(),
        signature_enforcement_off: z.boolean(),
        code_writable: z.boolean(),
        vm_vendor: z.number().int(),
        windows_build: z.number().int(),
        unsigned_modules: z.array(hexU64),
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
            unsignedModules: json.unsigned_modules,
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

test("an all-zero field is a clean machine", () => {
    expect(parseRenewalBits(new Uint8Array(SIGNALS_SIZE))).toEqual({
        ok: true,
        value: {
            flags: {
                debugger: false,
                hardwareBreakpoints: false,
                kernelDebugging: false,
                testSigning: false,
                signatureEnforcementOff: false,
                codeWritable: false,
            },
            vmVendor: 0,
            windowsBuild: 0,
            unsignedModules: [],
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

test("the VM vendor is any byte until its values are assigned, and the build is a u16", () => {
    for (const vendor of [1, 7, 0xff]) {
        const parsed = parseRenewalBits(withByte(new Uint8Array(SIGNALS_SIZE), 1, vendor));

        expect(parsed.ok && parsed.value.vmVendor).toBe(vendor);
    }
    const build = withByte(withByte(new Uint8Array(SIGNALS_SIZE), 2, 0xf4), 3, 0x65);
    const parsed = parseRenewalBits(build);
    expect(parsed.ok && parsed.value.windowsBuild).toBe(26_100);
});

test("the used hash slots come first, ascending and unique", () => {
    const table: readonly [string, readonly bigint[], boolean][] = [
        ["none", [0n, 0n, 0n, 0n], true],
        ["one in the first slot", [5n, 0n, 0n, 0n], true],
        ["four ascending", [1n, 2n, 3n, 0xffff_ffff_ffff_ffffn], true],
        ["one in a later slot", [0n, 5n, 0n, 0n], false],
        ["one in the last slot", [0n, 0n, 0n, 0x8000_0000_0000_0000n], false],
        ["a gap between two", [5n, 0n, 6n, 0n], false],
        ["descending", [6n, 5n, 0n, 0n], false],
        ["a repeat", [5n, 5n, 0n, 0n], false],
        ["ascending by bytes but not as u64", [0x0100n, 0x02n, 0n, 0n], false],
    ];
    for (const [label, slots, valid] of table) {
        const parsed = parseRenewalBits(withSlots(slots));

        expect({ label, ok: parsed.ok }).toEqual({ label, ok: valid });
        if (parsed.ok) {
            expect(parsed.value.unsignedModules).toEqual(slots.filter((slot) => slot !== 0n));
            expect(toRenewalBitsBytes(parsed.value)).toEqual(withSlots(slots));
        }
    }
});
