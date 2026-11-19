import type { Refused } from "../../server/outcome.ts";
import { Button } from "../../ui/Button/Button.tsx";
import { Stack } from "../../ui/Stack/Stack.tsx";
import { RefusalNote } from "../auth/RefusalNote.tsx";
import { ADMIN_COPY } from "./copy.ts";
import { useListNavigation } from "./list.ts";

// A list that couldn't be read. A page that no longer exists (the list moved on since its cursor
// was handed out, then Back or reload) has a way back to the first one.
export function ListRefusal({ refused }: { readonly refused: Refused }) {
    const navigation = useListNavigation();
    return (
        <Stack gap={3}>
            <RefusalNote refused={refused} />
            {refused.code === "INVALID_CURSOR" ? (
                <div>
                    <Button size="sm" onClick={() => void navigation.first()}>
                        {ADMIN_COPY.firstPage}
                    </Button>
                </div>
            ) : null}
        </Stack>
    );
}
