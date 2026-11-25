import { Link, useRouter } from "@tanstack/react-router";
import { useActionState, useEffect, useEffectEvent, useState } from "react";
import type { Outcome, Refused } from "../../server/outcome.ts";
import { Button } from "../../ui/Button/Button.tsx";
import { CodeInput } from "../../ui/CodeInput/CodeInput.tsx";
import { Refusal } from "../../ui/Refusal/Refusal.tsx";
import { Stack } from "../../ui/Stack/Stack.tsx";
import { TextField } from "../../ui/TextField/TextField.tsx";
import { forgetSession } from "../../viewer.ts";
import { assertPasskey, conditionalAvailable } from "../../webauthn.ts";
import { RESET_COPY, SIGN_IN_COPY, SIGN_IN_REFUSALS } from "./copy.ts";
import { RefusalNote } from "./RefusalNote.tsx";
import styles from "./SignInPage.module.css";
import {
    beginPasskey,
    finishPasskey,
    rememberedUsername,
    signInWithCode,
    signInWithPassword,
} from "./sign-in-server.ts";

type Factor = "totp" | "passkey";

type Step =
    | { readonly step: "password"; readonly username: string; readonly refused: Refused | null }
    | {
          readonly step: "second";
          readonly username: string;
          readonly factors: readonly Factor[];
          readonly using: Factor;
          readonly misses: number;
      };

// Platform allows five tries per sign-in; from the third miss the page counts down.
const MAX_TRIES = 5;

type PasskeyMode = "passkey-only" | "second-factor";

// One passkey sign-in, start to finish. "cancelled" (the prompt dismissed) shows nothing.
async function passkeySignIn(
    mode: PasskeyMode,
    options?: { readonly mediation: "conditional"; readonly signal: AbortSignal },
): Promise<Outcome<string> | "cancelled" | "unusable"> {
    const begun = await beginPasskey({ data: { mode } });
    if (!begun.ok) return begun;
    const asserted = await assertPasskey({ options: begun.value, ...options });
    if (!asserted.ok) return asserted.error === "cancelled" ? "cancelled" : "unusable";
    return await finishPasskey({ data: { mode, response: asserted.value } });
}

