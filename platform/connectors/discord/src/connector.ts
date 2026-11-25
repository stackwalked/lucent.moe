import {
    ButtonStyle,
    Client,
    ComponentType,
    GatewayDispatchEvents,
    GatewayIntentBits,
    type RESTPatchAPIChannelMessageJSONBody,
    type RESTPostAPIChannelMessageJSONBody,
} from "@discordjs/core";
import { DiscordAPIError, REST } from "@discordjs/rest";
import { WebSocketManager } from "@discordjs/ws";
import { containBoundary, describeUnknownError, tryAsync } from "@lucent/core/contain";
import { err, ok, type Result } from "@lucent/core/result";
import type { ReplyOf, RpcClient } from "@lucent/rpc/client";
import type { DiscordContract } from "@lucent/rpc/discord/contract";
import { FEEDS_COPY, QUEUE_COPY } from "./copy.ts";
import { sendDueDms } from "./dms.ts";
import { guardMessage } from "./guard.ts";
import { COMMANDS, createInteractions } from "./interactions.ts";
import type { Logger, LogOrigin } from "./log.ts";
import { createSerialQueue } from "./queue.ts";

// The audit cursor is read this often; a change made in admin reaches Discord within one tick.
export const TICK_MS = 15_000;
// Repairs what the cursor can't see: a role removed by hand in Discord, an entitlement or role
// grant that ran out with no audit row, anything missed while platform or Discord was away.
export const RECONCILE_MS = 60 * 60 * 1_000;

// Discord's page size for listing members, and platform's batch for resolving them.
const MEMBERS_PER_PAGE = 1_000;
const USERS_PER_RESOLVE = 100;
const SYNC_REASON = "lucent.moe role sync";

// What a feed post says, by kind.
function feedContent(post: FeedItem["post"]): string {
    switch (post.kind) {
        case "status":
            return FEEDS_COPY.status(post.product, post.state, post.supported);
        case "resources":
            return FEEDS_COPY.resource(post.title, post.product);
        case "releases":
            return FEEDS_COPY.release(post.product, post.channel, post.number);
        case "tickets":
            return QUEUE_COPY.ticket(post);
        case "review":
            return QUEUE_COPY.review(post);
    }
}

function feedButton(post: FeedItem["post"]): string {
    if (post.kind === "tickets") return QUEUE_COPY.openTicket;
    if (post.kind === "review") return QUEUE_COPY.openReview;
    return FEEDS_COPY.open;
}

// Discord's "unknown message": the post was deleted in the channel.
function isUnknownMessage(cause: unknown): boolean {
    return cause instanceof DiscordAPIError && cause.code === 10008;
}

type FeedItem = Extract<
    ReplyOf<DiscordContract["feeds.read"]>,
    { ok: true }
>["value"]["posts"][number];

export type Connector = {
    // Connects the gateway and reads the audit cursor's head. Fails only when Discord refuses
    // the token or can't be reached at all.
    readonly start: () => Promise<Result<void, { readonly detail: string }>>;
    readonly stop: () => Promise<void>;
    // Queue one cursor tick or reconcile and wait for it to run.
    readonly tick: () => Promise<void>;
    readonly reconcile: () => Promise<void>;
    // Resolves once everything queued so far has run.
    readonly idle: () => Promise<void>;
};

