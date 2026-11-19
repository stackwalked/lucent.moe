import { USERNAME_MAX_LENGTH, USERNAME_MIN_LENGTH, USERNAME_PATTERN } from "@lucent/core/rules";
import { useRouteContext, useRouter } from "@tanstack/react-router";
import { useActionState, useEffect, useEffectEvent, useState } from "react";
import type { Refused } from "../../server/outcome.ts";
import { Button } from "../../ui/Button/Button.tsx";
import { Refusal } from "../../ui/Refusal/Refusal.tsx";
import { Stack } from "../../ui/Stack/Stack.tsx";
import { TextField } from "../../ui/TextField/TextField.tsx";
import { forgetSession, type Viewer } from "../../viewer.ts";
import { RefusalNote } from "../auth/RefusalNote.tsx";
import { AddApp } from "../credentials/AddApp.tsx";
import { AddPasskey } from "../credentials/AddPasskey.tsx";
import { SetPassword } from "../credentials/SetPassword.tsx";
import { listCredentials } from "../credentials/server.ts";
import { SETUP_COPY } from "./copy.ts";
import styles from "./SetupPage.module.css";
import { chooseUsername, finishSetup, redeemSetup, setupLinkWaiting } from "./server.ts";

type Paths = { readonly passkeys: number; readonly password: boolean; readonly app: boolean };

function canSignIn(paths: Paths): boolean {
    return paths.passkeys > 0 || (paths.password && paths.app);
}

function useRefresh() {
    const router = useRouter();
    return async () => {
        forgetSession();
        await router.invalidate();
    };
}

// The link's first page: nothing is used up until Continue (a POST).
function Redeem({ member }: { readonly member: Viewer | null }) {
    const refresh = useRefresh();
    const [waiting, setWaiting] = useState<boolean | null>(null);
    useEffect(() => {
        void setupLinkWaiting().then(setWaiting);
    }, []);
    const [refused, redeem, pending] = useActionState(async (): Promise<Refused | null> => {
        const reply = await redeemSetup();
        if (!reply.ok) return reply.refused;
        await refresh();
        return null;
    }, null);

    if (waiting === null) return null;
    if (!waiting) return <Refusal>{SETUP_COPY.noLink}</Refusal>;
    return (
        <form action={redeem}>
            <Stack gap={4}>
                <h1 className={styles.title}>{SETUP_COPY.title}</h1>
                {member === null ? null : <p>{SETUP_COPY.signedInAs(member.username ?? "")}</p>}
                <RefusalNote refused={refused} />
                <div>
                    <Button tone="pink" type="submit" pending={pending}>
                        {SETUP_COPY.continue}
                    </Button>
                </div>
            </Stack>
        </form>
    );
}

function Username() {
    const refresh = useRefresh();
    const [refused, choose, pending] = useActionState(async (_: Refused | null, form: FormData) => {
        const reply = await chooseUsername({
            data: { username: String(form.get("username") ?? "") },
        });
        if (!reply.ok) return reply.refused;
        await refresh();
        return null;
    }, null);
    const fieldError =
        refused?.code === "USERNAME_TAKEN" || refused?.code === "INVALID_USERNAME" ? refused : null;
    return (
        <form action={choose} noValidate>
            <fieldset disabled={pending}>
                <Stack gap={4}>
                    <h1 className={styles.title}>{SETUP_COPY.usernameTitle}</h1>
                    <TextField
                        name="username"
                        label={SETUP_COPY.username}
                        hint={SETUP_COPY.usernameRules}
                        autoComplete="username"
                        required
                        minLength={USERNAME_MIN_LENGTH}
                        maxLength={USERNAME_MAX_LENGTH}
                        pattern={USERNAME_PATTERN}
                    />
                    <RefusalNote refused={fieldError ?? refused} />
                    <div>
                        <Button tone="pink" type="submit" pending={pending}>
                            {SETUP_COPY.chooseUsername}
                        </Button>
                    </div>
                </Stack>
            </fieldset>
        </form>
    );
}

// Choosing how to sign in, until there's at least one way; then done, with room for another.
function WaysIn({ username }: { readonly username: string }) {
    const router = useRouter();
    const [paths, setPaths] = useState<Paths | null>(null);
    const [refused, setRefused] = useState<Refused | null>(null);
    const [method, setMethod] = useState<"passkey" | "password" | null>(null);
    const [finishing, setFinishing] = useState(false);

    const reload = async () => {
        const reply = await listCredentials();
        if (!reply.ok) return setRefused(reply.refused);
        setPaths({
            passkeys: reply.value.passkeys.length,
            password: reply.value.password !== null,
            app: reply.value.totp?.confirmed === true,
        });
    };
    const loadOnce = useEffectEvent(() => void reload());
    useEffect(() => loadOnce(), []);

    const added = () => {
        setMethod(null);
        void reload();
    };

    const finish = async () => {
        setFinishing(true);
        await finishSetup({ data: { username } });
        forgetSession();
        await router.navigate({ to: "/sign-in" });
    };

    if (refused !== null) return <RefusalNote refused={refused} />;
    if (paths === null) return null;

    if (method === "passkey") return <AddPasskey onAdded={added} />;
    if (method === "password") {
        return paths.password ? (
            <AddApp onAdded={added} />
        ) : (
            <SetPassword username={username} onSet={() => void reload()} />
        );
    }
    if (canSignIn(paths)) {
        return (
            <Stack gap={4}>
                <h1 className={styles.title}>{SETUP_COPY.doneTitle}</h1>
                <Stack direction="row" gap={2}>
                    <Button tone="pink" pending={finishing} onClick={() => void finish()}>
                        {SETUP_COPY.finish}
                    </Button>
                    <Button
                        tone="ghost"
                        onClick={() => setMethod(paths.passkeys > 0 ? "password" : "passkey")}
                    >
                        {SETUP_COPY.addAnother}
                    </Button>
                </Stack>
            </Stack>
        );
    }
    return (
        <Stack gap={4}>
            <h1 className={styles.title}>{SETUP_COPY.methodTitle}</h1>
            <Button tone="pink" icon="key-round" onClick={() => setMethod("passkey")}>
                {SETUP_COPY.passkey}
            </Button>
            <Button icon="smartphone" onClick={() => setMethod("password")}>
                {SETUP_COPY.passwordAndApp}
            </Button>
        </Stack>
    );
}

export function SetupPage() {
    const { session } = useRouteContext({ from: "__root__" });
    const viewer = session.state === "signed-in" ? session.viewer : null;
    if (viewer?.purpose !== "setup") return <Redeem member={viewer} />;
    if (viewer.username === null) return <Username />;
    return <WaysIn username={viewer.username} />;
}
