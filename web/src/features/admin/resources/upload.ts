import { tryAsync } from "@lucent/core/contain";
import type { RefusalCode } from "../../../copy/refusals.ts";
import type { Outcome } from "../../../server/outcome.ts";

// The browser's half of an upload: the file goes as it is, in one POST to web's upload route,
// which streams it on to platform. A server function would hold all of it in memory first.
const UPLOAD_PATH = "/admin/resources/upload";
// As long as web gives the upload; a slower line has to try again.
const UPLOAD_DEADLINE_MS = 10 * 60 * 1_000;

export type Stored = { readonly digest: string; readonly size: number };

const unexpected: Outcome<never> = {
    ok: false,
    refused: { code: "SERVICE_UNAVAILABLE", reference: null },
};

// The route answers an Outcome as JSON; anything else is web or the network failing.
function parseAnswer(value: unknown): Outcome<Stored> {
    if (typeof value !== "object" || value === null || !("ok" in value)) return unexpected;
    if (value.ok === true && "value" in value) {
        const stored = value.value;
        if (
            typeof stored === "object" &&
            stored !== null &&
            "digest" in stored &&
            typeof stored.digest === "string" &&
            "size" in stored &&
            typeof stored.size === "number"
        ) {
            return { ok: true, value: { digest: stored.digest, size: stored.size } };
        }
    }
    if (value.ok === false && "refused" in value) {
        const refused = value.refused;
        if (typeof refused === "object" && refused !== null && "code" in refused) {
            const reference =
                "reference" in refused && typeof refused.reference === "string"
                    ? refused.reference
                    : null;
            const code = typeof refused.code === "string" ? knownCode(refused.code) : null;
            if (code !== null) return { ok: false, refused: { code, reference } };
        }
    }
    return unexpected;
}

// What the route answers; anything else reads as unexpected.
const KNOWN: readonly RefusalCode[] = [
    "SERVICE_UNAVAILABLE",
    "SESSION_INVALID",
    "FORBIDDEN",
    "STEP_UP_REQUIRED",
    "PAYLOAD_TOO_LARGE",
    "INVALID_REQUEST",
];

function knownCode(code: string): RefusalCode {
    return KNOWN.find((known) => known === code) ?? "SERVICE_UNAVAILABLE";
}

export async function uploadFile(file: File): Promise<Outcome<Stored>> {
    const sent = await tryAsync(
        async (): Promise<unknown> => {
            const res = await fetch(UPLOAD_PATH, {
                method: "POST",
                headers: { "content-type": "application/octet-stream" },
                body: file,
                signal: AbortSignal.timeout(UPLOAD_DEADLINE_MS),
            });
            return await res.json();
        },
        () => null,
    );
    return sent.ok ? parseAnswer(sent.value) : unexpected;
}
