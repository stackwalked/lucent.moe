import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import type { Outcome, Refused } from "../../server/outcome.ts";
import { Section } from "../../ui/Section/Section.tsx";
import { RowAction, SettingRow, SettingRows } from "../../ui/SettingRow/SettingRow.tsx";
import { Time } from "../../ui/Time/Time.tsx";
import { useToast } from "../../ui/Toast/Toast.tsx";
import { RefusalNote } from "../auth/RefusalNote.tsx";
import { useAddPasskey } from "../credentials/AddPasskey.tsx";
import { AppDialog, type Enrolled } from "../credentials/AppDialog.tsx";
import { PasswordDialog } from "../credentials/PasswordDialog.tsx";
import { enrollTotp, type listCredentials, removeCredential } from "../credentials/server.ts";
import { useStepUp } from "../step-up/StepUp.tsx";
import { SECURITY_COPY as C } from "./copy.ts";

type Credentials = Extract<Awaited<ReturnType<typeof listCredentials>>, { ok: true }>["value"];
type CredentialRef = { readonly kind: "passkey"; readonly id: string } | { readonly kind: "totp" };

// Password, passkeys and the authenticator app. A change needs a recent proof (the step-up
// dialog, or a fresh sign-in for an account without a passkey); each action is sent again after
// it.
export function SignInSection({
    credentials,
    username,
}: {
    readonly credentials: Outcome<Credentials>;
    readonly username: string;
}) {
    const router = useRouter();
    const guard = useStepUp();
    const toast = useToast();
    const [changing, setChanging] = useState(false);
    const [enrolled, setEnrolled] = useState<Enrolled | null>(null);
    const [starting, setStarting] = useState(false);
    const [removing, setRemoving] = useState<string | null>(null);
    const [refused, setRefused] = useState<Refused | null>(null);
    const passkey = useAddPasskey(() => void router.invalidate());

    if (!credentials.ok) {
        return (
            <Section caption={C.signIn}>
                <RefusalNote refused={credentials.refused} />
            </Section>
        );
    }
    const value = credentials.value;

    const remove = async (credential: CredentialRef, key: string) => {
        setRemoving(key);
        setRefused(null);
        const reply = await guard(() => removeCredential({ data: { credential } }));
        setRemoving(null);
        if (!reply.ok) return setRefused(reply.refused);
        toast(C.removed);
        await router.invalidate();
    };
    const startApp = async () => {
        setStarting(true);
        setRefused(null);
        const reply = await guard(() => enrollTotp());
        setStarting(false);
        if (!reply.ok) return setRefused(reply.refused);
        setEnrolled(reply.value);
    };

    return (
        <Section caption={C.signIn}>
            <RefusalNote refused={refused ?? passkey.refused} />
            <SettingRows label={C.signIn}>
                <SettingRow
                    name={C.password}
                    value={
                        value.password === null ? (
                            C.none
                        ) : (
                            <>
                                {C.changed} <Time at={value.password.updatedAt} format="relative" />
                            </>
                        )
                    }
                    action={
                        <RowAction
                            tone={value.password === null ? "pink" : "ink"}
                            onClick={() => setChanging(true)}
                        >
                            {value.password === null ? C.add : C.change}
                        </RowAction>
                    }
                />
                <SettingRow
                    name={C.passkeys}
                    value={value.passkeys.length === 0 ? C.none : String(value.passkeys.length)}
                    action={
                        <RowAction
                            tone="pink"
                            pending={passkey.pending}
                            onClick={() => void passkey.add()}
                        >
                            {C.add}
                        </RowAction>
                    }
                />
                {value.passkeys.map((p) => (
                    <SettingRow
                        key={p.id}
                        nested
                        name={p.label}
                        value={
                            p.lastUsedAt === null ? (
                                C.never
                            ) : (
                                <Time at={p.lastUsedAt} format="relative" />
                            )
                        }
                        action={
                            <RowAction
                                tone="quiet"
                                label={C.removeLabel(p.label)}
                                pending={removing === p.id}
                                onClick={() => void remove({ kind: "passkey", id: p.id }, p.id)}
                            >
                                {C.remove}
                            </RowAction>
                        }
                    />
                ))}
                <SettingRow
                    name={C.app}
                    value={value.totp?.confirmed === true ? C.on : C.off}
                    action={
                        value.totp?.confirmed === true ? (
                            <RowAction
                                tone="quiet"
                                pending={removing === "totp"}
                                onClick={() => void remove({ kind: "totp" }, "totp")}
                            >
                                {C.remove}
                            </RowAction>
                        ) : (
                            <RowAction
                                tone="pink"
                                pending={starting}
                                onClick={() => void startApp()}
                            >
                                {C.add}
                            </RowAction>
                        )
                    }
                />
            </SettingRows>
            <PasswordDialog
                open={changing}
                adding={value.password === null}
                username={username}
                onClose={() => setChanging(false)}
                onSet={() => {
                    setChanging(false);
                    void router.invalidate();
                }}
            />
            <AppDialog
                enrolled={enrolled}
                onClose={() => setEnrolled(null)}
                onAdded={() => {
                    setEnrolled(null);
                    void router.invalidate();
                }}
            />
        </Section>
    );
}
