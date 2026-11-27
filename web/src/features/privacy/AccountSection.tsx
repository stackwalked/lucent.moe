import type { EpochMs } from "@lucent/core/scalars";
import { useEffect, useState } from "react";
import type { Refused } from "../../server/outcome.ts";
import { Button } from "../../ui/Button/Button.tsx";
import { Dialog } from "../../ui/Dialog/Dialog.tsx";
import { Section } from "../../ui/Section/Section.tsx";
import { RowAction, SettingRow, SettingRows } from "../../ui/SettingRow/SettingRow.tsx";
import { Stack } from "../../ui/Stack/Stack.tsx";
import { Time } from "../../ui/Time/Time.tsx";
import { RefusalNote } from "../auth/RefusalNote.tsx";
import { PRIVACY_COPY as C } from "./copy.ts";
import { fetchEmail, fetchExport } from "./server.ts";
import { useDeletion } from "./useDeletion.ts";

// The export is one JSON file made in the browser from what platform returned, so the data
// never passes through a link that could be shared.
async function download(): Promise<Refused | null> {
    const reply = await fetchExport();
    if (!reply.ok) return reply.refused;
    const url = URL.createObjectURL(
        new Blob([JSON.stringify(reply.value, null, 2)], { type: "application/json" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = C.exportName;
    link.click();
    URL.revokeObjectURL(url);
    return null;
}

// The address is only in the export, a large read: it fills in after the page is up.
function useEmail(): string | null {
    const [email, setEmail] = useState<string | null>(null);
    useEffect(() => {
        let current = true;
        void fetchEmail().then((reply) => {
            if (current && reply.ok) setEmail(reply.value);
        });
        return () => {
            current = false;
        };
    }, []);
    return email;
}

function DeletionRow({ dueAt }: { readonly dueAt: EpochMs | null }) {
    const deletion = useDeletion("member");
    return (
        <SettingRow
            name={C.deletion}
            {...(dueAt === null
                ? {}
                : {
                      value: (
                          <>
                              {C.deletes} <Time at={dueAt} format="day" />
                          </>
                      ),
                  })}
            action={
                dueAt === null ? (
                    <RowAction tone="shu" onClick={deletion.open}>
                        {C.delete}
                    </RowAction>
                ) : (
                    <RowAction
                        tone="pink"
                        label={C.keep}
                        pending={deletion.pending}
                        onClick={() => void deletion.keepIt()}
                    >
                        {C.keepShort}
                    </RowAction>
                )
            }
        >
            <Dialog
                open={deletion.confirming}
                onClose={deletion.close}
                title={C.confirmTitle}
                busy={deletion.pending}
                actions={
                    <>
                        <Button tone="ghost" disabled={deletion.pending} onClick={deletion.close}>
                            {C.cancel}
                        </Button>
                        <Button
                            tone="danger"
                            pending={deletion.pending}
                            onClick={() => void deletion.request()}
                        >
                            {C.deleteAccount}
                        </Button>
                    </>
                }
            >
                <Stack gap={3}>
                    <p>{C.confirmBody}</p>
                    <RefusalNote refused={deletion.refused} overrides={deletion.overrides} />
                </Stack>
            </Dialog>
            {dueAt === null ? null : <RefusalNote refused={deletion.refused} />}
        </SettingRow>
    );
}

// The address on file, the data export, and deleting the account (or keeping it, while a
// deletion waits).
export function AccountSection({ dueAt }: { readonly dueAt: EpochMs | null }) {
    const email = useEmail();
    const [pending, setPending] = useState(false);
    const [refused, setRefused] = useState<Refused | null>(null);
    return (
        <Section caption={C.account}>
            <RefusalNote refused={refused} />
            <SettingRows label={C.account}>
                {email === null ? null : <SettingRow name={C.email} value={email} />}
                <SettingRow
                    name={C.data}
                    action={
                        <RowAction
                            pending={pending}
                            onClick={() => {
                                setPending(true);
                                void download().then((answer) => {
                                    setPending(false);
                                    setRefused(answer);
                                });
                            }}
                        >
                            {C.download}
                        </RowAction>
                    }
                />
                <DeletionRow dueAt={dueAt} />
            </SettingRows>
        </Section>
    );
}