export function createConnector(params: {
    readonly platform: RpcClient<DiscordContract>;
    readonly botToken: string;
    readonly guildId: string;
    readonly logger: Logger;
    // Discord's REST base, for a stand-in; the real one otherwise.
    readonly discordApi?: string;
    // "manual" leaves ticks and reconciles to the caller.
    readonly schedule: "timers" | "manual";
    // After each tick that reached platform: what a health check watches.
    readonly onAlive?: () => void;
}): Connector {
    const { platform, guildId, logger } = params;
    const rest = new REST({
        version: "10",
        ...(params.discordApi === undefined ? {} : { api: params.discordApi }),
    }).setToken(params.botToken);
    const gateway = new WebSocketManager({
        token: params.botToken,
        // GuildMembers and MessageContent are privileged: both are switched on for the bot in
        // Discord's developer portal, or the gateway refuses the session (close code 4014).
        intents:
            GatewayIntentBits.Guilds |
            GatewayIntentBits.GuildMembers |
            GatewayIntentBits.GuildMessages |
            GatewayIntentBits.MessageContent,
        rest,
    });
    const client = new Client({ rest, gateway });
    const { api } = client;
    const queue = createSerialQueue((key, detail) => {
        logger.write("error", `${key} failed`, { origin: "sync", detail });
    });

    let cursor: string | null = null;
    let managedRoleIds: ReadonlySet<string> = new Set();
    let staffChannelIds: ReadonlySet<string> = new Set();
    let siteOrigin: string | null = null;
    const timers: ReturnType<typeof setInterval>[] = [];

    type Pass = { readonly retired: ReadonlySet<string>; readonly refused: Set<string> };
    const newPass = (retired: readonly string[]): Pass => ({
        retired: new Set(retired),
        refused: new Set(),
    });

    const warn = (origin: LogOrigin, msg: string, detail: string): void => {
        logger.write("warn", msg, { origin, detail });
    };

    async function discord<T>(what: string, work: () => Promise<T>): Promise<Result<T, unknown>> {
        const done = await tryAsync(work, (cause) => cause);
        if (!done.ok) warn("gateway", what, describeUnknownError(done.error));
        return done;
    }

    async function refreshRules(): Promise<boolean> {
        const rules = await platform.call("rules.read", {});
        if (!rules.ok) {
            warn("platform", "rules unavailable", rules.error.code);
            return false;
        }
        managedRoleIds = new Set(rules.value.managedRoleIds);
        staffChannelIds = new Set(rules.value.staffChannelIds);
        siteOrigin = rules.value.siteOrigin;
        return true;
    }

    // Discord's "Missing Permissions": the role sits above the bot's own, or the bot may not
    // manage roles. Every member's change to that role would fail the same way.
    const MISSING_PERMISSIONS = 50_013;

    // Only the roles some rule manages are touched; any other role is staff's to give by hand.
    // `pass` lives for one sync or reconcile: the roles whose rule was just removed, still taken
    // off, and the roles Discord refused, not asked for again. A refused request counts toward
    // Discord's invalid-request limit, so one refusal per role per pass is all it gets.
    async function applyRoles(
        pass: Pass,
        userId: string,
        current: readonly string[],
        desired: readonly string[],
    ): Promise<void> {
        for (const roleId of new Set([...managedRoleIds, ...pass.retired, ...desired])) {
            const has = current.includes(roleId);
            const wants = desired.includes(roleId);
            if (has === wants || pass.refused.has(roleId)) continue;
            const changed = await tryAsync(
                () =>
                    wants
                        ? api.guilds.addRoleToMember(guildId, userId, roleId, {
                              reason: SYNC_REASON,
                          })
                        : api.guilds.removeRoleFromMember(guildId, userId, roleId, {
                              reason: SYNC_REASON,
                          }),
                (cause) => cause,
            );
            if (changed.ok) continue;
            const refused =
                changed.error instanceof DiscordAPIError &&
                changed.error.code === MISSING_PERMISSIONS;
            if (refused) pass.refused.add(roleId);
            warn(
                "sync",
                refused ? "role not manageable, skipped for this pass" : "role change failed",
                describeUnknownError(changed.error),
            );
        }
    }

    async function resolve(
        userIds: readonly string[],
    ): Promise<ReadonlyMap<string, readonly string[]> | null> {
        const resolved = new Map<string, readonly string[]>();
        for (let i = 0; i < userIds.length; i += USERS_PER_RESOLVE) {
            const batch = userIds.slice(i, i + USERS_PER_RESOLVE);
            const reply = await platform.call("members.resolve", { userIds: batch });
            if (!reply.ok) {
                warn("platform", "members unavailable", reply.error.code);
                return null;
            }
            for (const member of reply.value.members) resolved.set(member.userId, member.roleIds);
        }
        return resolved;
    }

    async function syncUsers(userIds: readonly string[]): Promise<void> {
        if (userIds.length === 0) return;
        const pass = newPass([]);
        const desired = await resolve(userIds);
        if (desired === null) return;
        for (const [userId, roleIds] of desired) {
            const member = await tryAsync(
                () => api.guilds.getMember(guildId, userId),
                (cause) => cause,
            );
            if (!member.ok) {
                // Not in the guild: nothing to sync until they join, which syncs them then.
                if (!(member.error instanceof DiscordAPIError && member.error.status === 404)) {
                    warn("sync", "member unavailable", describeUnknownError(member.error));
                }
                continue;
            }
            if (member.value.user.bot === true) continue;
            await applyRoles(pass, userId, member.value.roles, roleIds);
        }
    }

    async function runReconcile(retired: readonly string[] = []): Promise<void> {
        if (!(await refreshRules())) return;
        const pass = newPass(retired.filter((roleId) => !managedRoleIds.has(roleId)));
        if (managedRoleIds.size === 0 && pass.retired.size === 0) return;
        let after = "0";
        for (;;) {
            const page = await discord("member list failed", () =>
                api.guilds.getMembers(guildId, { limit: MEMBERS_PER_PAGE, after }),
            );
            if (!page.ok) return;
            const humans = page.value.filter((member) => member.user.bot !== true);
            const desired = await resolve(humans.map((member) => member.user.id));
            if (desired === null) return;
            for (const member of humans) {
                await applyRoles(
                    pass,
                    member.user.id,
                    member.roles,
                    desired.get(member.user.id) ?? [],
                );
            }
            // A large guild takes longer than the health check's window; a page done is alive.
            params.onAlive?.();
            const last = page.value.at(-1);
            if (page.value.length < MEMBERS_PER_PAGE || last === undefined) return;
            after = last.user.id;
        }
    }

    async function postFeeds(): Promise<void> {
        const pending = await platform.call("feeds.read", {});
        if (!pending.ok) {
            warn("platform", "feeds unavailable", pending.error.code);
            return;
        }
        // A channel that refused a post (deleted, or the bot lost it) is left alone until the
        // next tick rather than failing once per pending post.
        const failed = new Set<string>();
        for (const item of pending.value.posts) {
            if (failed.has(item.channelId)) continue;
            const body: RESTPostAPIChannelMessageJSONBody & RESTPatchAPIChannelMessageJSONBody = {
                content: feedContent(item.post),
                allowed_mentions: { parse: [] },
                components: [
                    {
                        type: ComponentType.ActionRow,
                        components: [
                            {
                                type: ComponentType.Button,
                                style: ButtonStyle.Link,
                                label: feedButton(item.post),
                                url: item.url,
                            },
                        ],
                    },
                ],
            };
            // A queue item already posted is edited where it stands; one whose message is gone
            // (deleted by hand) is posted again.
            const { messageId } = item;
            const edited =
                messageId === null
                    ? null
                    : await tryAsync(
                          () => api.channels.editMessage(item.channelId, messageId, body),
                          (cause) => cause,
                      );
            if (edited !== null && !edited.ok && !isUnknownMessage(edited.error)) {
                warn("feeds", "feed edit failed", describeUnknownError(edited.error));
                failed.add(item.channelId);
                continue;
            }
            const message =
                edited?.ok === true
                    ? edited
                    : await discord("feed post failed", () =>
                          api.channels.createMessage(item.channelId, body),
                      );
            if (!message.ok) {
                failed.add(item.channelId);
                continue;
            }
            const recorded = await platform.call("feeds.posted", {
                ruleId: item.ruleId,
                subject: item.subject,
                state: item.state,
                messageId: message.value.id,
            });
            // Posted but not recorded: the next tick posts it again. At least once, never lost.
            if (!recorded.ok) warn("feeds", "post not recorded", recorded.error.code);
        }
    }

    async function runTick(): Promise<void> {
        if (!(await refreshRules())) return;
        const changes = await platform.call("changes.read", { after: cursor });
        if (!changes.ok) {
            warn("platform", "changes unavailable", changes.error.code);
            return;
        }
        const first = cursor === null;
        cursor = changes.value.cursor;
        // The first read only finds the head; whatever came before it a reconcile covers.
        if (first || changes.value.reconcile) await runReconcile(changes.value.retiredRoleIds);
        else await syncUsers(changes.value.userIds);
        await postFeeds();
        await sendDueDms({ api, platform, warn: (msg, detail) => warn("dms", msg, detail) });
        params.onAlive?.();
    }

    const tick = () => queue.push("tick", runTick);
    const reconcile = () => queue.push("reconcile", () => runReconcile());
    const syncLater = (userId: string) => queue.push(`member:${userId}`, () => syncUsers([userId]));

    const answer = createInteractions({
        api,
        platform,
        guildId,
        siteOrigin: () => siteOrigin,
        attempt: discord,
        syncLater: (userId) => {
            void syncLater(userId);
        },
        staffChannels: () => staffChannelIds,
    });

    const contained = (origin: LogOrigin, work: () => Promise<void>) =>
        containBoundary({
            run: work,
            onUnhandled: (detail) => logger.write("error", "handler failed", { origin, detail }),
        });

    client.on(GatewayDispatchEvents.Ready, ({ data }) =>
        contained("gateway", async () => {
            // Ready comes after every fresh session, never after a resume: a gap long enough to
            // lose the session may have missed joins, so it reconciles.
            await discord("command registration failed", () =>
                api.applicationCommands.bulkOverwriteGuildCommands(
                    data.application.id,
                    guildId,
                    COMMANDS,
                ),
            );
            logger.write("info", "ready", { origin: "gateway" });
            void reconcile();
        }),
    );
    client.on(GatewayDispatchEvents.GuildMemberAdd, ({ data }) =>
        contained("sync", async () => {
            if (data.guild_id !== guildId || data.user.bot === true) return;
            await syncLater(data.user.id);
        }),
    );
    client.on(GatewayDispatchEvents.MessageCreate, ({ data }) =>
        contained("guard", () =>
            guardMessage({ api, guildId, staffChannels: () => staffChannelIds, logger }, data),
        ),
    );
    client.on(GatewayDispatchEvents.InteractionCreate, ({ data }) =>
        contained("commands", () => answer(data)),
    );

    return {
        start: async () => {
            const connected = await tryAsync(() => gateway.connect(), describeUnknownError);
            if (!connected.ok) return err({ detail: connected.error });
            if (params.schedule === "timers") {
                timers.push(setInterval(() => void tick(), TICK_MS));
                timers.push(setInterval(() => void reconcile(), RECONCILE_MS));
            }
            await tick();
            return ok(undefined);
        },
        stop: async () => {
            for (const timer of timers) clearInterval(timer);
            await queue.idle();
            await tryAsync(async () => {
                await gateway.destroy();
            }, describeUnknownError);
        },
        tick,
        reconcile,
        idle: () => queue.idle(),
    };
}
