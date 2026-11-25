import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { done, refuse } from "../../../server/outcome.ts";
import { callPlatform, readPlatform } from "../../../server/platform.ts";

const ApplicationId = z.string().regex(/^[1-9][0-9]{0,18}$/);
const ById = z.strictObject({ applicationId: ApplicationId });

// The queue to work and the latest decisions, at once.
export const listApplications = createServerFn({ method: "GET" }).handler(async () => {
    const pending = await readPlatform("admin.applications.list", { state: "pending" });
    if (!pending.ok) return refuse(pending.error);
    const approved = await readPlatform("admin.applications.list", { state: "approved" });
    if (!approved.ok) return refuse(approved.error);
    const declined = await readPlatform("admin.applications.list", { state: "declined" });
    if (!declined.ok) return refuse(declined.error);
    return done({ pending: pending.value, approved: approved.value, declined: declined.value });
});

export const fetchApplication = createServerFn({ method: "GET" })
    .validator((data: unknown) => ById.parse(data))
    .handler(async ({ data }) => {
        const reply = await readPlatform("admin.applications.get", data);
        return reply.ok ? done(reply.value) : refuse(reply.error);
    });

// The setup link comes back only when no provider could mail it.
export const approveApplication = createServerFn({ method: "POST" })
    .validator((data: unknown) => ById.parse(data))
    .handler(async ({ data }) => {
        const reply = await callPlatform("admin.applications.approve", data);
        return reply.ok ? done(reply.value.setupToken) : refuse(reply.error);
    });

export const declineApplication = createServerFn({ method: "POST" })
    .validator((data: unknown) => ById.parse(data))
    .handler(async ({ data }) => {
        const reply = await callPlatform("admin.applications.decline", data);
        return reply.ok ? done(null) : refuse(reply.error);
    });
