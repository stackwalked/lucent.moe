import { describeUnknownError, tryAsync, trySync } from "@lucent/core/contain";
import { err, ok, type Result } from "@lucent/core/result";
import { Snowflake } from "@lucent/rpc/discord/rules";
import { z } from "zod";
import type { DiscordOauthConfig } from "../../../config.ts";

export type DiscordIdentity = { readonly userId: string; readonly username: string };

export type DiscordOauth = {
    // Who authorized this code; they are joined to the guild on the way. A refused join still
    // identifies.
    readonly identify: (
        code: string,
    ) => Promise<Result<DiscordIdentity, { readonly code: "DISCORD_LINK_FAILED" }>>;
};

const TIMEOUT_MS = 5_000;

const TokenAnswer = z.object({ access_token: z.string().min(1), scope: z.string() });
const UserAnswer = z.object({ id: Snowflake, username: z.string().min(1).max(64) });
const ErrorAnswer = z.object({ code: z.number().int() });

const REQUIRED_SCOPES = ["identify", "guilds.join"];

const FAILED = { code: "DISCORD_LINK_FAILED" } as const;

type Answer = { readonly status: number; readonly body: unknown };

// Never reports a token or the code: Discord's status and, when its error body has one, its
// numeric error code say what went wrong.
function describeAnswer(step: string, answer: Answer): string {
    const code = ErrorAnswer.safeParse(answer.body);
    return `${step} status ${answer.status}${code.success ? ` code ${code.data.code}` : ""}`;
}

// The Discord application that links accounts: `identify` is the OAuth code exchange, then who
// the token belongs to, then the guild join under the bot. The user's access token lives in this
// function only: it is used once, for the join, and never stored or returned.
export function createDiscordOauth(params: {
    readonly config: DiscordOauthConfig;
    readonly redirectUri: string;
    // Exchange and identity failures that are ours or Discord's, and refused joins.
    readonly onFailure: (detail: string) => void;
    readonly fetch?: (req: Request) => Promise<Response>;
}): DiscordOauth {
    const { config, redirectUri, onFailure } = params;
    const send = params.fetch ?? ((req: Request) => fetch(req));
    const basic = btoa(`${config.clientId}:${config.clientSecret}`);

    async function call(step: string, build: () => Request): Promise<Answer | null> {
        const answer = await tryAsync(
            async (): Promise<Answer> => {
                const res = await send(build());
                const text = await res.text();
                // A join answers 204 with no body, and an error page is not JSON: neither is a failure.
                const body = trySync(
                    (): unknown => JSON.parse(text),
                    () => null,
                );
                return { status: res.status, body: body.ok ? body.value : null };
            },
            (cause) => describeUnknownError(cause),
        );
        if (answer.ok) return answer.value;
        onFailure(`${step} ${answer.error}`);
        return null;
    }

    return {
        identify: async (code) => {
            const token = await call(
                "token",
                () =>
                    new Request(`${config.apiUrl}/oauth2/token`, {
                        method: "POST",
                        headers: {
                            authorization: `Basic ${basic}`,
                            "content-type": "application/x-www-form-urlencoded",
                            "user-agent": "lucent.moe platform",
                        },
                        body: new URLSearchParams({
                            grant_type: "authorization_code",
                            code,
                            redirect_uri: redirectUri,
                        }),
                        redirect: "error",
                        signal: AbortSignal.timeout(TIMEOUT_MS),
                    }),
            );
            if (token === null) return err(FAILED);
            // A bad or used code is the user's, not worth a log line.
            if (token.status === 400) return err(FAILED);
            const granted = TokenAnswer.safeParse(token.body);
            if (token.status !== 200 || !granted.success) {
                onFailure(describeAnswer("token", token));
                return err(FAILED);
            }
            const scopes = granted.data.scope.split(" ");
            if (!REQUIRED_SCOPES.every((scope) => scopes.includes(scope))) {
                onFailure("token scope missing");
                return err(FAILED);
            }
            const accessToken = granted.data.access_token;

            const me = await call(
                "identity",
                () =>
                    new Request(`${config.apiUrl}/users/@me`, {
                        headers: {
                            authorization: `Bearer ${accessToken}`,
                            "user-agent": "lucent.moe platform",
                        },
                        redirect: "error",
                        signal: AbortSignal.timeout(TIMEOUT_MS),
                    }),
            );
            if (me === null) return err(FAILED);
            const user = UserAnswer.safeParse(me.body);
            if (me.status !== 200 || !user.success) {
                onFailure(describeAnswer("identity", me));
                return err(FAILED);
            }

            const joined = await call(
                "join",
                () =>
                    new Request(
                        `${config.apiUrl}/guilds/${config.guildId}/members/${user.data.id}`,
                        {
                            method: "PUT",
                            headers: {
                                authorization: `Bot ${config.botToken}`,
                                "content-type": "application/json",
                                "user-agent": "lucent.moe platform",
                            },
                            body: JSON.stringify({ access_token: accessToken }),
                            redirect: "error",
                            signal: AbortSignal.timeout(TIMEOUT_MS),
                        },
                    ),
            );
            if (joined !== null && joined.status !== 201 && joined.status !== 204) {
                onFailure(describeAnswer("join", joined));
            }
            return ok({ userId: user.data.id, username: user.data.username });
        },
    };
}
