import type { Clock } from "@lucent/core/clock";
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

// What an interaction was answered with: a message (deferred and edited, or sent at once), or a
// form.
export type FakeAnswer =
    | {
          readonly kind: "message";
          readonly content: string;
          readonly ephemeral: boolean;
          readonly buttonUrl: string | null;
      }
    | { readonly kind: "modal"; readonly customId: string; readonly options: readonly string[] }
    // Refused as Discord refuses it: a first answer after three seconds, or a link button whose
    // URL isn't absolute. The member sees the interaction fail.
    | { readonly kind: "lost"; readonly why: "expired" | "invalid" };

// How a member's DMs answer the bot: delivered, closed to it (Discord's 50007), or failing.
export type DmMode = "open" | "closed" | "failing";

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
    // Channel messages, not DMs.
    readonly messages: () => readonly FakeMessage[];
    readonly dms: (userId: string) => readonly FakeMessage[];
    readonly dmAttempts: (userId: string) => number;
    readonly setDms: (userId: string, mode: DmMode) => void;
    readonly commands: () => readonly string[];
    // Resolves once a gateway session is ready and the commands are registered.
    readonly ready: () => Promise<void>;
    // Runs a slash command as `userId` and resolves with its answer.
    readonly command: (
        name: string,
        userId: string,
        options?: Readonly<Record<string, string>>,
    ) => Promise<FakeAnswer>;
    // Submits a form as `userId`: a select's chosen value or a text input's text, by custom id.
    readonly submit: (
        customId: string,
        userId: string,
        fields: Readonly<Record<string, string>>,
        selects: readonly string[],
    ) => Promise<FakeAnswer>;
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
const Original = /^\/api\/v10\/webhooks\/(\d+)\/([^/]+)\/messages\/@original$/;

const Buttons = z
    .array(z.object({ components: z.array(z.object({ url: z.string().optional() })) }))
    .optional();
const MessageBody = z.object({ content: z.string(), components: Buttons });
const CallbackBody = z.object({
    type: z.number(),
    data: z
        .object({
            flags: z.number().optional(),
            content: z.string().optional(),
            custom_id: z.string().optional(),
            components: Buttons.or(
                z.array(
                    z.object({
                        component: z
                            .object({
                                options: z.array(z.object({ value: z.string() })).optional(),
                            })
                            .optional(),
                    }),
                ),
            ),
        })
        .optional(),
});
const EditBody = MessageBody;
const CommandsBody = z.array(z.object({ name: z.string() }));
const DmBody = z.object({ recipient_id: z.string() });
const GatewayPayload = z.object({ op: z.number() });

const EPHEMERAL = 1 << 6;
// Discord's interaction callback types.
const REPLY = 4;
const DEFER = 5;
const MODAL = 9;

function notFound(): Response {
    return Response.json({ message: "Unknown Member", code: 10007 }, { status: 404 });
}

// Discord's window for an interaction's first answer.
const ANSWER_WITHIN_MS = 3_000;

function buttonOf(components: z.output<typeof Buttons>): string | null {
    return components?.[0]?.components[0]?.url ?? null;
}

function invalidButton(components: z.output<typeof Buttons>): boolean {
    return (components ?? []).some((row) =>
        row.components.some((c) => c.url !== undefined && !/^https?:\/\/[^/]/.test(c.url)),
    );
}

function invalidBody(): Response {
    return Response.json({ message: "Invalid Form Body", code: 50035 }, { status: 400 });
}

