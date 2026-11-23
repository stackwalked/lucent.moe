import { type BearerToken, isBearerToken } from "@lucent/core/brands";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import type { Refused } from "../../server/outcome.ts";
import { Button } from "../../ui/Button/Button.tsx";
import { Stack } from "../../ui/Stack/Stack.tsx";
import { TextField } from "../../ui/TextField/TextField.tsx";
import { RESET_COPY } from "./copy.ts";
import { RefusalNote } from "./RefusalNote.tsx";
import { redeemReset, requestReset } from "./reset-server.ts";

export function ResetPage() {
    const [token, setToken] = useState<BearerToken | null>(null);
    const [message, setMessage] = useState<string | null>(null);
    const [refused, setRefused] = useState<Refused | null>(null);
    useEffect(() => {
        // A URL fragment is never part of a request or Referer. Drop it from the current
        // history entry too; only the explicit password submission carries it to the server.
        if (!window.location.hash) return;
        const token = window.location.hash.slice(1);
        window.history.replaceState(window.history.state, "", window.location.pathname);
        if (isBearerToken(token)) setToken(token);
        else setRefused({ code: "RESET_INVALID", reference: null });
    }, []);
    const submit = async (form: FormData) => {
        const result =
            token === null
                ? await requestReset({ data: { email: String(form.get("email")).trim() } })
                : await redeemReset({ data: { token, password: String(form.get("password")) } });
        if (!result.ok) {
            setRefused(result.refused);
            return;
        }
        setRefused(null);
        setMessage(token === null ? RESET_COPY.sent : RESET_COPY.changed);
        setToken(null);
    };
    return (
        <Stack gap={4}>
            <h1>{RESET_COPY.title}</h1>
            {message === null ? (
                <form action={submit}>
                    <Stack gap={4}>
                        {token === null ? (
                            <TextField
                                name="email"
                                label={RESET_COPY.email}
                                type="email"
                                required
                                maxLength={254}
                                autoComplete="email"
                            />
                        ) : (
                            <TextField
                                name="password"
                                label={RESET_COPY.password}
                                type="password"
                                required
                                maxLength={1024}
                                autoComplete="new-password"
                            />
                        )}
                        <Button type="submit">
                            {token === null ? RESET_COPY.request : RESET_COPY.redeem}
                        </Button>
                    </Stack>
                </form>
            ) : (
                <p role="status">{message}</p>
            )}
            <RefusalNote refused={refused} />
            <Link to="/sign-in">{RESET_COPY.signIn}</Link>
        </Stack>
    );
}
