import { useRouteContext } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useState } from "react";
import type { Outcome, Refused } from "../../server/outcome.ts";
import { Button } from "../../ui/Button/Button.tsx";
import { Empty } from "../../ui/Empty/Empty.tsx";
import { Page } from "../../ui/Page/Page.tsx";
import { Section } from "../../ui/Section/Section.tsx";
import { Stack } from "../../ui/Stack/Stack.tsx";
import { Status } from "../../ui/Status/Status.tsx";
import { Table } from "../../ui/Table/Table.tsx";
import { Time } from "../../ui/Time/Time.tsx";
import { useToast } from "../../ui/Toast/Toast.tsx";
import { deviceLabel } from "../../user-agent.ts";
import { memberOf } from "../../viewer.ts";
import { RefusalNote } from "../auth/RefusalNote.tsx";
import { AddApp } from "../credentials/AddApp.tsx";
import { AddPasskey } from "../credentials/AddPasskey.tsx";
import { SetPassword } from "../credentials/SetPassword.tsx";
import { listCredentials, removeCredential } from "../credentials/server.ts";
import { useStepUp } from "../step-up/StepUp.tsx";
import { SECURITY_COPY } from "./copy.ts";
import { endOtherSessions, endSession, listSessions } from "./server.ts";

type Credentials = Extract<Awaited<ReturnType<typeof listCredentials>>, { ok: true }>["value"];
type CredentialRef =
    | { readonly kind: "passkey"; readonly id: string }
    | { readonly kind: "password" }
    | { readonly kind: "totp" };
type Sessions = Extract<Awaited<ReturnType<typeof listSessions>>, { ok: true }>["value"];

// Read when the page opens and again after each change: authority data is never treated as fresh.
function useLoaded<T>(load: () => Promise<Outcome<T>>) {
    const [value, setValue] = useState<T | null>(null);
    const [refused, setRefused] = useState<Refused | null>(null);
    const reload = async () => {
        const reply = await load();
        if (reply.ok) setValue(reply.value);
        else setRefused(reply.refused);
    };
    const loadOnce = useEffectEvent(() => void reload());
    useEffect(() => loadOnce(), []);
    return { value, refused, reload };
}

function Credentials({ username }: { readonly username: string }) {
    const guard = useStepUp();
    const toast = useToast();
    const { value, refused, reload } = useLoaded(() => listCredentials());
    const [actionRefused, setActionRefused] = useState<Refused | null>(null);
    const [changingPassword, setChangingPassword] = useState(false);

    const remove = async (credential: CredentialRef) => {
        setActionRefused(null);
        const reply = await guard(() => removeCredential({ data: { credential } }));
        if (!reply.ok) return setActionRefused(reply.refused);
        toast(SECURITY_COPY.removed);
        await reload();
    };

    if (refused !== null) return <RefusalNote refused={refused} />;
    if (value === null) return null;
    const changed = () => {
        setChangingPassword(false);
        void reload();
    };

    return (
        <>
            <RefusalNote refused={actionRefused} />
            <Section caption={SECURITY_COPY.passkeys}>
                {value.passkeys.length === 0 ? (
                    <Empty>{SECURITY_COPY.noPasskeys}</Empty>
                ) : (
                    <Table
                        caption={SECURITY_COPY.passkeys}
                        columns={[
                            {
                                key: "label",
                                header: SECURITY_COPY.passkeys,
                                cell: (p: Credentials["passkeys"][number]) => p.label,
                            },
                            {
                                key: "created",
                                header: SECURITY_COPY.created,
                                cell: (p) => <Time at={p.createdAt} />,
                            },
                            {
                                key: "used",
                                header: SECURITY_COPY.lastUsed,
                                cell: (p) =>
                                    p.lastUsedAt === null ? (
                                        SECURITY_COPY.never
                                    ) : (
                                        <Time at={p.lastUsedAt} format="relative" />
                                    ),
                            },
                            {
                                key: "remove",
                                header: "",
                                align: "end",
                                cell: (p) => (
                                    <Button
                                        size="sm"
                                        tone="ghost"
                                        onClick={() => void remove({ kind: "passkey", id: p.id })}
                                    >
                                        {SECURITY_COPY.remove}
                                    </Button>
                                ),
                            },
                        ]}
                        rows={value.passkeys}
                        rowKey={(p) => p.id}
                    />
                )}
                <AddPasskey onAdded={() => void reload()} />
            </Section>
            <Section caption={SECURITY_COPY.password}>
                {value.password === null || changingPassword ? (
                    <SetPassword username={username} onSet={changed} />
                ) : (
                    <Stack direction="row" gap={2} align="center">
                        <Status icon="check">{SECURITY_COPY.passwordSet}</Status>
                        <Time at={value.password.updatedAt} format="relative" />
                        <Button size="sm" onClick={() => setChangingPassword(true)}>
                            {SECURITY_COPY.change}
                        </Button>
                        <Button
                            size="sm"
                            tone="ghost"
                            onClick={() => void remove({ kind: "password" })}
                        >
                            {SECURITY_COPY.remove}
                        </Button>
                    </Stack>
                )}
            </Section>
            <Section caption={SECURITY_COPY.app}>
                {value.totp?.confirmed === true ? (
                    <Stack direction="row" gap={2} align="center">
                        <Status icon="check">{SECURITY_COPY.appOn}</Status>
                        <Button
                            size="sm"
                            tone="ghost"
                            onClick={() => void remove({ kind: "totp" })}
                        >
                            {SECURITY_COPY.remove}
                        </Button>
                    </Stack>
                ) : (
                    <AddApp onAdded={() => void reload()} />
                )}
            </Section>
        </>
    );
}

