import type { AccountId } from "@lucent/core/brands";
import type { Outcome } from "../../../server/outcome.ts";
import { Pairs } from "../../../ui/Pairs/Pairs.tsx";
import { Section } from "../../../ui/Section/Section.tsx";
import { Status } from "../../../ui/Status/Status.tsx";
import { TextField } from "../../../ui/TextField/TextField.tsx";
import { Who } from "../../../ui/Who/Who.tsx";
import { RefusalNote } from "../../auth/RefusalNote.tsx";
import { AccountAction } from "../accounts/AccountAction.tsx";
import { ADMIN_COPY } from "../copy.ts";
import { INVITE_TREE_COPY } from "./copy.ts";
import { grantInvites } from "./server.ts";

type Standing = {
    readonly granted: number;
    readonly spent: number;
    readonly invitedBy: { readonly accountId: AccountId; readonly username: string | null } | null;
    readonly invitees: number;
    readonly strikes: { readonly ever: number; readonly now: number };
};

const WHOLE = /^[0-9]{1,4}$/;

function grantedOf(form: FormData): number | null {
    const text = String(form.get("granted") ?? "").trim();
    if (!WHOLE.test(text)) return null;
    const value = Number(text);
    return value <= 1000 ? value : null;
}

// The account's place in the invite tree on its admin page: who invited it, what it may still
// issue, and how many of those it invited were suspended. Staff who may create accounts set how
// many invites it gets.
export function AccountInvites({
    accountId,
    name,
    standing,
    canGrant,
}: {
    readonly accountId: AccountId;
    readonly name: string;
    readonly standing: Outcome<Standing>;
    readonly canGrant: boolean;
}) {
    if (!standing.ok) {
        return (
            <Section caption={INVITE_TREE_COPY.invites}>
                <RefusalNote refused={standing.refused} />
            </Section>
        );
    }
    const { granted, spent, invitedBy, invitees, strikes } = standing.value;
    return (
        <Section
            caption={INVITE_TREE_COPY.invites}
            actions={
                canGrant ? (
                    <AccountAction
                        action="accounts:create"
                        label={INVITE_TREE_COPY.change}
                        title={INVITE_TREE_COPY.changeTitle(name)}
                        validate={(form) =>
                            grantedOf(form) === null ? INVITE_TREE_COPY.wholeNumber : undefined
                        }
                        fields={
                            <TextField
                                name="granted"
                                label={INVITE_TREE_COPY.granted}
                                hint={INVITE_TREE_COPY.changeBody}
                                inputMode="numeric"
                                pattern="[0-9]{1,4}"
                                required
                                maxLength={4}
                                defaultValue={String(granted)}
                            />
                        }
                        run={(form) =>
                            grantInvites({ data: { accountId, granted: grantedOf(form) ?? 0 } })
                        }
                    />
                ) : null
            }
        >
            <Pairs
                items={[
                    {
                        label: INVITE_TREE_COPY.invitedBy,
                        value:
                            invitedBy === null ? (
                                INVITE_TREE_COPY.nobody
                            ) : (
                                <Who
                                    accountId={invitedBy.accountId}
                                    username={invitedBy.username}
                                    pending={ADMIN_COPY.pending}
                                />
                            ),
                    },
                    {
                        label: INVITE_TREE_COPY.allowance,
                        value: INVITE_TREE_COPY.allowanceOf(spent, granted),
                    },
                    {
                        label: INVITE_TREE_COPY.invites,
                        value: INVITE_TREE_COPY.invitees(invitees),
                    },
                    {
                        label: INVITE_TREE_COPY.strikesLabel,
                        value: (
                            <Status tone={strikes.ever === 0 ? "neutral" : "shu"}>
                                {INVITE_TREE_COPY.strikes(strikes.ever, strikes.now)}
                            </Status>
                        ),
                    },
                ]}
            />
        </Section>
    );
}