export function SignInPage() {
    const router = useRouter();
    const [step, setStep] = useState<Step>({ step: "password", username: "", refused: null });
    const [passkeyPending, setPasskeyPending] = useState(false);
    const [passkeyRefused, setPasskeyRefused] = useState<Refused | null>(null);
    const [unusable, setUnusable] = useState(false);
    const [autofill, setAutofill] = useState<AbortController | null>(null);

    const arrive = async (to: string) => {
        forgetSession();
        await router.navigate({ href: to, replace: true });
    };

    // A second step that timed out or ran out of tries starts over, username kept.
    const startOver = (refused: Refused | null) =>
        setStep({ step: "password", username: step.username, refused });

    const [, submitPassword, passwordPending] = useActionState(async (_: null, form: FormData) => {
        autofill?.abort();
        const username = String(form.get("username") ?? "");
        const reply = await signInWithPassword({
            data: { username, password: String(form.get("password") ?? "") },
        });
        if (!reply.ok) {
            setStep({ step: "password", username, refused: reply.refused });
            return null;
        }
        if (reply.value.next === "arrive") {
            await arrive(reply.value.to);
            return null;
        }
        const factors = reply.value.secondFactors;
        setPasskeyRefused(null);
        setStep({
            step: "second",
            username,
            factors,
            using: factors.includes("passkey") ? "passkey" : "totp",
            misses: 0,
        });
        return null;
    }, null);

    const [codeRefused, submitCode, codePending] = useActionState(
        async (_: Refused | null, form: FormData): Promise<Refused | null> => {
            const reply = await signInWithCode({ data: { code: String(form.get("code") ?? "") } });
            if (reply.ok) {
                await arrive(reply.value);
                return null;
            }
            if (reply.refused.code === "FLOW_INVALID") {
                startOver(reply.refused);
                return null;
            }
            if (reply.refused.code === "INVALID_CREDENTIALS" && step.step === "second") {
                setStep({ ...step, misses: step.misses + 1 });
            }
            return reply.refused;
        },
        null,
    );

    const arriveFromAutofill = useEffectEvent(arrive);

    // Saved passkeys offered in the username field's autofill: started quietly with the page, and
    // started again if it outlives its ten-minute flow.
    useEffect(() => {
        if (step.step !== "password") return;
        const controller = new AbortController();
        setAutofill(controller);
        const run = async (): Promise<void> => {
            if (!(await conditionalAvailable())) return;
            const outcome = await passkeySignIn("passkey-only", {
                mediation: "conditional",
                signal: controller.signal,
            });
            if (controller.signal.aborted || outcome === "cancelled" || outcome === "unusable")
                return;
            if (outcome.ok) return await arriveFromAutofill(outcome.value);
            if (outcome.refused.code === "FLOW_INVALID") return await run();
            setPasskeyRefused(outcome.refused);
        };
        void run();
        return () => controller.abort();
    }, [step.step]);

    const tryPasskey = async (mode: PasskeyMode) => {
        autofill?.abort();
        setPasskeyPending(true);
        setPasskeyRefused(null);
        setUnusable(false);
        const outcome = await passkeySignIn(mode);
        setPasskeyPending(false);
        if (outcome === "cancelled") return;
        if (outcome === "unusable") return setUnusable(true);
        if (outcome.ok) return await arrive(outcome.value);
        if (mode === "second-factor" && outcome.refused.code === "FLOW_INVALID") {
            return startOver(outcome.refused);
        }
        setPasskeyRefused(outcome.refused);
    };

    const [prefill, setPrefill] = useState("");
    useEffect(() => {
        void rememberedUsername().then(setPrefill);
    }, []);

    if (step.step === "second") {
        return (
            <Stack gap={5}>
                <h1 className={styles.title}>{SIGN_IN_COPY.secondTitle}</h1>
                {step.using === "passkey" ? (
                    <Stack gap={3}>
                        <RefusalNote refused={passkeyRefused} />
                        {unusable ? <Refusal>{SIGN_IN_COPY.passkeyUnusable}</Refusal> : null}
                        <Button
                            tone="pink"
                            icon="key-round"
                            pending={passkeyPending}
                            onClick={() => void tryPasskey("second-factor")}
                        >
                            {SIGN_IN_COPY.usePasskey}
                        </Button>
                        {step.factors.includes("totp") ? (
                            <Button
                                tone="ghost"
                                onClick={() => setStep({ ...step, using: "totp" })}
                            >
                                {SIGN_IN_COPY.useCode}
                            </Button>
                        ) : null}
                    </Stack>
                ) : (
                    <form action={submitCode} noValidate className={styles.form}>
                        <fieldset disabled={codePending}>
                            <Stack gap={4}>
                                <CodeInput name="code" label={SIGN_IN_COPY.code} />
                                <RefusalNote
                                    refused={codeRefused}
                                    overrides={SIGN_IN_REFUSALS.code}
                                    {...(step.misses >= 3 && step.misses < MAX_TRIES
                                        ? { extra: SIGN_IN_COPY.triesLeft(MAX_TRIES - step.misses) }
                                        : {})}
                                />
                            </Stack>
                        </fieldset>
                    </form>
                )}
                <Button tone="ghost" icon="arrow-left" onClick={() => startOver(null)}>
                    {SIGN_IN_COPY.startOver}
                </Button>
            </Stack>
        );
    }

    return (
        <Stack gap={5}>
            <h1 className={styles.title}>{SIGN_IN_COPY.title}</h1>
            <Button
                icon="key-round"
                pending={passkeyPending}
                onClick={() => void tryPasskey("passkey-only")}
            >
                {SIGN_IN_COPY.withPasskey}
            </Button>
            {unusable ? <Refusal>{SIGN_IN_COPY.passkeyUnusable}</Refusal> : null}
            <RefusalNote refused={passkeyRefused} />
            <form action={submitPassword} noValidate className={styles.form}>
                <fieldset disabled={passwordPending}>
                    <Stack gap={4}>
                        <TextField
                            name="username"
                            label={SIGN_IN_COPY.username}
                            autoComplete="username webauthn"
                            required
                            maxLength={64}
                            defaultValue={step.username === "" ? prefill : step.username}
                        />
                        <TextField
                            name="password"
                            label={SIGN_IN_COPY.password}
                            type="password"
                            autoComplete="current-password"
                            required
                            maxLength={1024}
                        />
                        <RefusalNote
                            refused={step.refused}
                            overrides={SIGN_IN_REFUSALS.secondFactor}
                        />
                        <Button tone="pink" type="submit" pending={passwordPending}>
                            {SIGN_IN_COPY.submit}
                        </Button>
                    </Stack>
                </fieldset>
            </form>
            <Link to="/reset-password">{RESET_COPY.title}</Link>
        </Stack>
    );
}
