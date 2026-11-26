import { expect, test } from "bun:test";
import { invariant } from "@lucent/core/contain";
import { createMailTransport } from "../src/base/adapters/mail/mail.ts";

const envelope = {
    id: "a5a48808-a7ef-49f9-b23a-9902c4cd3836",
    recipient: "to@lucent.test",
    subject: "subject",
    body: "text",
};
test.each(["resend", "brevo"] as const)(
    "%s puts the replay key in the documented place and refuses redirects",
    async (provider) => {
        const mail = await createMailTransport(
            { provider, sender: "from@lucent.test", apiKey: "fixture" },
            async (req) => {
                expect(req.redirect).toBe("error");
                expect(req.signal.aborted).toBe(false);
                if (provider === "resend") {
                    expect(req.url).toBe("https://api.resend.com/emails");
                    expect(req.headers.get("Idempotency-Key")).toBe(envelope.id);
                    expect(req.headers.get("Authorization")).toBe("Bearer fixture");
                    expect(await req.json()).toEqual({
                        from: "from@lucent.test",
                        to: [envelope.recipient],
                        subject: "subject",
                        text: "text",
                    });
                    return Response.json({ id: "offline" });
                }
                expect(req.url).toBe("https://api.brevo.com/v3/smtp/email");
                expect(req.headers.get("api-key")).toBe("fixture");
                expect(await req.json()).toEqual({
                    sender: { email: "from@lucent.test" },
                    to: [{ email: envelope.recipient }],
                    headers: { idempotencyKey: envelope.id },
                    subject: "subject",
                    textContent: "text",
                });
                return Response.json({ messageId: "offline" }, { status: 201 });
            },
        );
        expect(await mail.send(envelope)).toBe("accepted");
    },
);

test("the log sink does not construct an outbound request", async () => {
    const mail = await createMailTransport({ provider: "log" }, () => {
        invariant(false, "offline sink called fetch");
    });
    expect(await mail.send(envelope)).toBe("accepted");
});

test.each([
    ["brevo", 400, "unconfirmed"], // duplicate_parameter is not a fresh acceptance
    ["resend", 409, "retry"], // can be a concurrent request with the same key
    ["resend", 429, "retry"],
    ["brevo", 503, "retry"],
    ["brevo", 401, "refused"],
] as const)("%s status %d exposes only %s", async (provider, status, outcome) => {
    const mail = await createMailTransport(
        { provider, sender: "from@lucent.test", apiKey: "fixture" },
        async () => new Response("private echoed recipient and body", { status }),
    );
    expect(await mail.send(envelope)).toBe(outcome);
});
