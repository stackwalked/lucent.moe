import { describeUnknownError, tryAsync } from "@lucent/core/contain";
import { toHex } from "@lucent/core/scalars";

// Whether a new password is in a known breach. "unknown" when the answer couldn't be had: the
// password is then accepted, since a third party being down shouldn't stop anyone setting one.
export type BreachCheck = (password: string) => Promise<"breached" | "clear" | "unknown">;

export const PWNED_PASSWORDS_URL = "https://api.pwnedpasswords.com/range/";

const TIMEOUT_MS = 2_000;

async function sha1Hex(text: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text));
    return toHex(new Uint8Array(digest)).toUpperCase();
}

// Have I Been Pwned's range API (k-anonymity): only the first five hex digits of the password's
// SHA-1 leave this process, and padding makes every answer about the same size, so neither the
// password nor which range held it can be told from the traffic. A padded entry has a count of 0.
export function createPwnedPasswordsCheck(params: {
    readonly baseUrl: string;
    readonly onUnavailable: (detail: string) => void;
    readonly fetch?: (req: Request) => Promise<Response>;
}): BreachCheck {
    const send = params.fetch ?? ((req: Request) => fetch(req));
    return async (password) => {
        const hash = await sha1Hex(password);
        const prefix = hash.slice(0, 5);
        const suffix = hash.slice(5);
        const answer = await tryAsync(
            async () => {
                const res = await send(
                    new Request(`${params.baseUrl}${prefix}`, {
                        headers: { "add-padding": "true", "user-agent": "lucent.moe platform" },
                        signal: AbortSignal.timeout(TIMEOUT_MS),
                    }),
                );
                return { status: res.status, body: res.ok ? await res.text() : "" };
            },
            (cause) => describeUnknownError(cause),
        );
        if (!answer.ok || answer.value.status !== 200) {
            params.onUnavailable(answer.ok ? `status ${answer.value.status}` : answer.error);
            return "unknown";
        }
        for (const line of answer.value.body.split("\n")) {
            const [candidate, count] = line.trim().split(":");
            if (candidate === suffix && Number(count) > 0) return "breached";
        }
        return "clear";
    };
}
