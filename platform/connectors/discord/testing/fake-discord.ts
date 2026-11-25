import { invariant } from "@lucent/core/contain";
import type { ServerWebSocket } from "bun";
import { z } from "zod";

// Discord as far as the connector uses it, on loopback in the test's own process: the REST routes
// it calls and a gateway that says hello, accepts an identify or a resume, and dispatches what the
// test makes happen. The connector runs its real libraries against it.

const BOT = { id: "900000000000000001", username: "lucent", discriminator: "0", avatar: null };
const APPLICATION_ID = "900000000000000002";

export type FakeMessage = {
    readonly channelId: string;
    readonly content: string;
    readonly buttonUrl: string | null;
};

export type FakeDiscord = {
    // The REST base the connector is given.
    readonly api: string;
    readonly guildId: string;
    readonly addMember: (userId: string, roles?: readonly string[]) => void;
    // Adds the member and dispatches the join.
    readonly join: (userId: string) => void;
    readonly roles: (userId: string) => readonly string[];
    // What staff do by hand in Discord.
    readonly setRoles: (userId: string, roles: readonly string[]) => void;
    readonly messages: () => readonly FakeMessage[];
    readonly commands: () => readonly string[];
    // Resolves once a gateway session is ready and the commands are registered.
    readonly ready: () => Promise<void>;
    // Runs a slash command as `userId` and resolves with the ephemeral reply.
    readonly command: (
        name: string,
        userId: string,
        options?: Readonly<Record<string, string>>,
    ) => Promise<{ readonly content: string; readonly ephemeral: boolean }>;
    // Closes the gateway connection with a code the client may resume after.
    readonly dropGateway: () => void;
    readonly identifies: () => number;
    readonly resumes: () => number;
    readonly stop: () => Promise<void>;
};

const RoleChange = /^\/api\/v10\/guilds\/(\d+)\/members\/(\d+)\/roles\/(\d+)$/;
const Member = /^\/api\/v10\/guilds\/(\d+)\/members\/(\d+)$/;
const Members = /^\/api\/v10\/guilds\/(\d+)\/members$/;
const Commands = /^\/api\/v10\/applications\/(\d+)\/guilds\/(\d+)\/commands$/;
const ChannelMessages = /^\/api\/v10\/channels\/(\d+)\/messages$/;
const Callback = /^\/api\/v10\/interactions\/(\d+)\/([^/]+)\/callback$/;
const Original = /^\/api\/v10\/webhooks\/(\d+)\/([^/]+)\/messages\/(?:@|%40)original$/;

const MessageBody = z.object({
    content: z.string(),
    components: z
        .array(z.object({ components: z.array(z.object({ url: z.string().optional() })) }))
        .optional(),
});
const CallbackBody = z.object({
    type: z.number(),
    data: z.object({ flags: z.number() }).optional(),
});
const EditBody = z.object({ content: z.string() });
const CommandsBody = z.array(z.object({ name: z.string() }));
const GatewayPayload = z.object({ op: z.number() });

const EPHEMERAL = 1 << 6;

function notFound(): Response {
    return Response.json({ message: "Unknown Member", code: 10007 }, { status: 404 });
}

