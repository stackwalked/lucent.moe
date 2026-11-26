import { newOperationId } from "@lucent/core/brands";
import { systemCryptoRng } from "@lucent/core/rng";
import { ACTIONS, type Action, isAction } from "@lucent/policy/action-list";
import { can } from "@lucent/policy/policy";
import { useRouteContext, useRouter } from "@tanstack/react-router";
import { useActionState, useId, useState } from "react";
import type { Outcome, Refused } from "../../../server/outcome.ts";
import { Button } from "../../../ui/Button/Button.tsx";
import { Check } from "../../../ui/Check/Check.tsx";
import { Dialog } from "../../../ui/Dialog/Dialog.tsx";
import { Select } from "../../../ui/Select/Select.tsx";
import { Stack } from "../../../ui/Stack/Stack.tsx";
import { TextField } from "../../../ui/TextField/TextField.tsx";
import { memberOf, subjectOf } from "../../../viewer.ts";
import { RefusalNote } from "../../auth/RefusalNote.tsx";
import { ADMIN_COPY } from "../copy.ts";
import { useStaffAction } from "../staff.ts";
import { ROLES_COPY } from "./copy.ts";
import styles from "./RoleEditor.module.css";
import { type listRoles, saveRole } from "./server.ts";
import { roleIdFor } from "./slug.ts";

export type Roles = Extract<Awaited<ReturnType<typeof listRoles>>, { ok: true }>["value"];
export type Role = Roles[number];

type Problem = { readonly field: "name" | "rank"; readonly message: string };
type Result = { readonly refused: Refused | null; readonly problem: Problem | null };

const CLEAN: Result = { refused: null, problem: null };

function areaOf(action: Action): string {
    return action.split(":")[0] ?? action;
}

function verbOf(action: Action): string {
    return action.split(":")[1] ?? action;
}

// Permissions grouped by the part before ":", in the order the list has them.
function grouped(offered: readonly Action[]): readonly (readonly [string, readonly Action[]])[] {
    const areas = [...new Set(offered.map(areaOf))];
    return areas.map((area) => [area, offered.filter((action) => areaOf(action) === area)]);
}

function permissionsOf(form: FormData): Action[] {
    return form.getAll("permissions").flatMap((raw) => {
        return isAction(raw) ? [raw] : [];
    });
}

