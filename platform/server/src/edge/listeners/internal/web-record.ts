import type { Handlers } from "@lucent/rpc/mount";
import type { WebContract } from "@lucent/rpc/web";
import { addNote, deleteNote, listStaffNotes, updateNote } from "../../../members/record/notes.ts";
import { listMemberChangelog, readMemberStatus } from "../../../members/record/status.ts";
import { asStaff, done, mapOk, served, type WebRpcContext } from "./web-shared.ts";

export const recordHandlers = {
    "record.status.get": async (ctx, _input, { session }) =>
        served(
            await readMemberStatus(ctx.auth.db, { catalog: ctx.catalog, sessionToken: session }),
        ),
    "record.changelog.list": async (ctx, input, { session }) =>
        served(
            await listMemberChangelog(ctx.auth.db, {
                catalog: ctx.catalog,
                sessionToken: session,
                input,
            }),
        ),
    "admin.record.list": (ctx, _input, call) =>
        asStaff(ctx, call, async (caller) =>
            mapOk(await listStaffNotes(ctx.auth.db, { caller }), (listed) => ({
                ...listed,
                products: [...ctx.catalog.values()].map(({ id, name }) => ({ id, name })),
            })),
        ),
    "admin.changelog.add": (ctx, input, call) =>
        asStaff(ctx, call, async (caller) =>
            mapOk(
                await addNote(ctx.auth.db, {
                    caller,
                    catalog: ctx.catalog,
                    fields: input,
                }),
                ({ id }) => ({ entryId: id }),
            ),
        ),
    "admin.changelog.update": (ctx, input, call) =>
        asStaff(ctx, call, async (caller) => {
            const { entryId, ...fields } = input;
            return done(
                await updateNote(ctx.auth.db, {
                    caller,
                    catalog: ctx.catalog,
                    id: entryId,
                    fields,
                }),
            );
        }),
    "admin.changelog.delete": (ctx, input, call) =>
        asStaff(ctx, call, async (caller) =>
            done(await deleteNote(ctx.auth.db, { caller, id: input.entryId })),
        ),
} satisfies Partial<Handlers<WebRpcContext, WebContract>>;
