import { join } from "node:path";
import { z } from "zod";

// How the tests read the vectors native/libs/wire and native/libs/crypto wrote into contracts/.

const CONTRACTS = join(import.meta.dir, "..", "..", "..", "..", "contracts");

export function readContractFile(contract: string, file: string): Promise<Uint8Array> {
    return Bun.file(join(CONTRACTS, contract, "v1", file)).bytes();
}

export function readContractJson(contract: string, file: string): Promise<unknown> {
    return Bun.file(join(CONTRACTS, contract, "v1", file)).json();
}

export const hexBytes = (size: number) =>
    z
        .string()
        .regex(new RegExp(`^[0-9a-f]{${2 * size}}$`))
        .transform((text) => Uint8Array.fromHex(text));

export const hexAny = z
    .string()
    .regex(/^(?:[0-9a-f]{2})*$/)
    .transform((text) => Uint8Array.fromHex(text));

export const hexU64 = z
    .string()
    .regex(/^[0-9a-f]{16}$/)
    .transform((text) => BigInt(`0x${text}`));

export const hexU32 = z
    .string()
    .regex(/^[0-9a-f]{8}$/)
    .transform((text) => Number.parseInt(text, 16));

export const bigintNumber = z
    .number()
    .int()
    .nonnegative()
    .transform((value) => BigInt(value));
