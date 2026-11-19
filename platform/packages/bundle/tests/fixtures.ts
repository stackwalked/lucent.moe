import { join } from "node:path";
import { z } from "zod";
import { type FactEntry, fromLiteral } from "../src/fact-set.ts";

// What native/libs/bundle/tests/fixtures.hpp derives the vectors from, and how the tests read
// the vectors in contracts/ that it wrote.

const CONTRACTS = join(import.meta.dir, "..", "..", "..", "..", "contracts");

export function readContractFile(contract: string, file: string): Promise<Uint8Array> {
    return Bun.file(join(CONTRACTS, contract, "v1", file)).bytes();
}

export function readContractJson(contract: string, file: string): Promise<unknown> {
    return Bun.file(join(CONTRACTS, contract, "v1", file)).json();
}

// The same at another version, such as "release-manifest" / "v2".
export function readVersionedFile(
    contract: string,
    version: string,
    file: string,
): Promise<Uint8Array> {
    return Bun.file(join(CONTRACTS, contract, version, file)).bytes();
}

export function readVersionedJson(
    contract: string,
    version: string,
    file: string,
): Promise<unknown> {
    return Bun.file(join(CONTRACTS, contract, version, file)).json();
}

// RFC 8032's test keys 1 and 2: the vectors' signer, and a key that signed none of them.
export const SIGNER_PUBLIC_KEY = Uint8Array.fromHex(
    "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
);
export const OTHER_PUBLIC_KEY = Uint8Array.fromHex(
    "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c",
);

// `size` literal entries; key and value follow from the index, as fixtures::fact_set_of has them.
export function entriesOf(size: number): FactEntry[] {
    return Array.from({ length: size }, (_, index) =>
        fromLiteral(0x1000n + BigInt(index) * 0x10n, 0xa000n + BigInt(index)),
    );
}

export const hexBytes = (size: number) =>
    z
        .string()
        .regex(new RegExp(`^[0-9a-f]{${2 * size}}$`))
        .transform((text) => Uint8Array.fromHex(text));

export const hexU64 = z
    .string()
    .regex(/^[0-9a-f]{16}$/)
    .transform((text) => BigInt(`0x${text}`));

export const hexU32 = z
    .string()
    .regex(/^[0-9a-f]{8}$/)
    .transform((text) => Number.parseInt(text, 16));
