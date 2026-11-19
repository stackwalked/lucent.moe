import { Code } from "../../../ui/Code/Code.tsx";
import { Stack } from "../../../ui/Stack/Stack.tsx";
import { ACCOUNTS_COPY } from "./copy.ts";

// A setup link, shown the once it exists: receipts never keep it, so staff copy it now or recover
// for a new one.
export function SetupLink({ token }: { readonly token: string }) {
    return (
        <Stack gap={2}>
            <Code>{`${window.location.origin}/setup/${token}`}</Code>
            <p>{ACCOUNTS_COPY.shownOnce}</p>
        </Stack>
    );
}
