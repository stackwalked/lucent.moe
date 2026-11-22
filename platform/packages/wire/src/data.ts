import type { ModuleKey } from "@lucent/bundle/fact-set";
import { createWriter, type FormatError, malformed, openReader } from "@lucent/bundle/wire";
import { invariant } from "@lucent/core/contain";
import type { Result } from "@lucent/core/result";
import { finish, readContext, readFlag, writeContext } from "./codec.ts";
import { MAX_FRAME_PLAIN_SIZE } from "./frame.ts";
import { isFeatureList, MAX_FEATURES } from "./lease.ts";
import { isModuleList, readModules, writeModules } from "./start.ts";

// The data route (POST /v1/sessions/:id/data), as native/libs/wire/src/data.cpp reads and writes
// it: what the module asks the server for and what it gets, each the plaintext of a frame under
// the data route's keys. The session reply carries the first response, so a module has its bundle
// before it attaches.
//
// Version 1 on the wire:
//   request: context "lucent data request v1" (32), u8 module count, then per module: u64 name
//     hash, u32 time-date stamp, u32 size of image (as start requests carry them); u8 has features
//     (0 or 1), after 1 only u32 feature count, u64 feature ids.
//   response: context "lucent data response v1" (32), u64 data revision, u32 bundle size, the
//     bundle, u8 unsupported module count, then the modules as in the request.

const REQUEST_VERSION = 1;
const RESPONSE_VERSION = 1;

const FEATURE_SIZE = 8;

// What the module asks for. Phase 1's server ignores both lists and answers with every entry the
// session is entitled to; they are on the wire so asking for less needs no new version.
export type DataRequest = {
    // The module builds it asks for; sorted and unique.
    readonly modules: readonly ModuleKey[];
    // The feature ids it asks for (sorted, unique, never 0), or null for every entry the session is
    // entitled to.
    readonly features: readonly bigint[] | null;
};

export type DataResponse = {
    // The lease's data revision at the time this was built.
    readonly dataRevision: bigint;
    // bundle::encode_bundle's bytes, opaque here: the module decodes and verifies the bundle
    // itself. It may hold no sets.
    readonly bundle: Uint8Array;
    // The asked builds that have no fact set ("not yet supported"); sorted and unique.
    readonly unsupported: readonly ModuleKey[];
};

export function toDataRequestBytes(request: DataRequest): Uint8Array<ArrayBuffer> {
    invariant(
        request.features === null || isFeatureList(request.features),
        "features aren't sorted, unique and non-zero",
    );
    const out = createWriter();
    writeContext(out, "data request", REQUEST_VERSION);
    writeModules(out, request.modules);
    out.u8(request.features === null ? 0 : 1);
    if (request.features !== null) {
        out.u32(request.features.length);
        for (const feature of request.features) {
            out.u64(feature);
        }
    }
    return out.finish();
}

// Canonical or nothing: modules and features sorted and unique within their bounds, a feature flag
// of 0 or 1, no feature id 0, nothing trailing.
export function parseDataRequest(bytes: Uint8Array): Result<DataRequest, FormatError> {
    const input = openReader(bytes);
    const context = readContext(input, "data request", REQUEST_VERSION);
    if (!context.ok) {
        return context;
    }
    const modules = readModules(input);
    if (!modules.ok) {
        return modules;
    }
    if (input.remaining() < 1) {
        return malformed();
    }
    const hasFeatures = readFlag(input);
    if (hasFeatures === null) {
        return malformed();
    }
    if (!hasFeatures) {
        return finish(input, { modules: modules.value, features: null });
    }
    if (input.remaining() < 4) {
        return malformed();
    }
    const count = input.u32();
    if (count > MAX_FEATURES || input.remaining() < count * FEATURE_SIZE) {
        return malformed();
    }
    const features: bigint[] = [];
    for (let index = 0; index < count; index += 1) {
        features.push(input.u64());
    }
    if (!isFeatureList(features)) {
        return malformed();
    }
    return finish(input, { modules: modules.value, features });
}

export function toDataResponseBytes(response: DataResponse): Uint8Array<ArrayBuffer> {
    invariant(response.bundle.byteLength <= MAX_FRAME_PLAIN_SIZE, "bundle too large for a frame");
    invariant(isModuleList(response.unsupported), "unsupported modules aren't canonical");
    const out = createWriter();
    writeContext(out, "data response", RESPONSE_VERSION);
    out.u64(response.dataRevision);
    out.u32(response.bundle.byteLength);
    out.bytes(response.bundle);
    writeModules(out, response.unsupported);
    return out.finish();
}

// Canonical or nothing: a bundle that fits in a frame's plaintext, unsupported builds sorted and
// unique, nothing trailing.
export function parseDataResponse(bytes: Uint8Array): Result<DataResponse, FormatError> {
    const input = openReader(bytes);
    const context = readContext(input, "data response", RESPONSE_VERSION);
    if (!context.ok) {
        return context;
    }
    if (input.remaining() < 8 + 4) {
        return malformed();
    }
    const dataRevision = input.u64();
    const size = input.u32();
    if (size > MAX_FRAME_PLAIN_SIZE || input.remaining() < size) {
        return malformed();
    }
    const bundle = input.bytes(size);
    const unsupported = readModules(input);
    if (!unsupported.ok) {
        return unsupported;
    }
    return finish(input, { dataRevision, bundle, unsupported: unsupported.value });
}
