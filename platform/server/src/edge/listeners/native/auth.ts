import type { Context, Hono } from "hono";
import {
    parseForm,
    pushAuthRequest,
    redeemCode,
    refreshTokens,
} from "../../../identity/devices/sign-in.ts";
import { readBoundedBody } from "./http.ts";
import { oauthFailure, oauthReply, tokenReply } from "./responses.ts";
import type { NativeRoutes } from "./route-context.ts";

const FORM_FIELDS = {
    request: [
        "client_id",
        "response_type",
        "redirect_uri",
        "code_challenge",
        "code_challenge_method",
        "state",
    ],
    token: ["client_id", "grant_type", "code", "code_verifier", "redirect_uri", "refresh_token"],
} as const;

export function mountAuth(app: Hono, { deps, oauthProven }: NativeRoutes): void {
    const formOf = async (
        c: Context,
        fields: readonly string[],
    ): Promise<ReadonlyMap<string, string> | null> => {
        if (!(c.req.header("content-type") ?? "").startsWith("application/x-www-form-urlencoded")) {
            return null;
        }
        const read = await readBoundedBody(c.req.raw);
        return read.ok ? parseForm(read.value, fields) : null;
    };

    app.post("/v1/auth/requests", async (c) => {
        const proof = await oauthProven(c, "auth.requests");
        if (!proof.ok) return proof.error;
        const form = await formOf(c, FORM_FIELDS.request);
        if (form === null) return oauthReply(400, { error: "invalid_request" });
        const pushed = await pushAuthRequest(deps.db, { rng: deps.rng, proof: proof.value, form });
        if (!pushed.ok) return oauthFailure(pushed.error);
        return oauthReply(201, {
            request_uri: pushed.value.requestUri,
            expires_in: pushed.value.expiresInSeconds,
        });
    });

    app.post("/v1/auth/token", async (c) => {
        const proof = await oauthProven(c, "auth.token");
        if (!proof.ok) return proof.error;
        const form = await formOf(c, FORM_FIELDS.token);
        if (form === null) return oauthReply(400, { error: "invalid_request" });
        const grant = { rng: deps.rng, proof: proof.value, form };
        switch (form.get("grant_type")) {
            case "authorization_code": {
                const tokens = await redeemCode(deps.db, grant);
                return tokens.ok ? tokenReply(tokens.value) : oauthFailure(tokens.error);
            }
            case "refresh_token": {
                const tokens = await refreshTokens(deps.db, grant);
                return tokens.ok ? tokenReply(tokens.value) : oauthFailure(tokens.error);
            }
            default:
                return oauthReply(400, { error: "unsupported_grant_type" });
        }
    });
}