// `clock`: what the three-second window for a first answer is measured against.
export function startFakeDiscord(params: {
    readonly guildId: string;
    readonly clock: Clock;
}): FakeDiscord {
    const { guildId, clock } = params;
    const members = new Map<string, Set<string>>();
    const messages: FakeMessage[] = [];
    const dmChannels = new Map<string, string>();
    const dmModes = new Map<string, DmMode>();
    const dmAttempts = new Map<string, number>();
    const dmsSent: (FakeMessage & { readonly userId: string })[] = [];
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
    const answers = new Map<
        string,
        { ephemeral: boolean; readonly at: number; resolve: (answer: FakeAnswer) => void }
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
    const messageJson = (channelId: string, content: string) => ({
        id: newId(),
        channel_id: channelId,
        content,
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
    const interact = (data: unknown): Promise<FakeAnswer> =>
        new Promise((resolve) => {
            const token = `token-${newId()}`;
            answers.set(token, { ephemeral: false, at: clock.now(), resolve });
            dispatch("INTERACTION_CREATE", { token, ...(typeof data === "object" ? data : {}) });
        });
    const interactionBase = (userId: string, type: number) => ({
        id: newId(),
        application_id: APPLICATION_ID,
        type,
        version: 1,
        guild_id: guildId,
        channel_id: "400000000000000001",
        member: { ...memberJson(userId), permissions: "0" },
        app_permissions: "0",
        locale: "en-US",
        entitlements: [],
        authorizing_integration_owners: {},
        context: 0,
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
            const url = new URL(req.url);
            const pathname = decodeURIComponent(url.pathname);
            const { searchParams } = url;
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
            if (pathname === "/api/v10/users/@me/channels" && req.method === "POST") {
                const { recipient_id } = DmBody.parse(await req.json());
                const channelId = newId();
                dmChannels.set(channelId, recipient_id);
                return Response.json({ id: channelId, type: 1, recipients: [] });
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
                const channelId = channel[1] ?? "";
                const body = MessageBody.parse(await req.json());
                if (invalidButton(body.components)) return invalidBody();
                const recipient = dmChannels.get(channelId);
                if (recipient !== undefined) {
                    dmAttempts.set(recipient, (dmAttempts.get(recipient) ?? 0) + 1);
                    const mode = dmModes.get(recipient) ?? "open";
                    if (mode === "closed") {
                        return Response.json(
                            { message: "Cannot send messages to this user", code: 50007 },
                            { status: 403 },
                        );
                    }
                    if (mode === "failing") {
                        return Response.json(
                            { message: "Missing Access", code: 50001 },
                            { status: 403 },
                        );
                    }
                    dmsSent.push({
                        userId: recipient,
                        channelId,
                        content: body.content,
                        buttonUrl: buttonOf(body.components),
                    });
                } else {
                    messages.push({
                        channelId,
                        content: body.content,
                        buttonUrl: buttonOf(body.components),
                    });
                }
                return Response.json(messageJson(channelId, body.content));
            }
            const callback = Callback.exec(pathname);
            if (callback !== null) {
                const body = CallbackBody.parse(await req.json());
                const token = callback[2] ?? "";
                const waiting = answers.get(token);
                if (waiting !== undefined) {
                    if (clock.now() - waiting.at > ANSWER_WITHIN_MS) {
                        answers.delete(token);
                        waiting.resolve({ kind: "lost", why: "expired" });
                        return Response.json(
                            { message: "Unknown interaction", code: 10062 },
                            { status: 404 },
                        );
                    }
                    waiting.ephemeral = ((body.data?.flags ?? 0) & EPHEMERAL) !== 0;
                    if (body.type === REPLY) {
                        answers.delete(token);
                        waiting.resolve({
                            kind: "message",
                            content: body.data?.content ?? "",
                            ephemeral: waiting.ephemeral,
                            buttonUrl: null,
                        });
                    }
                    if (body.type === MODAL) {
                        answers.delete(token);
                        const fields = body.data?.components ?? [];
                        waiting.resolve({
                            kind: "modal",
                            customId: body.data?.custom_id ?? "",
                            options: fields.flatMap((field) =>
                                "component" in field
                                    ? (field.component?.options ?? []).map((o) => o.value)
                                    : [],
                            ),
                        });
                    }
                    invariant(
                        body.type === REPLY || body.type === MODAL || body.type === DEFER,
                        `callback type ${body.type} is one the connector uses`,
                    );
                }
                return new Response(null, { status: 204 });
            }
            const original = Original.exec(pathname);
            if (original !== null && req.method === "PATCH") {
                const body = EditBody.parse(await req.json());
                const token = original[2] ?? "";
                const waiting = answers.get(token);
                if (invalidButton(body.components)) {
                    answers.delete(token);
                    waiting?.resolve({ kind: "lost", why: "invalid" });
                    return invalidBody();
                }
                if (waiting !== undefined) {
                    answers.delete(token);
                    waiting.resolve({
                        kind: "message",
                        content: body.content,
                        ephemeral: waiting.ephemeral,
                        buttonUrl: buttonOf(body.components),
                    });
                }
                return Response.json(messageJson("400000000000000001", body.content));
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
        dms: (userId) =>
            dmsSent
                .filter((dm) => dm.userId === userId)
                .map(({ channelId, content, buttonUrl }) => ({ channelId, content, buttonUrl })),
        dmAttempts: (userId) => dmAttempts.get(userId) ?? 0,
        setDms: (userId, mode) => {
            dmModes.set(userId, mode);
        },
        commands: () => commands,
        ready: () =>
            isReady
                ? Promise.resolve()
                : new Promise((resolve) => {
                      readyWaiters.push(resolve);
                  }),
        command: (name, userId, options = {}) =>
            interact({
                ...interactionBase(userId, 2),
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
            }),
        submit: (customId, userId, fields, selects) =>
            interact({
                ...interactionBase(userId, 5),
                data: {
                    custom_id: customId,
                    components: [
                        ...selects.map((value) => ({
                            type: 18,
                            id: Number(newId().slice(-6)),
                            component: { type: 3, id: 1, custom_id: "product", values: [value] },
                        })),
                        ...Object.entries(fields).map(([field, value]) => ({
                            type: 18,
                            id: Number(newId().slice(-6)),
                            component: { type: 4, id: 2, custom_id: field, value },
                        })),
                    ],
                },
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
