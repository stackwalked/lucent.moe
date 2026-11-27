import { useRef, useState } from "react";
import type { Outcome } from "../../../server/outcome.ts";
import { Code } from "../../../ui/Code/Code.tsx";
import { Stack } from "../../../ui/Stack/Stack.tsx";
import { RefusalNote } from "../../auth/RefusalNote.tsx";
import { sizeWords } from "../../cloud/copy.ts";
import { AccountAction } from "../accounts/AccountAction.tsx";
import { useStaffAction } from "../staff.ts";
import styles from "./ApproveListing.module.css";
import { ADMIN_CLOUD_COPY as C } from "./copy.ts";
import { approveListing, readListing } from "./server.ts";

type Read = Awaited<ReturnType<typeof readListing>>;

// Approval is of what was read: opening the dialog reads the waiting script (and, for an update,
// the one members see now), and approving sends the revision shown. The content is the member's
// own text: it is shown as text in the code block and nothing else.
export function ApproveListing({ listingId }: { readonly listingId: string }) {
    const staff = useStaffAction();
    const [read, setRead] = useState<Read | null>(null);
    // Which opening an answer belongs to: one that comes back after the dialog was reopened is
    // not what the dialog shows now.
    const opening = useRef(0);

    const load = () => {
        opening.current += 1;
        const mine = opening.current;
        setRead(null);
        void staff("moderation:remove", () => readListing({ data: { listingId } })).then(
            (answer) => {
                if (opening.current === mine) setRead(answer);
            },
        );
    };

    return (
        <AccountAction
            action="moderation:remove"
            label={C.approve}
            title={C.approveTitle}
            icon="check"
            onOpen={load}
            fields={
                <Stack gap={3}>
                    {read === null ? (
                        <p>{C.loading}</p>
                    ) : !read.ok ? (
                        <RefusalNote refused={read.refused} />
                    ) : (
                        <>
                            {read.value.description === "" ? null : (
                                <Stack gap={2}>
                                    <p>{C.description}</p>
                                    <p className={styles.description}>{read.value.description}</p>
                                </Stack>
                            )}
                            <Snapshot caption={C.waiting} shown={read.value.pending} />
                            {read.value.listed === null ? null : (
                                <Snapshot caption={C.listedNow} shown={read.value.listed} />
                            )}
                        </>
                    )}
                </Stack>
            }
            validate={() => (read?.ok === true ? undefined : C.unread)}
            run={() => {
                if (read === null || !read.ok) return Promise.resolve(unread);
                return approveListing({
                    data: { listingId, revision: read.value.pending.revision },
                });
            }}
        />
    );
}

function Snapshot({
    caption,
    shown,
}: {
    readonly caption: string;
    readonly shown: {
        readonly content: string | null;
        readonly size: number;
        readonly escaped: boolean;
    };
}) {
    return (
        <Stack gap={2}>
            <p>{caption}</p>
            {shown.content === null ? (
                <p>
                    {C.notShown} · {sizeWords(shown.size)}
                </p>
            ) : (
                <>
                    {shown.escaped ? <p className={styles.escaped}>{C.escaped}</p> : null}
                    <Code>{shown.content}</Code>
                </>
            )}
        </Stack>
    );
}

// `validate` stops the send before this is reached; it keeps `run`'s type honest.
const unread: Outcome<null> = { ok: false, refused: { code: "NOT_FOUND", reference: null } };
