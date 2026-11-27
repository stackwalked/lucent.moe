import type { DeletionStatus } from "@lucent/rpc/web/deletion";
import type { z } from "zod";
import { Button } from "../../ui/Button/Button.tsx";
import { Dialog } from "../../ui/Dialog/Dialog.tsx";
import { Section } from "../../ui/Section/Section.tsx";
import { Stack } from "../../ui/Stack/Stack.tsx";
import { Time } from "../../ui/Time/Time.tsx";
import { RefusalNote } from "../auth/RefusalNote.tsx";
import { PRIVACY_COPY } from "./copy.ts";
import { useDeletion } from "./useDeletion.ts";

// Deletion as a block of a page of its own (the appeal page); on the account page it is a row.
export function DeletionSection({
    status,
    purpose,
}: {
    readonly status: z.output<typeof DeletionStatus>;
    readonly purpose: "member" | "appeal";
}) {
    const deletion = useDeletion(purpose);

    if (status.state === "pending") {
        return (
            <Section caption={PRIVACY_COPY.deletion}>
                <Stack gap={3}>
                    <p>
                        {PRIVACY_COPY.pending} <Time at={status.dueAt} />
                    </p>
                    <RefusalNote refused={deletion.refused} overrides={deletion.overrides} />
                    <div>
                        <Button
                            tone="pink"
                            pending={deletion.pending}
                            onClick={() => void deletion.keepIt()}
                        >
                            {PRIVACY_COPY.keep}
                        </Button>
                    </div>
                </Stack>
            </Section>
        );
    }
    return (
        <Section caption={PRIVACY_COPY.deletion}>
            <Stack gap={3}>
                <p>{PRIVACY_COPY.deletionBody}</p>
                <div>
                    <Button tone="danger" onClick={deletion.open}>
                        {PRIVACY_COPY.deleteAccount}
                    </Button>
                </div>
            </Stack>
            <Dialog
                open={deletion.confirming}
                onClose={deletion.close}
                title={PRIVACY_COPY.confirmTitle}
                busy={deletion.pending}
                actions={
                    <>
                        <Button tone="ghost" onClick={deletion.close}>
                            {PRIVACY_COPY.cancel}
                        </Button>
                        <Button
                            tone="danger"
                            pending={deletion.pending}
                            onClick={() => void deletion.request()}
                        >
                            {PRIVACY_COPY.deleteAccount}
                        </Button>
                    </>
                }
            >
                <Stack gap={3}>
                    <p>{PRIVACY_COPY.confirmBody}</p>
                    <RefusalNote refused={deletion.refused} overrides={deletion.overrides} />
                </Stack>
            </Dialog>
        </Section>
    );
}
