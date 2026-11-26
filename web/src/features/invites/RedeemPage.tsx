import { type BearerToken, isBearerToken } from "@lucent/core/brands";
import { useEffect, useState } from "react";
import type { Refused } from "../../server/outcome.ts";
import { BarePage } from "../../ui/BarePage/BarePage.tsx";
import { Button } from "../../ui/Button/Button.tsx";
import { Stack } from "../../ui/Stack/Stack.tsx";
import { TextField } from "../../ui/TextField/TextField.tsx";
import { RefusalNote } from "../auth/RefusalNote.tsx";
import { INVITES_COPY } from "./copy.ts";
import { redeemInvite } from "./server.ts";

// `/invite#<token>`: the token rides in the fragment, which no request or Referer carries, and is
// dropped from history as soon as it's read (as a reset link's is). Only the form posts it.
export function RedeemPage() {
    const [token, setToken] = useState<BearerToken | null>(null);
    const [sent, setSent] = useState(false);
    const [refused, setRefused] = useState<Refused | null>(null);
    useEffect(() => {
        const read = window.location.hash.slice(1);
        if (read !== "") {
            window.history.replaceState(window.history.state, "", window.location.pathname);
        }
        if (isBearerToken(read)) setToken(read);
        else setRefused({ code: "INVITE_INVALID", reference: null });
    }, []);
    const submit = async (form: FormData) => {
        if (token === null) return;
        const reply = await redeemInvite({
            data: { token, email: String(form.get("email") ?? "").trim() },
        });
        if (!reply.ok) {
            setRefused(reply.refused);
            return;
        }
        setRefused(null);
        setSent(true);
    };
    return (
        <BarePage title={INVITES_COPY.redeemTitle}>
            <Stack gap={4}>
                {sent ? (
                    <p role="status">{INVITES_COPY.sent}</p>
                ) : token === null ? null : (
                    <form action={submit}>
                        <Stack gap={4}>
                            <TextField
                                name="email"
                                label={INVITES_COPY.email}
                                type="email"
                                required
                                maxLength={254}
                                autoComplete="email"
                            />
                            <div>
                                <Button type="submit">{INVITES_COPY.redeem}</Button>
                            </div>
                        </Stack>
                    </form>
                )}
                <RefusalNote refused={refused} />
            </Stack>
        </BarePage>
    );
}
