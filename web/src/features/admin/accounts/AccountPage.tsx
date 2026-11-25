import { isRoleId, type RoleId } from "@lucent/core/brands";
import { systemClock } from "@lucent/core/clock";
import { USERNAME_MAX_LENGTH, USERNAME_MIN_LENGTH, USERNAME_PATTERN } from "@lucent/core/rules";
import { type Action, isAction } from "@lucent/policy/action-list";
import { can } from "@lucent/policy/policy";
import { getRouteApi, Link, useRouteContext, useRouter } from "@tanstack/react-router";
import { useActionState, useState } from "react";
import type { Refused } from "../../../server/outcome.ts";
import { Button } from "../../../ui/Button/Button.tsx";
import { UI_COPY } from "../../../ui/copy.ts";
import { Empty } from "../../../ui/Empty/Empty.tsx";
import { Field } from "../../../ui/Field/Field.tsx";
import { Ident } from "../../../ui/Ident/Ident.tsx";
import { Page } from "../../../ui/Page/Page.tsx";
import { Pairs } from "../../../ui/Pairs/Pairs.tsx";
import { Section } from "../../../ui/Section/Section.tsx";
import { Stack } from "../../../ui/Stack/Stack.tsx";
import { Table } from "../../../ui/Table/Table.tsx";
import { TextField } from "../../../ui/TextField/TextField.tsx";
import { Time } from "../../../ui/Time/Time.tsx";
import { Who } from "../../../ui/Who/Who.tsx";
import { memberOf, subjectOf } from "../../../viewer.ts";
import { RefusalNote } from "../../auth/RefusalNote.tsx";
import { AUDIT_COPY } from "../audit/copy.ts";
import { ADMIN_COPY, operationLabel } from "../copy.ts";
import { AccountInvites } from "../invites/AccountInvites.tsx";
import { useStaffAction } from "../staff.ts";
import { AccountAction } from "./AccountAction.tsx";
import { AccountDevices } from "./AccountDevices.tsx";
import styles from "./AccountPage.module.css";
import { ACCOUNTS_COPY } from "./copy.ts";
import { Entitlements } from "./Entitlements.tsx";
import { SetupLink } from "./SetupLink.tsx";
import {
    giveRole,
    type RoleSummary,
    recoverAccount,
    reinstateAccount,
    renameAccount,
    suspendAccount,
    takeRole,
} from "./server.ts";
import { AccountStatusBadge } from "./status.tsx";
import { untilFrom } from "./until.ts";

const route = getRouteApi("/_admin/admin/accounts/$accountId");

type Data = ReturnType<typeof route.useLoaderData>;
type Account = Data["account"];

function knownActions(raw: readonly string[]): Action[] {
    return raw.flatMap((permission) => {
        return isAction(permission) ? [permission] : [];
    });
}

// "2 passkeys · password · app": why someone can or can't sign in, without touching a credential.
function signInSummary(signIn: Account["signIn"]): string {
    const parts = [
        ...(signIn.passkeys > 0 ? [ACCOUNTS_COPY.passkeys(signIn.passkeys)] : []),
        ...(signIn.password ? [ACCOUNTS_COPY.password] : []),
        ...(signIn.totp ? [ACCOUNTS_COPY.app] : []),
    ];
    return parts.length === 0 ? ACCOUNTS_COPY.noWayIn : parts.join(" · ");
}

// A role held until a day that has begun would be expired as it's given.
function afterToday(value: string): string | undefined {
    const until = untilFrom(value);
    return until !== null && until <= systemClock.now() ? ACCOUNTS_COPY.untilPast : undefined;
}

function GiveRole({
    account,
    roles,
}: {
    readonly account: Account;
    readonly roles: readonly RoleSummary[];
}) {
    const router = useRouter();
    const staff = useStaffAction();
    const [refused, submit, pending] = useActionState(async (_: Refused | null, form: FormData) => {
        const roleId = form.get("roleId");
        if (!isRoleId(roleId)) return null;
        const reply = await staff("roles:assign", () =>
            giveRole({
                data: {
                    accountId: account.accountId,
                    roleId,
                    expiresAt: untilFrom(form.get("until")),
                },
            }),
        );
        if (!reply.ok) return reply.refused;
        await router.invalidate();
        return null;
    }, null);
    if (roles.length === 0) return null;
    return (
        <form action={submit} noValidate className={styles.give}>
            <fieldset disabled={pending}>
                <Stack direction="row" gap={3} align="end">
                    <label className={styles.select}>
                        <span className={styles.label}>{ACCOUNTS_COPY.role}</span>
                        <select name="roleId" required className={styles.control}>
                            {roles.map((role) => (
                                <option key={role.roleId} value={role.roleId}>
                                    {role.name}
                                </option>
                            ))}
                        </select>
                    </label>
                    <Field label={ACCOUNTS_COPY.untilOptional} customCheck={afterToday}>
                        {(control) => <input {...control} type="date" name="until" />}
                    </Field>
                    <Button type="submit" pending={pending}>
                        {ACCOUNTS_COPY.give}
                    </Button>
                </Stack>
                <RefusalNote
                    refused={refused}
                    overrides={{ NO_PASSKEY: ADMIN_COPY.needsPasskey }}
                />
            </fieldset>
        </form>
    );
}

