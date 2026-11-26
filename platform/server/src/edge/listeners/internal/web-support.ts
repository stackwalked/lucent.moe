import type { Handlers } from "@lucent/rpc/mount";
import type { WebContract } from "@lucent/rpc/web";
import { readAppeal, writeAppeal } from "../../../members/support/appeals.ts";
import {
    deleteResource,
    listMemberResources,
    listStaffResources,
    publishResource,
    updateResource,
} from "../../../members/support/resources.ts";
import {
    closeMemberTicket,
    closeStaffTicket,
    listMemberTickets,
    listStaffTickets,
    openMemberTicket,
    readMemberTicket,
    readStaffTicket,
    replyToTicket,
    setTicketConsent,
    writeMemberTicket,
} from "../../../members/support/tickets.ts";
import { asStaff, done, mapOk, served, type WebRpcContext } from "./web-shared.ts";

export const ticketsHandlers = {
    "tickets.list": async (ctx, input, { session }) =>
        served(await listMemberTickets(ctx.auth.db, session, input)),
    "tickets.get": async (ctx, input, { session }) =>
        served(await readMemberTicket(ctx.auth.db, session, input)),
    "tickets.open": async (ctx, input, { session }) =>
        served(await openMemberTicket(ctx.auth.db, session, { ...input, catalog: ctx.catalog })),
    "tickets.messages.send": async (ctx, input, { session }) =>
        served(done(await writeMemberTicket(ctx.auth.db, session, input))),
    "tickets.close": async (ctx, input, { session }) =>
        served(done(await closeMemberTicket(ctx.auth.db, session, input))),
    "tickets.consent.set": async (ctx, input, { session }) =>
        served(done(await setTicketConsent(ctx.auth.db, session, input))),
    "admin.tickets.list": (ctx, input, call) =>
        asStaff(ctx, call, (caller) => listStaffTickets(ctx.auth.db, { caller, ...input })),
    "admin.tickets.get": (ctx, input, call) =>
        asStaff(ctx, call, (caller) => readStaffTicket(ctx.auth.db, { caller, ...input })),
    "admin.tickets.reply": (ctx, input, call) =>
        asStaff(ctx, call, async (caller) =>
            done(
                await replyToTicket(ctx.auth.db, {
                    caller,
                    ...input,
                    site: { origin: ctx.auth.rp.origin, mail: ctx.auth.mailEnabled },
                }),
            ),
        ),
    "admin.tickets.close": (ctx, input, call) =>
        asStaff(ctx, call, async (caller) =>
            done(await closeStaffTicket(ctx.auth.db, { caller, ...input })),
        ),
} satisfies Partial<Handlers<WebRpcContext, WebContract>>;

export const appealsHandlers = {
    "appeals.read": async (ctx, _input, { session }) =>
        served(await readAppeal(ctx.auth.db, session)),
    "appeals.send": async (ctx, input, { session }) =>
        served(done(await writeAppeal(ctx.auth.db, session, input))),
} satisfies Partial<Handlers<WebRpcContext, WebContract>>;

export const resourcesHandlers = {
    "resources.list": async (ctx, _input, { session }) =>
        served(
            mapOk(
                await listMemberResources(ctx.auth.db, session, { catalog: ctx.catalog }),
                (items) => ({
                    items: items.map(({ digest: _digest, ...resource }) => resource),
                }),
            ),
        ),
    "admin.resources.list": (ctx, _input, call) =>
        asStaff(ctx, call, async (caller) =>
            mapOk(await listStaffResources(ctx.auth.db, { caller }), (listed) => ({
                ...listed,
                products: [...ctx.catalog.values()].map(({ id, name }) => ({ id, name })),
            })),
        ),
    "admin.resources.publish": (ctx, input, call) =>
        asStaff(ctx, call, (caller) => {
            const { digest, ...fields } = input;
            return publishResource(ctx.auth.db, {
                caller,
                catalog: ctx.catalog,
                artifactDir: ctx.artifactDir ?? null,
                digest,
                fields,
            });
        }),
    "admin.resources.update": (ctx, input, call) =>
        asStaff(ctx, call, async (caller) => {
            const { resourceId, ...fields } = input;
            return done(
                await updateResource(ctx.auth.db, {
                    caller,
                    catalog: ctx.catalog,
                    resourceId,
                    fields,
                }),
            );
        }),
    "admin.resources.delete": (ctx, input, call) =>
        asStaff(ctx, call, async (caller) =>
            done(await deleteResource(ctx.auth.db, { caller, ...input })),
        ),
} satisfies Partial<Handlers<WebRpcContext, WebContract>>;
