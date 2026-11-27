import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import type { Outcome, Refused } from "../../server/outcome.ts";
import { Section } from "../../ui/Section/Section.tsx";
import { SettingRow, SettingRows } from "../../ui/SettingRow/SettingRow.tsx";
import { Switch } from "../../ui/Switch/Switch.tsx";
import { RefusalNote } from "../auth/RefusalNote.tsx";
import { PREFERENCES_COPY as C } from "./copy.ts";
import type { fetchPreferences } from "./server.ts";
import { savePreference } from "./server.ts";

type Loaded = Extract<Awaited<ReturnType<typeof fetchPreferences>>, { ok: true }>["value"];

// Security notices always reach the inbox and mail; whether they also reach Discord is the one
// choice, applied as the switch is flipped. Without a linked Discord there is nothing to switch.
export function NotificationsSection({ preferences }: { readonly preferences: Outcome<Loaded> }) {
    const router = useRouter();
    const [refused, setRefused] = useState<Refused | null>(null);
    // A refused flip leaves the switch where it was shown; bumping the key puts it back.
    const [attempt, setAttempt] = useState(0);

    if (!preferences.ok) {
        return (
            <Section caption={C.title}>
                <RefusalNote refused={preferences.refused} />
            </Section>
        );
    }
    const { discordLinked, securityDiscord } = preferences.value;

    const flip = async (discord: boolean) => {
        const reply = await savePreference({ data: { kind: "security", discord } });
        setRefused(reply.ok ? null : reply.refused);
        if (!reply.ok) setAttempt((n) => n + 1);
        await router.invalidate();
    };

    return (
        <Section caption={C.title}>
            <RefusalNote refused={refused} />
            <SettingRows label={C.title}>
                <SettingRow name={C.inboxAndEmail} value={C.always} />
                <SettingRow
                    name={C.discord}
                    {...(discordLinked ? {} : { value: C.needsDiscord })}
                    {...(discordLinked
                        ? {
                              action: (
                                  <Switch
                                      key={`${securityDiscord}/${attempt}`}
                                      name="discord"
                                      label={C.discord}
                                      hideLabel
                                      defaultChecked={securityDiscord}
                                      onChange={(on) => void flip(on)}
                                  />
                              ),
                          }
                        : {})}
                />
            </SettingRows>
        </Section>
    );
}
