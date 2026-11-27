import { useRouter } from "@tanstack/react-router";
import { useActionState, useState } from "react";
import type { Outcome, Refused } from "../../server/outcome.ts";
import { Section } from "../../ui/Section/Section.tsx";
import { Select } from "../../ui/Select/Select.tsx";
import { RowAction, SettingRow, SettingRows } from "../../ui/SettingRow/SettingRow.tsx";
import { TextField } from "../../ui/TextField/TextField.tsx";
import { FormDialog } from "../account/FormDialog.tsx";
import { RefusalNote } from "../auth/RefusalNote.tsx";
import { PRIVACY_COPY as C } from "./copy.ts";
import type { fetchPrivacy } from "./server.ts";
import { blockAccount, saveVisibility } from "./server.ts";

type Loaded = Extract<Awaited<ReturnType<typeof fetchPrivacy>>, { ok: true }>["value"];

function Visibility({ visibility }: { readonly visibility: Loaded["visibility"] }) {
    const router = useRouter();
    const [open, setOpen] = useState(false);
    const [refused, submit, pending] = useActionState(async (_: Refused | null, form: FormData) => {
        const reply = await saveVisibility({
            data: { visibility: form.get("visibility") === "private" ? "private" : "members" },
        });
        if (!reply.ok) return reply.refused;
        setOpen(false);
        await router.invalidate();
        return null;
    }, null);
    return (
        <>
            <RowAction onClick={() => setOpen(true)}>{C.change}</RowAction>
            <FormDialog
                open={open}
                onClose={() => setOpen(false)}
                title={C.profileTitle}
                confirm={C.change}
                pending={pending}
                action={submit}
            >
                <Select
                    key={visibility}
                    name="visibility"
                    label={C.profileField}
                    defaultValue={visibility}
                    options={[
                        { value: "members", label: C.members },
                        { value: "private", label: C.onlyYou },
                    ]}
                />
                <RefusalNote refused={refused} />
            </FormDialog>
        </>
    );
}

function Blocks({ blocks }: { readonly blocks: Loaded["blocks"] }) {
    const router = useRouter();
    const [open, setOpen] = useState(false);
    const [unblocking, setUnblocking] = useState<string | null>(null);
    const [unblockRefused, setUnblockRefused] = useState<Refused | null>(null);
    const [refused, submit, pending] = useActionState(async (_: Refused | null, form: FormData) => {
        const reply = await blockAccount({
            data: { username: String(form.get("username") ?? ""), blocked: true },
        });
        if (!reply.ok) return reply.refused;
        await router.invalidate();
        return null;
    }, null);
    const unblock = async (username: string) => {
        setUnblocking(username);
        setUnblockRefused(null);
        const reply = await blockAccount({ data: { username, blocked: false } });
        setUnblocking(null);
        if (!reply.ok) return setUnblockRefused(reply.refused);
        await router.invalidate();
    };
    return (
        <>
            <RowAction onClick={() => setOpen(true)}>{C.manage}</RowAction>
            <FormDialog
                open={open}
                onClose={() => setOpen(false)}
                title={C.blocksTitle}
                confirm={C.block}
                pending={pending}
                action={submit}
            >
                <p>{C.blocksHint}</p>
                {blocks.length === 0 ? null : (
                    <SettingRows label={C.blocksTitle}>
                        {blocks.flatMap((row) =>
                            row.username === null
                                ? []
                                : [
                                      <SettingRow
                                          key={row.username}
                                          layout="item"
                                          name={row.username}
                                          action={
                                              <RowAction
                                                  tone="quiet"
                                                  label={C.unblockLabel(row.username)}
                                                  pending={unblocking === row.username}
                                                  onClick={() => void unblock(row.username ?? "")}
                                              >
                                                  {C.unblock}
                                              </RowAction>
                                          }
                                      />,
                                  ],
                        )}
                    </SettingRows>
                )}
                <TextField name="username" label={C.blockField} required maxLength={64} />
                <RefusalNote refused={refused ?? unblockRefused} />
            </FormDialog>
        </>
    );
}

// Who may open the profile and whom the member blocked.
export function PrivacySection({ privacy }: { readonly privacy: Outcome<Loaded> }) {
    if (!privacy.ok) {
        return (
            <Section caption={C.title}>
                <RefusalNote refused={privacy.refused} />
            </Section>
        );
    }
    const { visibility, blocks } = privacy.value;
    return (
        <Section caption={C.title}>
            <SettingRows label={C.title}>
                <SettingRow
                    name={C.profile}
                    value={visibility === "private" ? C.private : C.visible}
                    action={<Visibility visibility={visibility} />}
                />
                <SettingRow
                    name={C.blocked}
                    value={blocks.length === 0 ? C.none : C.accounts(blocks.length)}
                    action={<Blocks blocks={blocks} />}
                />
            </SettingRows>
        </Section>
    );
}
