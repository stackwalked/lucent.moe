import { getRouteApi } from "@tanstack/react-router";
import { useState } from "react";
import type { Refused } from "../../server/outcome.ts";
import { BarePage } from "../../ui/BarePage/BarePage.tsx";
import { Button } from "../../ui/Button/Button.tsx";
import { Pairs } from "../../ui/Pairs/Pairs.tsx";
import { Stack } from "../../ui/Stack/Stack.tsx";
import { Status } from "../../ui/Status/Status.tsx";
import { Time } from "../../ui/Time/Time.tsx";
import { RefusalNote } from "../auth/RefusalNote.tsx";
import { SIGN_IN_REQUEST_COPY } from "./copy.ts";
import { decideSignInRequest } from "./server.ts";

const route = getRouteApi("/_member/auth/device/$requestId");

// The browser half of the loader's sign-in. Either answer sends the browser on to the loader's
// own listener on this PC, which takes it from there.
export function SignInRequestPage() {
    const loaded = route.useLoaderData();
    const [pending, setPending] = useState<"approve" | "deny" | null>(null);
    const [refused, setRefused] = useState<Refused | null>(null);

    if (!loaded.ok) {
        return (
            <BarePage title={SIGN_IN_REQUEST_COPY.title}>
                <RefusalNote
                    refused={loaded.refused}
                    overrides={{ NOT_FOUND: SIGN_IN_REQUEST_COPY.gone }}
                />
            </BarePage>
        );
    }
    const request = loaded.value;

    const decide = async (decision: "approve" | "deny") => {
        setPending(decision);
        setRefused(null);
        const reply = await decideSignInRequest({
            data: { requestId: request.requestId, decision },
        });
        if (!reply.ok) {
            setPending(null);
            return setRefused(reply.refused);
        }
        window.location.assign(reply.value);
    };

    return (
        <BarePage title={SIGN_IN_REQUEST_COPY.title}>
            <Stack gap={4}>
                <p>{SIGN_IN_REQUEST_COPY.body}</p>
                <Pairs
                    items={[
                        {
                            label: SIGN_IN_REQUEST_COPY.code,
                            value: <Status tone="pink">{request.matchCode}</Status>,
                        },
                        {
                            label: SIGN_IN_REQUEST_COPY.asked,
                            value: <Time at={request.createdAt} format="relative" />,
                        },
                        {
                            label: SIGN_IN_REQUEST_COPY.expires,
                            value: <Time at={request.expiresAt} />,
                        },
                    ]}
                />
                <p>{SIGN_IN_REQUEST_COPY.check}</p>
                <RefusalNote
                    refused={refused}
                    overrides={{ NOT_FOUND: SIGN_IN_REQUEST_COPY.gone }}
                />
                <Stack direction="row" gap={2}>
                    <Button
                        tone="pink"
                        pending={pending === "approve"}
                        disabled={pending === "deny"}
                        onClick={() => void decide("approve")}
                    >
                        {SIGN_IN_REQUEST_COPY.approve}
                    </Button>
                    <Button
                        pending={pending === "deny"}
                        disabled={pending === "approve"}
                        onClick={() => void decide("deny")}
                    >
                        {SIGN_IN_REQUEST_COPY.deny}
                    </Button>
                </Stack>
            </Stack>
        </BarePage>
    );
}
