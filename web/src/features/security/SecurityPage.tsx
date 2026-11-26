import { useRouteContext } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useState } from "react";
import type { Outcome, Refused } from "../../server/outcome.ts";
import { Button } from "../../ui/Button/Button.tsx";
import { Empty } from "../../ui/Empty/Empty.tsx";
import { Section } from "../../ui/Section/Section.tsx";
import { Status } from "../../ui/Status/Status.tsx";
import { Time } from "../../ui/Time/Time.tsx";
import { useToast } from "../../ui/Toast/Toast.tsx";
import { deviceLabel } from "../../user-agent.ts";
import { memberOf } from "../../viewer.ts";
import { AccountPage, State } from "../account/AccountPage.tsx";
import { Rows } from "../account/Rows.tsx";
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

type Loaded<T> = {
    readonly value: T | null;
    readonly refused: Refused | null;
    readonly reload: () => Promise<void>;
};

function Credentials({
    username,
    loaded,
}: {
    readonly username: string;
    readonly loaded: Loaded<Credentials>;
}) {
    const guard = useStepUp();
    const toast = useToast();
    const { value, refused, reload } = loaded;
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
            <Section caption={SECURITY_COPY.password}>
                {value.password === null || changingPassword ? (
                    <SetPassword username={username} onSet={changed} />
                ) : (
                    <Rows
                        label={SECURITY_COPY.password}
                        items={[
                            {
                                key: "password",
                                main: <Status icon="check">{SECURITY_COPY.passwordSet}</Status>,
                                meta: <Time at={value.password.updatedAt} format="relative" />,
                                action: (
                                    <>
                                        <Button size="sm" onClick={() => setChangingPassword(true)}>
                                            {SECURITY_COPY.change}
                                        </Button>
                                        <Button
                                            size="sm"
                                            tone="danger"
                                            onClick={() => void remove({ kind: "password" })}
                                        >
                                            {SECURITY_COPY.remove}
                                        </Button>
                                    </>
                                ),
                            },
                        ]}
                    />
                )}
            </Section>
            <Section caption={SECURITY_COPY.passkeys}>
                {value.passkeys.length === 0 ? (
                    <Empty>{SECURITY_COPY.noPasskeys}</Empty>
                ) : (
                    <Rows
                        label={SECURITY_COPY.passkeys}
                        items={value.passkeys.map((p) => ({
                            key: p.id,
                            main: p.label,
                            meta:
                                p.lastUsedAt === null ? (
                                    SECURITY_COPY.never
                                ) : (
                                    <Time at={p.lastUsedAt} format="relative" />
                                ),
                            action: (
                                <Button
                                    size="sm"
                                    tone="danger"
                                    onClick={() => void remove({ kind: "passkey", id: p.id })}
                                >
                                    {SECURITY_COPY.remove}
                                </Button>
                            ),
                        }))}
                    />
                )}
                <AddPasskey onAdded={() => void reload()} />
            </Section>
            <Section caption={SECURITY_COPY.app}>
                {value.totp?.confirmed === true ? (
                    <Rows
                        label={SECURITY_COPY.app}
                        items={[
                            {
                                key: "app",
                                main: <Status icon="check">{SECURITY_COPY.appOn}</Status>,
                                action: (
                                    <Button
                                        size="sm"
                                        tone="danger"
                                        onClick={() => void remove({ kind: "totp" })}
                                    >
                                        {SECURITY_COPY.remove}
                                    </Button>
                                ),
                            },
                        ]}
                    />
                ) : (
                    <AddApp onAdded={() => void reload()} />
                )}
            </Section>
        </>
    );
}

function Signins({ loaded }: { readonly loaded: Loaded<Sessions> }) {
    const toast = useToast();
    const { value, refused, reload } = loaded;
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
        <Section caption={SECURITY_COPY.sessions}>
            <RefusalNote refused={actionRefused} />
            <Rows
                label={SECURITY_COPY.sessions}
                items={value.map((s) => ({
                    key: s.sessionId,
                    main: deviceLabel(s.client.userAgent, SECURITY_COPY.unknownDevice),
                    meta: (
                        <>
                            {s.client.ip === null ? "" : `${s.client.ip} · `}
                            <Time at={s.lastSeenAt} format="relative" />
                        </>
                    ),
                    action: s.current ? (
                        <Status tone="pink">{SECURITY_COPY.thisDevice}</Status>
                    ) : (
                        <Button
                            size="sm"
                            tone="danger"
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
                }))}
            />
            {value.length > 1 ? (
                <div>
                    <Button
                        size="sm"
                        tone="danger"
                        onClick={() =>
                            void end(() => endOtherSessions(), SECURITY_COPY.signedOutElsewhere)
                        }
                    >
                        {SECURITY_COPY.signOutOthers}
                    </Button>
                </div>
            ) : null}
        </Section>
    );
}

export function SecurityPage() {
    const { session } = useRouteContext({ from: "__root__" });
    const viewer = memberOf(session);
    const credentials = useLoaded(() => listCredentials());
    const sessions = useLoaded(() => listSessions());
    const creds = credentials.value;
    const places = sessions.value;
    return (
        <AccountPage
            main={
                <>
                    <Credentials username={viewer?.username ?? ""} loaded={credentials} />
                    <Signins loaded={sessions} />
                </>
            }
            aside={
                creds === null ? null : (
                    <State
                        caption={SECURITY_COPY.signIn}
                        items={[
                            {
                                label: SECURITY_COPY.password,
                                value:
                                    creds.password === null
                                        ? SECURITY_COPY.none
                                        : SECURITY_COPY.passwordSet,
                            },
                            {
                                label: SECURITY_COPY.passkeys,
                                value:
                                    creds.passkeys.length === 0
                                        ? SECURITY_COPY.none
                                        : SECURITY_COPY.passwordSet,
                            },
                            {
                                label: SECURITY_COPY.app,
                                value:
                                    creds.totp?.confirmed === true
                                        ? SECURITY_COPY.appOn
                                        : SECURITY_COPY.none,
                            },
                            ...(places === null
                                ? []
                                : [
                                      {
                                          label: SECURITY_COPY.signedInPlaces,
                                          value: String(places.length),
                                      },
                                  ]),
                        ]}
                    />
                )
            }
        />
    );
}