export function AccountPage() {
    const router = useRouter();
    const staff = useStaffAction();
    const { account, roles: listedRoles, catalog, invites } = route.useLoaderData();
    const roles = listedRoles.ok ? listedRoles.value : [];
    const { session } = useRouteContext({ from: "__root__" });
    const viewer = memberOf(session);
    const subject = viewer === null ? null : subjectOf(viewer);
    const name = account.username ?? account.email;

    // What the viewer may do to this account: never to themselves, never to root, only below
    // their own rank (can() decides, as platform will again).
    const target = {
        kind: "account",
        account: {
            accountId: account.accountId,
            isRoot: account.isRoot,
            isActive: account.status === "active",
            maxRank: Math.max(0, ...account.heldRoles.map((role) => role.rank)),
            permissions: new Set<Action>(),
        },
    } as const;
    const allowed = (action: Action) => subject !== null && can(subject, action, target);
    const assignable = roles.filter(
        (role) =>
            subject !== null &&
            !account.heldRoles.some((held) => held.roleId === role.roleId) &&
            can(subject, "roles:assign", {
                kind: "role",
                rank: role.rank,
                permissions: knownActions(role.permissions),
            }),
    );

    const [taking, setTaking] = useState<RoleId | null>(null);
    const [takeRefused, setTakeRefused] = useState<Refused | null>(null);
    const take = async (roleId: RoleId) => {
        setTaking(roleId);
        setTakeRefused(null);
        const reply = await staff("roles:assign", () =>
            takeRole({ data: { accountId: account.accountId, roleId } }),
        );
        if (reply.ok) await router.invalidate();
        else setTakeRefused(reply.refused);
        setTaking(null);
    };

    const danger = [
        allowed("accounts:suspend") && account.status !== "suspended" ? (
            <AccountAction
                key="suspend"
                action="accounts:suspend"
                label={ACCOUNTS_COPY.suspend}
                title={ACCOUNTS_COPY.suspendTitle(name)}
                tone="danger"
                icon="ban"
                fields={
                    <TextField
                        name="reason"
                        label={ACCOUNTS_COPY.reason}
                        required
                        maxLength={500}
                        customCheck={(value) =>
                            value.trim() === "" ? UI_COPY.required : undefined
                        }
                    />
                }
                run={(form, operationId) =>
                    suspendAccount({
                        data: {
                            operationId,
                            accountId: account.accountId,
                            reason: String(form.get("reason") ?? "").trim(),
                        },
                    })
                }
            />
        ) : null,
        allowed("accounts:reinstate") && account.status === "suspended" ? (
            <AccountAction
                key="reinstate"
                action="accounts:reinstate"
                label={ACCOUNTS_COPY.reinstate}
                title={ACCOUNTS_COPY.reinstateTitle(name)}
                icon="rotate-ccw"
                fields={<p>{ACCOUNTS_COPY.reinstateBody}</p>}
                run={(_, operationId) =>
                    reinstateAccount({ data: { operationId, accountId: account.accountId } })
                }
            />
        ) : null,
        allowed("accounts:rename") ? (
            <AccountAction
                key="rename"
                action="accounts:rename"
                label={ACCOUNTS_COPY.rename}
                title={ACCOUNTS_COPY.renameTitle(name)}
                icon="pencil"
                fields={
                    <TextField
                        name="username"
                        label={ACCOUNTS_COPY.newUsername}
                        hint={ACCOUNTS_COPY.usernameRules}
                        required
                        minLength={USERNAME_MIN_LENGTH}
                        maxLength={USERNAME_MAX_LENGTH}
                        pattern={USERNAME_PATTERN}
                    />
                }
                run={(form, operationId) =>
                    renameAccount({
                        data: {
                            operationId,
                            accountId: account.accountId,
                            username: String(form.get("username") ?? ""),
                        },
                    })
                }
            />
        ) : null,
        allowed("accounts:recover") ? (
            <AccountAction
                key="recover"
                action="accounts:recover"
                label={ACCOUNTS_COPY.recover}
                title={ACCOUNTS_COPY.recoverTitle(name)}
                tone="danger"
                icon="life-buoy"
                fields={
                    <Stack gap={3}>
                        <p>{ACCOUNTS_COPY.recoverBody}</p>
                        <TextField
                            name="confirm"
                            label={ACCOUNTS_COPY.typeToConfirm(name)}
                            required
                            customCheck={(typed) =>
                                typed === name ? undefined : ACCOUNTS_COPY.typeExactly(name)
                            }
                            maxLength={254}
                        />
                    </Stack>
                }
                run={() => recoverAccount({ data: { accountId: account.accountId } })}
                shown={(token) => <SetupLink token={token} />}
            />
        ) : null,
    ].filter((action) => action !== null);

    return (
        <Page
            title={account.username ?? account.email}
            width="narrow"
            trail={<Link to="/admin/accounts">{ACCOUNTS_COPY.title}</Link>}
        >
            <Section caption={ACCOUNTS_COPY.details}>
                <Pairs
                    items={[
                        {
                            label: ACCOUNTS_COPY.username,
                            value: account.username ?? ADMIN_COPY.pending,
                        },
                        { label: ACCOUNTS_COPY.email, value: account.email },
                        { label: ACCOUNTS_COPY.id, value: <Ident value={account.accountId} /> },
                        {
                            label: ACCOUNTS_COPY.status,
                            value: <AccountStatusBadge status={account.status} />,
                        },
                        { label: ACCOUNTS_COPY.signIn, value: signInSummary(account.signIn) },
                        { label: ACCOUNTS_COPY.created, value: <Time at={account.createdAt} /> },
                        {
                            label: ACCOUNTS_COPY.lastSeen,
                            value:
                                account.lastSeenAt === null ? (
                                    ACCOUNTS_COPY.never
                                ) : (
                                    <Time at={account.lastSeenAt} format="relative" />
                                ),
                        },
                    ]}
                />
            </Section>
            <Section caption={ACCOUNTS_COPY.heldRoles}>
                {account.heldRoles.length === 0 ? (
                    <Empty>{ACCOUNTS_COPY.noRoles}</Empty>
                ) : (
                    <Table
                        caption={ACCOUNTS_COPY.heldRoles}
                        columns={[
                            {
                                key: "name",
                                header: ACCOUNTS_COPY.role,
                                cell: (role: Account["heldRoles"][number]) => role.name,
                            },
                            {
                                key: "until",
                                header: ACCOUNTS_COPY.until,
                                cell: (role) =>
                                    role.expiresAt === null ? (
                                        ACCOUNTS_COPY.noExpiry
                                    ) : (
                                        <Time at={role.expiresAt} />
                                    ),
                            },
                            {
                                key: "take",
                                header: "",
                                align: "end",
                                cell: (role) =>
                                    subject !== null &&
                                    can(subject, "roles:assign", {
                                        kind: "role",
                                        rank: role.rank,
                                        permissions: knownActions(role.permissions),
                                    }) &&
                                    allowed("roles:assign") ? (
                                        <Button
                                            size="sm"
                                            tone="ghost"
                                            label={ACCOUNTS_COPY.takeRole(role.name)}
                                            pending={taking === role.roleId}
                                            onClick={() => void take(role.roleId)}
                                        >
                                            {ACCOUNTS_COPY.take}
                                        </Button>
                                    ) : null,
                            },
                        ]}
                        rows={account.heldRoles}
                        rowKey={(role) => role.roleId}
                    />
                )}
                <RefusalNote
                    refused={takeRefused}
                    overrides={{ NO_PASSKEY: ADMIN_COPY.needsPasskey }}
                />
                {allowed("roles:assign") ? (
                    listedRoles.ok ? (
                        <GiveRole account={account} roles={assignable} />
                    ) : (
                        <RefusalNote refused={listedRoles.refused} />
                    )
                ) : null}
            </Section>
            <Entitlements
                account={account}
                catalog={catalog}
                canIssue={allowed("entitlements:issue")}
            />
            <AccountInvites
                accountId={account.accountId}
                name={name}
                standing={invites}
                canGrant={allowed("accounts:create")}
            />
            <AccountDevices account={account} />
            {account.recentAudit === null ? null : (
                <Section
                    caption={ACCOUNTS_COPY.recent}
                    actions={
                        <Link
                            to="/admin/audit"
                            search={{ q: `target:${account.accountId}` }}
                            className={styles.more}
                        >
                            {ACCOUNTS_COPY.allActivity}
                        </Link>
                    }
                >
                    {account.recentAudit.length === 0 ? (
                        <Empty>{ACCOUNTS_COPY.noActivity}</Empty>
                    ) : (
                        <Table
                            caption={ACCOUNTS_COPY.recent}
                            columns={[
                                {
                                    key: "at",
                                    header: AUDIT_COPY.time,
                                    cell: (entry: NonNullable<Account["recentAudit"]>[number]) => (
                                        <Time at={entry.at} format="relative" />
                                    ),
                                },
                                {
                                    key: "op",
                                    header: AUDIT_COPY.operation,
                                    cell: (entry) => operationLabel(entry.operation),
                                },
                                {
                                    key: "actor",
                                    header: AUDIT_COPY.actor,
                                    align: "end",
                                    cell: (entry) => (
                                        <Who
                                            accountId={entry.actor.id}
                                            username={entry.actor.username}
                                            pending={ADMIN_COPY.pending}
                                        />
                                    ),
                                },
                            ]}
                            rows={account.recentAudit}
                            rowKey={(entry) => entry.id}
                        />
                    )}
                </Section>
            )}
            {danger.length === 0 ? null : (
                <Section caption={ACCOUNTS_COPY.danger}>
                    <Stack direction="row" gap={2}>
                        {danger}
                    </Stack>
                </Section>
            )}
        </Page>
    );
}
