import { ActionSchema } from "@lucent/policy/actions";
import { can } from "@lucent/policy/policy";
import { getRouteApi, useRouteContext } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "../../../ui/Button/Button.tsx";
import { Empty } from "../../../ui/Empty/Empty.tsx";
import { Page } from "../../../ui/Page/Page.tsx";
import { Table } from "../../../ui/Table/Table.tsx";
import { memberOf, subjectOf, viewerCan } from "../../../viewer.ts";
import { RefusalNote } from "../../auth/RefusalNote.tsx";
import { ROLES_COPY } from "./copy.ts";
import { type Role, RoleEditor } from "./RoleEditor.tsx";
import styles from "./RolesPage.module.css";

const route = getRouteApi("/_admin/admin/roles");

// What the editor is open on: a role, a new one, or nothing.
type Editing = { readonly role: Role | null } | null;

export function RolesPage() {
    const listed = route.useLoaderData();
    const { session } = useRouteContext({ from: "__root__" });
    const viewer = memberOf(session);
    const [editing, setEditing] = useState<Editing>(null);
    if (viewer === null) return null;

    const subject = subjectOf(viewer);
    // A permission this site doesn't know can't be one the viewer holds, so only root edits it.
    const mayEdit = (role: Role) => {
        const known = role.permissions.flatMap((raw) => {
            const parsed = ActionSchema.safeParse(raw);
            return parsed.success ? [parsed.data] : [];
        });
        return (
            (subject.isRoot || known.length === role.permissions.length) &&
            can(subject, "roles:manage", { kind: "role", rank: role.rank, permissions: known })
        );
    };

    return (
        <Page
            title={ROLES_COPY.title}
            actions={
                viewerCan(viewer, "roles:manage") ? (
                    <Button tone="pink" size="sm" onClick={() => setEditing({ role: null })}>
                        {ROLES_COPY.new}
                    </Button>
                ) : undefined
            }
        >
            {listed.ok ? (
                listed.value.length === 0 ? (
                    <Empty>{ROLES_COPY.none}</Empty>
                ) : (
                    <Table
                        caption={ROLES_COPY.caption}
                        columns={[
                            {
                                key: "name",
                                header: ROLES_COPY.name,
                                cell: (role: Role) => (
                                    <>
                                        {role.name}
                                        {role.unknownPermissions.length === 0 ? null : (
                                            <span className={styles.unknown}>
                                                {ROLES_COPY.unknown}:{" "}
                                                {role.unknownPermissions.join(", ")}
                                            </span>
                                        )}
                                    </>
                                ),
                            },
                            { key: "rank", header: ROLES_COPY.rank, cell: (role) => role.rank },
                            {
                                key: "permissions",
                                header: ROLES_COPY.permissions,
                                cell: (role) => role.permissions.length,
                            },
                            {
                                key: "holders",
                                header: ROLES_COPY.holders,
                                cell: (role) => role.holders,
                            },
                            {
                                key: "edit",
                                header: "",
                                align: "end",
                                cell: (role) =>
                                    mayEdit(role) ? (
                                        <Button
                                            size="sm"
                                            tone="ghost"
                                            label={ROLES_COPY.editRole(role.name)}
                                            onClick={() => setEditing({ role })}
                                        >
                                            {ROLES_COPY.edit}
                                        </Button>
                                    ) : null,
                            },
                        ]}
                        rows={listed.value}
                        rowKey={(role) => role.roleId}
                    />
                )
            ) : (
                <RefusalNote refused={listed.refused} />
            )}
            {editing === null || !listed.ok ? null : (
                <RoleEditor
                    key={editing.role?.roleId ?? "new"}
                    role={editing.role}
                    existing={listed.value}
                    onClose={() => setEditing(null)}
                />
            )}
        </Page>
    );
}