export function startFakeDiscord(params: { readonly guildId: string }): FakeDiscord {
    const { guildId } = params;
    const members = new Map<string, Set<string>>();
    const messages: FakeMessage[] = [];
    let commands: readonly string[] = [];
    let nextId = 300_000_000_000_000_000n;
    const newId = () => {
        nextId += 1n;
        return nextId.toString();
    };
    let sequence = 0;
    let identifies = 0;
    let resumes = 0;
    let socket: ServerWebSocket<undefined> | null = null;
    let readyWaiters: (() => void)[] = [];
    let isReady = false;
    const replies = new Map<
        string,
        { ephemeral: boolean; resolve: (r: { content: string; ephemeral: boolean }) => void }
    >();

    const dispatch = (t: string, d: unknown): void => {
        invariant(socket !== null, "a gateway session is open");
        sequence += 1;
        socket.send(JSON.stringify({ op: 0, s: sequence, t, d }));
    };
    const memberJson = (userId: string) => ({
        user: { id: userId, username: `user${userId.slice(-3)}`, discriminator: "0", avatar: null },
        roles: [...(members.get(userId) ?? [])],
        joined_at: "2026-01-01T00:00:00.000Z",
        deaf: false,
        mute: false,
        flags: 0,
    });

    const gateway = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: (req, server) =>
            server.upgrade(req) ? undefined : new Response(null, { status: 400 }),
        websocket: {
            open: (ws) => {
                socket = ws;
                ws.send(
                    JSON.stringify({ op: 10, s: null, t: null, d: { heartbeat_interval: 41_250 } }),
                );
            },
            message: (ws, raw) => {
                const payload = GatewayPayload.parse(JSON.parse(String(raw)));
                if (payload.op === 1)
                    ws.send(JSON.stringify({ op: 11, s: null, t: null, d: null }));
                if (payload.op === 2) {
                    identifies += 1;
                    sequence = 0;
                    dispatch("READY", {
                        v: 10,
                        user: BOT,
                        guilds: [{ id: guildId, unavailable: true }],
                        session_id: `session-${identifies}`,
                        resume_gateway_url: `ws://127.0.0.1:${gateway.port}`,
                        application: { id: APPLICATION_ID, flags: 0 },
                    });
                }
                if (payload.op === 6) {
                    resumes += 1;
                    dispatch("RESUMED", {});
                }
            },
            close: (ws) => {
                if (socket === ws) socket = null;
            },
        },
    });

    const rest = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: async (req) => {
            const { pathname, searchParams } = new URL(req.url);
            if (pathname === "/api/v10/gateway/bot") {
                return Response.json({
                    url: `ws://127.0.0.1:${gateway.port}`,
                    shards: 1,
                    session_start_limit: {
                        total: 1000,
                        remaining: 1000,
                        reset_after: 0,
                        max_concurrency: 1,
                    },
                });
            }
            const roleChange = RoleChange.exec(pathname);
            if (roleChange !== null) {
                const roles = members.get(roleChange[2] ?? "");
                if (roleChange[1] !== guildId || roles === undefined) return notFound();
                if (req.method === "PUT") roles.add(roleChange[3] ?? "");
                if (req.method === "DELETE") roles.delete(roleChange[3] ?? "");
                return new Response(null, { status: 204 });
            }
            const member = Member.exec(pathname);
            if (member !== null && req.method === "GET") {
                const userId = member[2] ?? "";
                if (member[1] !== guildId || !members.has(userId)) return notFound();
                return Response.json(memberJson(userId));
            }
            if (Members.test(pathname) && req.method === "GET") {
                const after = BigInt(searchParams.get("after") ?? "0");
                const limit = Number(searchParams.get("limit") ?? "1");
                const ids = [...members.keys()]
                    .filter((id) => BigInt(id) > after)
                    .sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1))
                    .slice(0, limit);
                return Response.json(ids.map(memberJson));
            }
            const registered = Commands.exec(pathname);
            if (registered !== null && req.method === "PUT") {
                const body = CommandsBody.parse(await req.json());
                commands = body.map((command) => command.name);
                const ready = readyWaiters;
                readyWaiters = [];
                isReady = true;
                for (const resolve of ready) resolve();
                return Response.json(body.map((command) => ({ ...command, id: newId() })));
            }
            const channel = ChannelMessages.exec(pathname);
            if (channel !== null && req.method === "POST") {
                const body = MessageBody.parse(await req.json());
                messages.push({
                    channelId: channel[1] ?? "",
                    content: body.content,
                    buttonUrl: body.components?.[0]?.components[0]?.url ?? null,
                });
                return Response.json({
                    id: newId(),
                    channel_id: channel[1],
                    content: body.content,
                    author: BOT,
                    timestamp: "2026-01-01T00:00:00.000Z",
                    edited_timestamp: null,
                    tts: false,
                    mention_everyone: false,
                    mentions: [],
                    mention_roles: [],
                    attachments: [],
                    embeds: [],
                    pinned: false,
                    type: 0,
                });
            }
            const callback = Callback.exec(pathname);
            if (callback !== null) {
                const body = CallbackBody.parse(await req.json());
                const waiting = replies.get(callback[2] ?? "");
                if (waiting !== undefined) {
                    waiting.ephemeral = ((body.data?.flags ?? 0) & EPHEMERAL) !== 0;
                }
                return new Response(null, { status: 204 });
            }
            const original = Original.exec(pathname);
            if (original !== null && req.method === "PATCH") {
                const body = EditBody.parse(await req.json());
                const waiting = replies.get(original[2] ?? "");
                if (waiting !== undefined) {
                    replies.delete(original[2] ?? "");
                    waiting.resolve({ content: body.content, ephemeral: waiting.ephemeral });
                }
                return Response.json({ id: newId(), content: body.content });
            }
            return Response.json({ message: "404: Not Found", code: 0 }, { status: 404 });
        },
    });

    return {
        api: `http://127.0.0.1:${rest.port}/api`,
        guildId,
        addMember: (userId, roles = []) => {
            members.set(userId, new Set(roles));
        },
        join: (userId) => {
            members.set(userId, new Set());
            dispatch("GUILD_MEMBER_ADD", { guild_id: guildId, ...memberJson(userId) });
        },
        roles: (userId) => [...(members.get(userId) ?? [])].sort(),
        setRoles: (userId, roles) => {
            members.set(userId, new Set(roles));
        },
        messages: () => [...messages],
        commands: () => commands,
        ready: () =>
            isReady
                ? Promise.resolve()
                : new Promise((resolve) => {
                      readyWaiters.push(resolve);
                  }),
        command: (name, userId, options = {}) =>
            new Promise((resolve) => {
                const token = `token-${newId()}`;
                replies.set(token, { ephemeral: false, resolve });
                dispatch("INTERACTION_CREATE", {
                    id: newId(),
                    application_id: APPLICATION_ID,
                    type: 2,
                    token,
                    version: 1,
                    guild_id: guildId,
                    channel_id: "400000000000000001",
                    member: { ...memberJson(userId), permissions: "0" },
                    app_permissions: "0",
                    locale: "en-US",
                    entitlements: [],
                    authorizing_integration_owners: {},
                    context: 0,
                    data: {
                        id: newId(),
                        name,
                        type: 1,
                        options: Object.entries(options).map(([option, value]) => ({
                            name: option,
                            type: 3,
                            value,
                        })),
                    },
                });
            }),
        dropGateway: () => {
            socket?.close(4000, "unknown error");
        },
        identifies: () => identifies,
        resumes: () => resumes,
        stop: async () => {
            await gateway.stop(true);
            await rest.stop(true);
        },
    };
}