function Signins() {
    const toast = useToast();
    const { value, refused, reload } = useLoaded(() => listSessions());
    const [actionRefused, setActionRefused] = useState<Refused | null>(null);

    const end = async (run: () => Promise<Outcome<null>>, done: string) => {
        setActionRefused(null);
        const reply = await run();
        if (!reply.ok) return setActionRefused(reply.refused);
        toast(done);
        await reload();
    };

    if (refused !== null) return <RefusalNote refused={refused} />;
    if (value === null) return null;
    return (
        <Section
            caption={SECURITY_COPY.sessions}
            actions={
                value.length > 1 ? (
                    <Button
                        size="sm"
                        onClick={() =>
                            void end(() => endOtherSessions(), SECURITY_COPY.signedOutElsewhere)
                        }
                    >
                        {SECURITY_COPY.signOutOthers}
                    </Button>
                ) : undefined
            }
        >
            <RefusalNote refused={actionRefused} />
            <Table
                caption={SECURITY_COPY.sessions}
                columns={[
                    {
                        key: "device",
                        header: SECURITY_COPY.sessions,
                        cell: (s: Sessions[number]) =>
                            deviceLabel(s.client.userAgent, SECURITY_COPY.unknownDevice),
                    },
                    { key: "ip", header: SECURITY_COPY.ip, cell: (s) => s.client.ip ?? "" },
                    {
                        key: "seen",
                        header: SECURITY_COPY.lastSeen,
                        cell: (s) => <Time at={s.lastSeenAt} format="relative" />,
                    },
                    {
                        key: "end",
                        header: "",
                        align: "end",
                        cell: (s) =>
                            s.current ? (
                                <Status tone="pink">{SECURITY_COPY.thisDevice}</Status>
                            ) : (
                                <Button
                                    size="sm"
                                    tone="ghost"
                                    onClick={() =>
                                        void end(
                                            () => endSession({ data: { sessionId: s.sessionId } }),
                                            SECURITY_COPY.sessionEnded,
                                        )
                                    }
                                >
                                    {SECURITY_COPY.signOut}
                                </Button>
                            ),
                    },
                ]}
                rows={value}
                rowKey={(s) => s.sessionId}
            />
        </Section>
    );
}

export function SecurityPage() {
    const { session } = useRouteContext({ from: "__root__" });
    const viewer = memberOf(session);
    return (
        <Page title={SECURITY_COPY.title} width="narrow">
            <Credentials username={viewer?.username ?? ""} />
            <Signins />
        </Page>
    );
}
