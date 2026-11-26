import type { EpochMs } from "@lucent/core/scalars";
import { Link } from "@tanstack/react-router";
import { Stack } from "../../ui/Stack/Stack.tsx";
import { Status } from "../../ui/Status/Status.tsx";
import { Time } from "../../ui/Time/Time.tsx";
import { PRIVACY_COPY } from "./copy.ts";

// On every member page while a deletion waits, so someone who didn't ask for it sees it the
// moment they sign in, and the way to keep the account is one click away.
export function DeletionPending({ dueAt }: { readonly dueAt: EpochMs }) {
    return (
        <Stack direction="row" gap={3} align="center">
            <Status tone="shu">
                {PRIVACY_COPY.pending} <Time at={dueAt} />
            </Status>
            <Link to="/account/privacy">{PRIVACY_COPY.keep}</Link>
        </Stack>
    );
}
