import { tryAsync } from "@lucent/core/contain";
import type { RefusalCode } from "../../copy/refusals.ts";
import type { Outcome } from "../../server/outcome.ts";

// The browser's half of a banner upload: the file goes as it is, in one POST to web's route,
// which streams it on to platform. Which formats count is platform's to say from the bytes; the
// picker's `accept` only narrows what the browser offers.
const UPLOAD_PATH = "/banner/upload";
const UPLOAD_DEADLINE_MS = 60 * 1_000;
export const BANNER_ACCEPT = "image/jpeg,image/png,image/webp";
export const BANNER_MAX_BYTES = 512 * 1024;

const unexpected: Outcome<never> = {
    ok: false,
    refused: { code: "SERVICE_UNAVAILABLE", reference: null },
};

// What the route answers; any other code reads as unexpected.
const KNOWN: readonly RefusalCode[] = [
    "SERVICE_UNAVAILABLE",
    "SESSION_INVALID",
    "POSTING_RESTRICTED",
    "PROFILE_REMOVED",
    "IMAGE_TOO_LARGE",
    "NOT_AN_IMAGE",
    "IMAGE_UNDECODABLE",
    "IMAGE_TIMED_OUT",
    "INVALID_REQUEST",
    "THROTTLED",
];

function parseAnswer(value: unknown): Outcome<null> {
    if (typeof value !== "object" || value === null || !("ok" in value)) return unexpected;
    if (value.ok === true) return { ok: true, value: null };
    if (!("refused" in value)) return unexpected;
    const refused = value.refused;
    if (typeof refused !== "object" || refused === null || !("code" in refused)) return unexpected;
    const code = KNOWN.find((known) => known === refused.code);
    if (code === undefined) return unexpected;
    const reference =
        "reference" in refused && typeof refused.reference === "string" ? refused.reference : null;
    return { ok: false, refused: { code, reference } };
}

export async function uploadBanner(file: File): Promise<Outcome<null>> {
    if (file.size > BANNER_MAX_BYTES) {
        return { ok: false, refused: { code: "IMAGE_TOO_LARGE", reference: null } };
    }
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
