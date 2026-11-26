import { tryAsync } from "@lucent/core/contain";

export const MAIL_TIMEOUT_MS = 10_000;
export type MailProvider = "resend" | "brevo" | "log";
export type MailConfig =
    | { readonly provider: "log" }
    | {
          readonly provider: "brevo" | "resend";
          readonly apiKey: string;
          readonly sender: string;
      };
export type Envelope = {
    readonly id: string;
    readonly recipient: string;
    readonly subject: string;
    readonly body: string;
};
export type MailOutcome = "accepted" | "retry" | "refused" | "unconfirmed";
export type MailTransport = {
    readonly provider: MailProvider;
    readonly binding: string;
    readonly send: (envelope: Envelope, signal?: AbortSignal) => Promise<MailOutcome>;
};

export async function createMailTransport(
    config: MailConfig,
    sendRequest = (request: Request) => fetch(request),
): Promise<MailTransport> {
    // The log sink is offline. Its completion is reported by the job, never by logging an envelope.
    if (config.provider === "log")
        return { provider: "log", binding: "log", send: () => Promise.resolve("accepted") };
    // Delivery is at least once: a crash after the provider accepted and before the row settled
    // sends again. Both providers deduplicate on the outbox row id, which is stable across
    // retries, but only inside a window (resend `Idempotency-Key`, 24 h; brevo body header
    // `idempotencyKey`, 15 min; both checked against their public docs 2026-11-24). mail.rules.ts
    // stops retrying before the window ends and settles the row dead rather than send outside it.
    // Brevo documents no reply for a duplicate, so a 400 is treated as unconfirmed below.
    // Idempotency is provider/account scoped and Resend requires byte-equivalent payloads.
    // Fail closed on credential/sender changes rather than replay across different accounts.
    const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify([config.provider, config.sender, config.apiKey])),
    );
    return {
        provider: config.provider,
        binding: new Uint8Array(digest).toHex(),
        async send(envelope, signal) {
            const resend = config.provider === "resend";
            const response = await tryAsync(
                async () => {
                    const request = new Request(
                        resend
                            ? "https://api.resend.com/emails"
                            : "https://api.brevo.com/v3/smtp/email",
                        {
                            method: "POST",
                            redirect: "error",
                            signal: AbortSignal.any([
                                AbortSignal.timeout(MAIL_TIMEOUT_MS),
                                ...(signal ? [signal] : []),
                            ]),
                            headers: {
                                "content-type": "application/json",
                                ...(resend
                                    ? {
                                          authorization: `Bearer ${config.apiKey}`,
                                          "Idempotency-Key": envelope.id,
                                      }
                                    : { "api-key": config.apiKey }),
                            },
                            body: JSON.stringify(
                                resend
                                    ? {
                                          from: config.sender,
                                          to: [envelope.recipient],
                                          subject: envelope.subject,
                                          text: envelope.body,
                                      }
                                    : {
                                          sender: { email: config.sender },
                                          to: [{ email: envelope.recipient }],
                                          headers: { idempotencyKey: envelope.id },
                                          subject: envelope.subject,
                                          textContent: envelope.body,
                                      },
                            ),
                        },
                    );
                    const reply = await sendRequest(request);
                    // Provider response bodies may echo the input. Do not retain, log or expose them.
                    await reply.body?.cancel();
                    return reply.status;
                },
                () => "network",
            );
            if (!response.ok) return "retry";
            const status = response.value;
            if (status === (resend ? 200 : 201)) return "accepted";
            if (status === 408 || status === 429 || status >= 500 || (resend && status === 409))
                return "retry";
            // Brevo may return 400 duplicate_parameter: a key was consumed, not proof of delivery.
            if (!resend && status === 400) return "unconfirmed";
            return status >= 400 && status < 500 ? "refused" : "unconfirmed";
        },
    };
}
