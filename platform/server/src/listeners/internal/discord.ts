import type { ProductCatalog } from "@lucent/catalog/catalog";
import { err, ok } from "@lucent/core/result";
import {
    DISCORD_RPC_PATH,
    type DiscordContract,
    discordContract,
} from "@lucent/rpc/discord/contract";
import { implement, mountInternalRpc } from "@lucent/rpc/mount";
import type { Hono } from "hono";
import type { Logger } from "../../core/log.ts";
import type { EpochGuard } from "../../db/epoch-guard.ts";
import type { Db } from "../../db/pool.ts";
import { readDueDms, settleDm } from "../../discord/dms.ts";
import { readPendingPosts, recordPost } from "../../discord/feeds.ts";
import { redeemLinkCode, removeDiscordLinkByUser } from "../../discord/links.ts";
import {
    openTicketFromDiscord,
    readMe,
    readStatus,
    readTicketProducts,
} from "../../discord/member.ts";
import { listRules } from "../../discord/rules.ts";
import { readChanges, resolveMembers } from "../../discord/sync.ts";
import { done, mapOk, served } from "./web-shared.ts";

export type DiscordRpcContext = {
    readonly db: Db;
    readonly catalog: ProductCatalog;
    // Where link buttons point: the site members sign in to.
    readonly siteOrigin: string;
};

export const discordProcedures = implement<DiscordRpcContext, DiscordContract>(discordContract, {
    "rules.read": async (ctx) =>
        served(
            mapOk(await listRules(ctx.db), (rules) => {
                const roles = new Set<string>();
                const staff = new Set<string>();
                for (const { fields } of rules) {
                    if (fields.kind === "role") roles.add(fields.roleId);
                    if (fields.kind === "staff_channel") staff.add(fields.channelId);
                }
                return {
                    siteOrigin: ctx.siteOrigin,
                    managedRoleIds: [...roles].sort(),
                    staffChannelIds: [...staff].sort(),
                };
            }),
        ),
    "members.resolve": async (ctx, input) => served(await resolveMembers(ctx.db, input.userIds)),
    "changes.read": async (ctx, input) => served(await readChanges(ctx.db, input.after)),
    "links.redeem": async (ctx, input) => served(done(await redeemLinkCode(ctx.db, input))),
    "links.remove": async (ctx, input) => served(await removeDiscordLinkByUser(ctx.db, input)),
    "feeds.read": async (ctx) =>
        served(
            await readPendingPosts(ctx.db, { catalog: ctx.catalog, siteOrigin: ctx.siteOrigin }),
        ),
    "feeds.posted": async (ctx, input) => served(done(await recordPost(ctx.db, input))),
    "me.read": async (ctx, input) =>
        served(await readMe(ctx.db, { catalog: ctx.catalog, userId: input.userId })),
    "status.read": async (ctx) => served(await readStatus(ctx.db, ctx.catalog)),
    "tickets.products": async (ctx, input) =>
        served(await readTicketProducts(ctx.db, { catalog: ctx.catalog, userId: input.userId })),
    "tickets.open": async (ctx, input) =>
        served(
            await openTicketFromDiscord(ctx.db, {
                ...input,
                catalog: ctx.catalog,
                siteOrigin: ctx.siteOrigin,
            }),
        ),
    "dms.read": async (ctx) =>
        served(await readDueDms(ctx.db, { catalog: ctx.catalog, siteOrigin: ctx.siteOrigin })),
    "dms.settled": async (ctx, input) => served(done(await settleDm(ctx.db, input))),
});

// Its own mount, path and peer key: the connector's key opens nothing on web's path, and nothing
// web may ask is a procedure here.
export function createInternalDiscordApp(deps: {
    readonly db: Db;
    readonly catalog: ProductCatalog;
    readonly siteOrigin: string;
    readonly epochGuard: EpochGuard;
    readonly discordInternalKey: string;
    readonly logger: Logger;
}): Hono {
    return mountInternalRpc({
        path: DISCORD_RPC_PATH,
        peerKey: deps.discordInternalKey,
        procedures: discordProcedures,
        createContext: () =>
            Promise.resolve(
                deps.epochGuard.isSuperseded()
                    ? err({ code: "SERVICE_UNAVAILABLE" as const })
                    : ok({ db: deps.db, catalog: deps.catalog, siteOrigin: deps.siteOrigin }),
            ),
        onUnhandledError: ({ detail, kind, requestId }) => {
            deps.logger.write("error", kind, { origin: "internal-discord", detail, requestId });
        },
    });
}
