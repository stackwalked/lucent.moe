import { OperationId, RoleId } from "@lucent/core/scalars";
import { ActionSchema } from "@lucent/policy/actions";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { done, refuse } from "../../../server/outcome.ts";
import { callPlatform, readPlatform } from "../../../server/platform.ts";

// For the route's loader: a missing or unavailable list becomes the 404 or 503 page; any other
// refusal (FORBIDDEN, say) comes back for the page to show.
export const listRoles = createServerFn({ method: "GET" }).handler(async () => {
    const reply = await readPlatform("admin.roles.list", {});
    return reply.ok ? done(reply.value.roles) : refuse(reply.error);
});

// The operation id is the editor's own, so a second submit or the retry after a step-up replays
// one result. Channel grants aren't sent: platform keeps them as they are.
export const saveRole = createServerFn({ method: "POST" })
    .validator((data: unknown) =>
        z
            .strictObject({
                operationId: OperationId,
                roleId: RoleId,
                name: z.string().max(64),
                rank: z.number().int().nonnegative(),
                permissions: z.array(ActionSchema).max(64),
                labelColor: z
                    .enum(["pink", "shu", "ok", "wait", "violet", "aqua"])
                    .nullable()
                    .optional(),
            })
            .parse(data),
    )
    .handler(async ({ data }) => {
        // The editor's colour select always sends one once it exists; before it does, a role
        // has no colour to keep, so null is what absent means.
        const reply = await callPlatform("admin.roles.save", {
            ...data,
            labelColor: data.labelColor ?? null,
        });
        return reply.ok ? done(reply.value.roleId) : refuse(reply.error);
    });
