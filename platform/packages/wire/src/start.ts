import { compareModules, type ModuleKey } from "@lucent/bundle/fact-set";
import {
    createWriter,
    type FormatError,
    malformed,
    openReader,
    type Reader,
    type Writer,
} from "@lucent/bundle/wire";
import { invariant } from "@lucent/core/contain";
import { ok, type Result } from "@lucent/core/result";
import { finish, ID_SIZE, readContext, readProduct, writeContext, writeProduct } from "./codec.ts";

// POST /v1/starts, as native/libs/wire/src/start.cpp reads and writes it.
//
// Version 1 on the wire:
//   request: context "lucent start request v1" (32), u8 channel, loader release id (16),
//     u8 product size, product, u8 module count, then per module: u64 name hash,
//     u32 time-date stamp, u32 size of image (as fact sets carry them).
//   reply: context "lucent start reply v1" (32), start id (16), container key (32),
//     u32 release seal size, release seal.

const REQUEST_VERSION = 1;
const REPLY_VERSION = 1;

export const MAX_START_MODULES = 64;
export const CONTAINER_KEY_SIZE = 32;
export const MAX_RELEASE_SEAL_SIZE = 1 << 20;

const MODULE_KEY_SIZE = 16;

export type Channel = "stable" | "alpha" | "debug";

const CHANNELS: readonly Channel[] = ["stable", "alpha", "debug"];

export type StartRequest = {
    readonly product: string;
    readonly channel: Channel;
    readonly loaderRelease: Uint8Array;
    // Sorted and unique.
    readonly modules: readonly ModuleKey[];
};

export type StartReply = {
    readonly start: Uint8Array;
    readonly containerKey: Uint8Array;
    // The release seal (the release's offline-signed artifact list), opaque here.
    readonly releaseSeal: Uint8Array;
};

// Sorted ascending without repeats, within MAX_START_MODULES.
export function isModuleList(modules: readonly ModuleKey[]): boolean {
    return (
        modules.length <= MAX_START_MODULES &&
        modules.every((module, index) => {
            const previous = modules[index - 1];
            return previous === undefined || compareModules(previous, module) < 0;
        })
    );
}

// A module list: u8 count, then per module u64 name hash, u32 time-date stamp, u32 size of image.
export function writeModules(out: Writer, modules: readonly ModuleKey[]): void {
    invariant(isModuleList(modules), "modules aren't sorted and unique within the bound");
    out.u8(modules.length);
    for (const module of modules) {
        out.u64(module.nameHash);
        out.u32(module.timeDateStamp);
        out.u32(module.sizeOfImage);
    }
}

// Sorted, unique, at most MAX_START_MODULES, or malformed.
export function readModules(input: Reader): Result<ModuleKey[], FormatError> {
    if (input.remaining() < 1) {
        return malformed();
    }
    const count = input.u8();
    if (count > MAX_START_MODULES || input.remaining() < count * MODULE_KEY_SIZE) {
        return malformed();
    }
    const modules: ModuleKey[] = [];
    for (let index = 0; index < count; index += 1) {
        modules.push({
            nameHash: input.u64(),
            timeDateStamp: input.u32(),
            sizeOfImage: input.u32(),
        });
    }
    return isModuleList(modules) ? ok(modules) : malformed();
}

export function toStartRequestBytes(request: StartRequest): Uint8Array<ArrayBuffer> {
    invariant(request.loaderRelease.byteLength === ID_SIZE, "release id size");

    const out = createWriter();
    writeContext(out, "start request", REQUEST_VERSION);
    out.u8(CHANNELS.indexOf(request.channel));
    out.bytes(request.loaderRelease);
    writeProduct(out, request.product);
    writeModules(out, request.modules);
    return out.finish();
}

// Canonical or nothing: a valid product id, a known channel, modules sorted and unique.
export function parseStartRequest(bytes: Uint8Array): Result<StartRequest, FormatError> {
    const input = openReader(bytes);
    const context = readContext(input, "start request", REQUEST_VERSION);
    if (!context.ok) {
        return context;
    }
    if (input.remaining() < 1 + ID_SIZE) {
        return malformed();
    }
    const channel = CHANNELS[input.u8()];
    const loaderRelease = input.bytes(ID_SIZE);
    const product = readProduct(input);
    if (!product.ok) {
        return product;
    }
    if (channel === undefined) {
        return malformed();
    }
    const modules = readModules(input);
    if (!modules.ok) {
        return modules;
    }
    return finish(input, {
        product: product.value,
        channel,
        loaderRelease,
        modules: modules.value,
    });
}

export function toStartReplyBytes(reply: StartReply): Uint8Array<ArrayBuffer> {
    invariant(reply.start.byteLength === ID_SIZE, "start id size");
    invariant(reply.containerKey.byteLength === CONTAINER_KEY_SIZE, "container key size");
    invariant(
        reply.releaseSeal.byteLength > 0 && reply.releaseSeal.byteLength <= MAX_RELEASE_SEAL_SIZE,
        "release seal size",
    );
    const out = createWriter();
    writeContext(out, "start reply", REPLY_VERSION);
    out.bytes(reply.start);
    out.bytes(reply.containerKey);
    out.u32(reply.releaseSeal.byteLength);
    out.bytes(reply.releaseSeal);
    return out.finish();
}

// Canonical or nothing: a release seal of 1 byte to 1 MiB, nothing trailing.
export function parseStartReply(bytes: Uint8Array): Result<StartReply, FormatError> {
    const input = openReader(bytes);
    const context = readContext(input, "start reply", REPLY_VERSION);
    if (!context.ok) {
        return context;
    }
    if (input.remaining() < ID_SIZE + CONTAINER_KEY_SIZE + 4) {
        return malformed();
    }
    const start = input.bytes(ID_SIZE);
    const containerKey = input.bytes(CONTAINER_KEY_SIZE);
    const size = input.u32();
    if (size === 0 || size > MAX_RELEASE_SEAL_SIZE || input.remaining() < size) {
        return malformed();
    }
    return finish(input, { start, containerKey, releaseSeal: input.bytes(size) });
}
