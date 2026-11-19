import { AccountId, EpochMs, OperationId, RoleId } from "@lucent/core/scalars";
import { AccountStatus, type WebContract } from "@lucent/rpc/web";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { done, refuse } from "../../../server/outcome.ts";
import { callPlatform, readPlatform, requestReference } from "../../../server/platform.ts";
import { toUnavailable } from "../../../server/route-control.ts";
import { auditDetail } from "../audit/filter.ts";

// Reads throw the router's 404 or the 503 page through readPlatform. The list's refusals come back
// to the page (an INVALID_CURSOR after the list moved on is the member's to recover from); one
// account's become the unavailable page, since a guard already showed it only to staff who may
// read it.

const ListInput = z.strictObject({
    status: AccountStatus.nullable(),
    roleId: RoleId.nullable(),
    text: z.string().trim().min(1).max(64).nullable(),
    sort: z.enum(["newest", "username"]),
    cursor: z.string().max(512).nullable(),
});

export const fetchAccounts = createServerFn({ method: "GET" })
    .validator((data: unknown) => ListInput.parse(data))
    .handler(async ({ data }) => {
        const reply = await readPlatform("admin.accounts.list", {
            filter: { status: data.status, roleId: data.roleId, text: data.text },
            sort: data.sort,
            cursor: data.cursor,
        });
        return reply.ok ? done(reply.value) : refuse(reply.error);
    });

export const fetchAccount = createServerFn({ method: "GET" })
    .validator((data: unknown) => z.strictObject({ accountId: AccountId }).parse(data))
    .handler(async ({ data }) => {
        const reply = await readPlatform("admin.accounts.get", data);
        if (!reply.ok) return toUnavailable(requestReference());
        // The free-form audit detail is reduced to what the page shows; the raw record stays here.
        const { recentAudit, ...account } = reply.value;
        return {
            ...account,
            recentAudit:
                recentAudit === null
                    ? null
                    : recentAudit.map((entry) => ({
                          id: entry.id,
                          at: entry.at,
                          actor: entry.actor,
                          operation: entry.operation,
                          target: {
                              accountId: entry.target.accountId,
                              username: entry.target.username,
                          },
                          detail: auditDetail(entry.operation, entry.target.detail),
                      })),
        };
    });

// Roles to offer when giving one: empty for staff who can't read roles.
export type RoleSummary = z.output<WebContract["admin.roles.list"]["output"]>["roles"][number];

export const fetchRoles = createServerFn({ method: "GET" }).handler(
    async (): Promise<RoleSummary[]> => {
        const reply = await callPlatform("admin.roles.list", {});
        return reply.ok ? [...reply.value.roles] : [];
    },
);

export const createAccount = createServerFn({ method: "POST" })
    .validator((data: unknown) =>
        z.strictObject({ operationId: OperationId, email: z.string().max(254) }).parse(data),
    )
    .handler(async ({ data }) => {
        const reply = await callPlatform("admin.accounts.create", data);
        return reply.ok ? done(reply.value) : refuse(reply.error);
    });

const Target = { operationId: OperationId, accountId: AccountId };

export const suspendAccount = createServerFn({ method: "POST" })
    .validator((data: unknown) =>
        z.strictObject({ ...Target, reason: z.string().max(500) }).parse(data),
    )
    .handler(async ({ data }) => {
        const reply = await callPlatform("admin.accounts.suspend", data);
        return reply.ok ? done(null) : refuse(reply.error);
    });

export const reinstateAccount = createServerFn({ method: "POST" })
    .validator((data: unknown) => z.strictObject(Target).parse(data))
    .handler(async ({ data }) => {
        const reply = await callPlatform("admin.accounts.reinstate", data);
        return reply.ok ? done(null) : refuse(reply.error);
    });

export const renameAccount = createServerFn({ method: "POST" })
    .validator((data: unknown) =>
        z.strictObject({ ...Target, username: z.string().max(64) }).parse(data),
    )
    .handler(async ({ data }) => {
        const reply = await callPlatform("admin.accounts.rename", data);
        return reply.ok ? done(reply.value.username) : refuse(reply.error);
    });

export const recoverAccount = createServerFn({ method: "POST" })
    .validator((data: unknown) => z.strictObject({ accountId: AccountId }).parse(data))
    .handler(async ({ data }) => {
        const reply = await callPlatform("admin.accounts.recover", data);
        return reply.ok ? done(reply.value.setupToken) : refuse(reply.error);
    });

export const giveRole = createServerFn({ method: "POST" })
    .validator((data: unknown) =>
        z
            .strictObject({ accountId: AccountId, roleId: RoleId, expiresAt: EpochMs.nullable() })
            .parse(data),
    )
    .handler(async ({ data }) => {
        const reply = await callPlatform("admin.roles.assign", data);
        return reply.ok ? done(null) : refuse(reply.error);
    });

export const takeRole = createServerFn({ method: "POST" })
    .validator((data: unknown) =>
        z.strictObject({ accountId: AccountId, roleId: RoleId }).parse(data),
    )
    .handler(async ({ data }) => {
        const reply = await callPlatform("admin.roles.unassign", data);
        return reply.ok ? done(null) : refuse(reply.error);
    });
