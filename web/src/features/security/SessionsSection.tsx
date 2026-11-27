import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import type { Outcome, Refused } from "../../server/outcome.ts";
import { Section } from "../../ui/Section/Section.tsx";
import { RowAction, RowMark, SettingRow, SettingRows } from "../../ui/SettingRow/SettingRow.tsx";
import { Time } from "../../ui/Time/Time.tsx";
import { useToast } from "../../ui/Toast/Toast.tsx";
import { deviceLabel } from "../../user-agent.ts";
import { RefusalNote } from "../auth/RefusalNote.tsx";
import { SECURITY_COPY as C } from "./copy.ts";
import { endOtherSessions, endSession, type listSessions } from "./server.ts";

type Sessions = Extract<Awaited<ReturnType<typeof listSessions>>, { ok: true }>["value"];

const SHOWN = 5;

// Where the member is signed in: the five most recent, the rest behind "more". This one is
// marked and has nothing to end.
export function SessionsSection({ sessions }: { readonly sessions: Outcome<Sessions> }) {
    const router = useRouter();
    const toast = useToast();
    const [all, setAll] = useState(false);
    const [busy, setBusy] = useState<string | null>(null);
    const [refused, setRefused] = useState<Refused | null>(null);

    if (!sessions.ok) {
        return (
            <Section caption={C.sessions}>
                <RefusalNote refused={sessions.refused} />
            </Section>
        );
    }
    const ordered = sessions.value.toSorted(
        (a, b) => Number(b.current) - Number(a.current) || b.lastSeenAt - a.lastSeenAt,
    );
    const shown = all ? ordered : ordered.slice(0, SHOWN);

    const end = async (key: string, run: () => Promise<Outcome<null>>, said: string) => {
        setBusy(key);
        setRefused(null);
        const reply = await run();
        setBusy(null);
        if (!reply.ok) return setRefused(reply.refused);
        toast(said);
        await router.invalidate();
    };

    return (
        <Section
            caption={C.sessions}
            actions={
                ordered.length > 1 ? (
                    <RowAction
                        tone="quiet"
                        pending={busy === "others"}
                        onClick={() =>
                            void end("others", () => endOtherSessions(), C.signedOutEverywhere)
                        }
                    >
                        {C.signOutEverywhere}
                    </RowAction>
                ) : undefined
            }
        >
            <RefusalNote refused={refused} />
            <SettingRows label={C.sessions}>
                {shown.map((s) => {
                    const name = deviceLabel(s.client.userAgent, C.unknownDevice);
                    return (
                        <SettingRow
                            key={s.sessionId}
                            layout="item"
                            name={name}
                            value={<Time at={s.lastSeenAt} format="relative" />}
                            action={
                                s.current ? (
                                    <RowMark>{C.thisOne}</RowMark>
                                ) : (
                                    <RowAction
                                        tone="quiet"
                                        label={C.signOutLabel(name)}
                                        pending={busy === s.sessionId}
                                        onClick={() =>
                                            void end(
                                                s.sessionId,
                                                () =>
                                                    endSession({
                                                        data: { sessionId: s.sessionId },
                                                    }),
                                                C.sessionEnded,
                                            )
                                        }
                                    >
                                        {C.signOut}
                                    </RowAction>
                                )
                            }
                        />
                    );
                })}
                {all || ordered.length <= SHOWN ? null : (
                    <SettingRow
                        layout="item"
                        name={
                            <RowAction tone="quiet" onClick={() => setAll(true)}>
                                {C.more}
                            </RowAction>
                        }
                    />
                )}
            </SettingRows>
        </Section>
    );
}
