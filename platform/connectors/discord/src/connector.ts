import {
    type APIInteraction,
    ApplicationCommandOptionType,
    ApplicationCommandType,
    ButtonStyle,
    Client,
    ComponentType,
    GatewayDispatchEvents,
    GatewayIntentBits,
    InteractionType,
    MessageFlags,
    type RESTPutAPIApplicationGuildCommandsJSONBody,
} from "@discordjs/core";
import { DiscordAPIError, REST } from "@discordjs/rest";
import { WebSocketManager } from "@discordjs/ws";
import { containBoundary, describeUnknownError, tryAsync } from "@lucent/core/contain";
import { err, ok, type Result } from "@lucent/core/result";
import type { RpcClient } from "@lucent/rpc/client";
import { type DiscordContract, LinkCode } from "@lucent/rpc/discord/contract";
import { COMMANDS_COPY, FEEDS_COPY, REPLIES } from "./copy.ts";
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

const COMMANDS: RESTPutAPIApplicationGuildCommandsJSONBody = [
    {
        name: "link",
        description: COMMANDS_COPY.link,
        type: ApplicationCommandType.ChatInput,
        options: [
            {
                name: "code",
                description: COMMANDS_COPY.linkCode,
                type: ApplicationCommandOptionType.String,
                required: true,
                min_length: 10,
                max_length: 11,
            },
        ],
    },
    {
        name: "unlink",
        description: COMMANDS_COPY.unlink,
        type: ApplicationCommandType.ChatInput,
    },
];

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
        intents: GatewayIntentBits.Guilds | GatewayIntentBits.GuildMembers,
        rest,
    });
    const client = new Client({ rest, gateway });
    const { api } = client;
    const queue = createSerialQueue((key, detail) => {
        logger.write("error", `${key} failed`, { origin: "sync", detail });
    });

    let cursor: string | null = null;
    let managedRoleIds: ReadonlySet<string> = new Set();
    let siteOrigin: string | null = null;
    const timers: ReturnType<typeof setInterval>[] = [];

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
        siteOrigin = rules.value.siteOrigin;
        return true;
    }

    // Only the roles some rule manages are touched; any other role is staff's to give by hand.
    async function applyRoles(
        userId: string,
        current: readonly string[],
        desired: readonly string[],
    ): Promise<void> {
        for (const roleId of new Set([...managedRoleIds, ...desired])) {
            const has = current.includes(roleId);
            const wants = desired.includes(roleId);
            if (has === wants) continue;
            await discord(wants ? "role add failed" : "role removal failed", () =>
                wants
                    ? api.guilds.addRoleToMember(guildId, userId, roleId, { reason: SYNC_REASON })
                    : api.guilds.removeRoleFromMember(guildId, userId, roleId, {
                          reason: SYNC_REASON,
                      }),
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
            await applyRoles(userId, member.value.roles, roleIds);
        }
    }

    async function runReconcile(): Promise<void> {
        if (!(await refreshRules()) || managedRoleIds.size === 0) return;
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
                await applyRoles(member.user.id, member.roles, desired.get(member.user.id) ?? []);
            }
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
        for (const item of pending.value.posts) {
            const { post } = item;
            const content =
                post.kind === "status"
                    ? FEEDS_COPY.status(post.product, post.state, post.supported)
                    : post.kind === "resources"
                      ? FEEDS_COPY.resource(post.title, post.product)
                      : FEEDS_COPY.release(post.product, post.channel, post.number);
            const message = await discord("feed post failed", () =>
                api.channels.createMessage(item.channelId, {
                    content,
                    allowed_mentions: { parse: [] },
                    components: [
                        {
                            type: ComponentType.ActionRow,
                            components: [
                                {
                                    type: ComponentType.Button,
                                    style: ButtonStyle.Link,
                                    label: FEEDS_COPY.open,
                                    url: item.url,
                                },
                            ],
                        },
                    ],
                }),
            );
            if (!message.ok) continue;
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
        if (first || changes.value.reconcile) await runReconcile();
        else await syncUsers(changes.value.userIds);
        await postFeeds();
        params.onAlive?.();
    }

    const tick = () => queue.push("tick", runTick);
    const reconcile = () => queue.push("reconcile", runReconcile);
    const syncLater = (userId: string) => queue.push(`member:${userId}`, () => syncUsers([userId]));

    async function link(userId: string, code: string | null): Promise<string> {
        const page = `${siteOrigin ?? "lucent.moe"}/account/discord`;
        const typed = LinkCode.safeParse(code ?? "");
        if (!typed.success) return REPLIES.codeInvalid(page);
        const linked = await platform.call("links.redeem", { userId, code: typed.data });
        if (linked.ok) {
            void syncLater(userId);
            return REPLIES.linked;
        }
        switch (linked.error.code) {
            case "CODE_INVALID":
                return REPLIES.codeInvalid(page);
            case "ALREADY_LINKED":
                return REPLIES.alreadyLinked;
            default:
                return REPLIES.unavailable;
        }
    }

    async function unlink(userId: string): Promise<string> {
        const removed = await platform.call("links.remove", { userId });
        if (!removed.ok) return REPLIES.unavailable;
        if (!removed.value.removed) return REPLIES.notLinked;
        void syncLater(userId);
        return REPLIES.unlinked;
    }

    // Answered outside the queue: Discord drops an interaction not acknowledged within three
    // seconds. Who is asking is the user Discord put in the interaction; platform decides the rest.
    async function answer(interaction: APIInteraction): Promise<void> {
        if (interaction.type !== InteractionType.ApplicationCommand) return;
        if (interaction.data.type !== ApplicationCommandType.ChatInput) return;
        if (interaction.guild_id !== guildId) return;
        const userId = interaction.member?.user.id;
        const { name } = interaction.data;
        if (userId === undefined || (name !== "link" && name !== "unlink")) return;
        const deferred = await discord("interaction not acknowledged", () =>
            api.interactions.defer(interaction.id, interaction.token, {
                flags: MessageFlags.Ephemeral,
            }),
        );
        if (!deferred.ok) return;
        const option = interaction.data.options?.find((o) => o.name === "code");
        const code = option?.type === ApplicationCommandOptionType.String ? option.value : null;
        const content = name === "link" ? await link(userId, code) : await unlink(userId);
        await discord("interaction reply failed", () =>
            api.interactions.editReply(interaction.application_id, interaction.token, {
                content,
            }),
        );
    }

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