// One editor per open: its operation id is made when it opens and sent with every submit, so a
// double submit or the retry after a step-up replays one result. The caller mounts it only while
// open, with a key per role.
export function RoleEditor({
    role,
    existing,
    onClose,
}: {
    // Null makes a new role.
    readonly role: Role | null;
    readonly existing: Roles;
    readonly onClose: () => void;
}) {
    const router = useRouter();
    const staff = useStaffAction();
    const formId = useId();
    const { session } = useRouteContext({ from: "__root__" });
    const viewer = memberOf(session);
    const [operationId] = useState(() => newOperationId(systemCryptoRng));

    const [result, submit, pending] = useActionState(
        async (_: Result, form: FormData): Promise<Result> => {
            if (viewer === null) return CLEAN;
            const subject = subjectOf(viewer);
            const name = String(form.get("name") ?? "").trim();
            const roleId = role === null ? roleIdFor(name) : role.roleId;
            if (roleId === null) {
                return {
                    refused: null,
                    problem: { field: "name", message: ROLES_COPY.nameProblem },
                };
            }
            // Saving under an existing id would rewrite that role.
            if (role === null && existing.some((other) => other.roleId === roleId)) {
                return { refused: null, problem: { field: "name", message: ROLES_COPY.nameTaken } };
            }
            const typed = String(form.get("rank") ?? "").trim();
            const rank = /^\d{1,9}$/.test(typed) ? Number(typed) : null;
            if (rank === null || (!subject.isRoot && rank >= subject.maxRank)) {
                return {
                    refused: null,
                    problem: { field: "rank", message: ROLES_COPY.rankProblem },
                };
            }
            const permissions = permissionsOf(form);
            if (!can(subject, "roles:manage", { kind: "role", rank, permissions })) {
                return { refused: { code: "FORBIDDEN", reference: null }, problem: null };
            }
            const colourRaw = String(form.get("labelColor") ?? "");
            const labelColor = (["pink", "shu", "ok", "wait", "violet", "aqua"] as const).find(
                (colour) => colour === colourRaw,
            );
            const reply: Outcome<unknown> = await staff("roles:manage", () =>
                saveRole({
                    data: {
                        operationId,
                        roleId,
                        name,
                        rank,
                        permissions,
                        labelColor: labelColor ?? null,
                    },
                }),
            );
            if (!reply.ok) return { refused: reply.refused, problem: null };
            await router.invalidate();
            onClose();
            return CLEAN;
        },
        CLEAN,
    );

    if (viewer === null) return null;
    const subject = subjectOf(viewer);
    const offered = ACTIONS.filter((action) => subject.isRoot || subject.permissions.has(action));
    const held = new Set<string>(role?.permissions ?? []);
    const problem = (field: Problem["field"]) =>
        result.problem?.field === field ? { error: result.problem.message } : {};
    const unknown = role?.unknownPermissions ?? [];

    return (
        <Dialog
            open
            onClose={onClose}
            title={role === null ? ROLES_COPY.new : ROLES_COPY.editTitle}
            actions={
                <>
                    <Button onClick={onClose}>{ROLES_COPY.cancel}</Button>
                    <Button tone="pink" type="submit" form={formId} pending={pending}>
                        {ROLES_COPY.save}
                    </Button>
                </>
            }
        >
            <form id={formId} action={submit} noValidate>
                <fieldset disabled={pending} className={styles.group}>
                    <Stack gap={4}>
                        <RefusalNote
                            refused={result.refused}
                            overrides={{ NO_PASSKEY: ADMIN_COPY.needsPasskey }}
                        />
                        <TextField
                            name="name"
                            label={ROLES_COPY.name}
                            required
                            maxLength={64}
                            defaultValue={role?.name ?? ""}
                            {...problem("name")}
                        />
                        <TextField
                            name="rank"
                            label={ROLES_COPY.rank}
                            inputMode="numeric"
                            required
                            defaultValue={String(role?.rank ?? 0)}
                            hint={
                                subject.isRoot
                                    ? ROLES_COPY.rankRoot
                                    : ROLES_COPY.rankBelow(subject.maxRank)
                            }
                            {...problem("rank")}
                        />
                        <Select
                            name="labelColor"
                            label={ROLES_COPY.labelColor}
                            defaultValue={role?.labelColor ?? ""}
                            options={[
                                { value: "", label: ROLES_COPY.noColour },
                                { value: "pink", label: "pink" },
                                { value: "shu", label: "shu" },
                                { value: "ok", label: "ok" },
                                { value: "wait", label: "wait" },
                                { value: "violet", label: "violet" },
                                { value: "aqua", label: "aqua" },
                            ]}
                        />
                        {offered.length === 0 ? (
                            <p className={styles.note}>{ROLES_COPY.noPermissions}</p>
                        ) : (
                            grouped(offered).map(([area, actions]) => (
                                <fieldset key={area} className={styles.group}>
                                    <legend className={styles.groupName}>{area}</legend>
                                    <div className={styles.checks}>
                                        {actions.map((action) => (
                                            <Check
                                                key={action}
                                                name="permissions"
                                                value={action}
                                                label={verbOf(action)}
                                                defaultChecked={held.has(action)}
                                            />
                                        ))}
                                    </div>
                                </fieldset>
                            ))
                        )}
                        {unknown.length === 0 ? null : (
                            <p className={styles.note}>
                                {ROLES_COPY.dropsUnknown(unknown.join(", "))}
                            </p>
                        )}
                    </Stack>
                </fieldset>
            </form>
        </Dialog>
    );
}
