import { rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { describeUnknownError, ignoreErrors, tryAsync } from "@lucent/core/contain";
import { err, ok, type Result } from "@lucent/core/result";
import type { CryptoRng } from "@lucent/core/rng";

// Resource bytes in ARTIFACT_DIR, named by their BLAKE2b-256 digest in hex, as ops
// publish-loader names the loader's. An upload streams to a temporary name while it is hashed
// and counted, and takes its digest's name only once whole: a file under a digest is always
// complete, and the same bytes uploaded twice are one file.

export const RESOURCE_MAX_BYTES = 64 * 1024 * 1024;

export const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

export type StoredFile = { readonly digest: string; readonly size: number };

export type StoreRefusal =
    | { readonly code: "PAYLOAD_TOO_LARGE" }
    | { readonly code: "EMPTY_FILE" }
    | { readonly code: "STORAGE_FAILED"; readonly detail: string };

export async function storeResourceFile(params: {
    readonly artifactDir: string;
    readonly body: ReadableStream<Uint8Array>;
    readonly rng: CryptoRng;
}): Promise<Result<StoredFile, StoreRefusal>> {
    const temporary = join(
        params.artifactDir,
        `.upload-${params.rng.fillBytes(new Uint8Array(16)).toHex()}`,
    );
    const failed = (cause: unknown): StoreRefusal => ({
        code: "STORAGE_FAILED",
        detail: describeUnknownError(cause),
    });
    const reader = params.body.getReader();
    const written = await tryAsync(async () => {
        const sink = Bun.file(temporary).writer();
        const hasher = new Bun.CryptoHasher("blake2b256");
        let size = 0;
        for (;;) {
            const step = await reader.read();
            if (step.done) break;
            size += step.value.byteLength;
            if (size > RESOURCE_MAX_BYTES) {
                await reader.cancel();
                await sink.end();
                return null;
            }
            hasher.update(step.value);
            sink.write(step.value);
        }
        await sink.end();
        return { digest: hasher.digest("hex"), size };
    }, failed);
    const kept = written.ok ? written.value : null;
    if (kept === null || kept.size === 0) {
        await ignoreErrors(() => rm(temporary, { force: true }));
        if (!written.ok) return written;
        return err(kept === null ? { code: "PAYLOAD_TOO_LARGE" } : { code: "EMPTY_FILE" });
    }
    const named = await tryAsync(
        () => rename(temporary, join(params.artifactDir, kept.digest)),
        failed,
    );
    if (!named.ok) {
        await ignoreErrors(() => rm(temporary, { force: true }));
        return named;
    }
    return ok(kept);
}

// The stored file's size, or null when nothing is stored under the digest.
export async function findResourceFile(
    artifactDir: string,
    digest: string,
): Promise<number | null> {
    if (!DIGEST_PATTERN.test(digest)) return null;
    const file = Bun.file(join(artifactDir, digest));
    const exists = await tryAsync(
        () => file.exists(),
        () => false,
    );
    return exists.ok && exists.value ? file.size : null;
}

export function openResourceFile(artifactDir: string, digest: string) {
    return Bun.file(join(artifactDir, digest));
}
