import {
    type API,
    type APIChatInputApplicationCommandInteraction,
    type APIInteraction,
    type APIModalSubmissionComponent,
    type APIModalSubmitInteraction,
    ApplicationCommandOptionType,
    ApplicationCommandType,
    ButtonStyle,
    ComponentType,
    InteractionType,
    MessageFlags,
    type RESTPutAPIApplicationGuildCommandsJSONBody,
    TextInputStyle,
} from "@discordjs/core";
import type { Result } from "@lucent/core/result";
import type { RpcClient } from "@lucent/rpc/client";
import { type DiscordContract, LinkCode } from "@lucent/rpc/discord/contract";
import { MessageBody, TicketSubject } from "@lucent/rpc/web/tickets";
import { COMMANDS_COPY, FEEDS_COPY, ME_COPY, REPLIES, STATUS_COPY, TICKET_COPY } from "./copy.ts";

export const COMMANDS: RESTPutAPIApplicationGuildCommandsJSONBody = [
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
    { name: "unlink", description: COMMANDS_COPY.unlink, type: ApplicationCommandType.ChatInput },
    { name: "me", description: COMMANDS_COPY.me, type: ApplicationCommandType.ChatInput },
    { name: "status", description: COMMANDS_COPY.status, type: ApplicationCommandType.ChatInput },
    { name: "ticket", description: COMMANDS_COPY.ticket, type: ApplicationCommandType.ChatInput },
];

const TICKET_MODAL = "ticket";
const NO_PRODUCT = "none";
// Discord's most options in one select; one of them is "no product".
const SELECT_OPTIONS = 25;

type Reply = {
    readonly content: string;
    readonly link?: { readonly label: string; readonly url: string };
};
type Visibility = "ephemeral" | "public";

export type InteractionDeps = {
    readonly api: API;
    readonly platform: RpcClient<DiscordContract>;
    readonly guildId: string;
    // The site's origin, once platform has said it.
    readonly siteOrigin: () => string | null;
    // A Discord call whose failure is logged and handed back.
    readonly attempt: <T>(what: string, work: () => Promise<T>) => Promise<Result<T, unknown>>;
    // A role sync for someone who linked or unlinked just now.
    readonly syncLater: (userId: string) => void;
};

function componentsOf(reply: Reply) {
    return reply.link === undefined
        ? []
        : [
              {
                  type: ComponentType.ActionRow as const,
                  components: [
                      {
                          type: ComponentType.Button as const,
                          style: ButtonStyle.Link as const,
                          label: reply.link.label,
                          url: reply.link.url,
                      },
                  ],
              },
          ];
}

function fieldOf(components: readonly APIModalSubmissionComponent[], customId: string) {
    for (const component of components) {
        const inner =
            component.type === ComponentType.Label
                ? [component.component]
                : component.type === ComponentType.ActionRow
                  ? component.components
                  : [];
        const found = inner.find((field) => field.custom_id === customId);
        if (found !== undefined) return found;
    }
    return null;
}

// Answered outside the queue: Discord drops an interaction not acknowledged within three seconds.
// Who is asking is the user Discord put in the interaction; platform decides everything else, and
// every reply about an account is ephemeral.
export function createInteractions(deps: InteractionDeps) {
    const { api, platform } = deps;
    const site = () => deps.siteOrigin() ?? "lucent.moe";
    const linkPage = () => `${site()}/account/discord`;

    // Whatever the account's standing keeps from being said: the same words for nobody linked as
    // for an account that doesn't exist.
    function notActive(standing: "unlinked" | "suspended" | "locked"): Reply {
        if (standing === "unlinked") return { content: REPLIES.linkFirst(linkPage()) };
        return {
            content: standing === "suspended" ? REPLIES.suspended(site()) : REPLIES.locked(site()),
        };
    }

    async function deferThen(
        interaction: APIChatInputApplicationCommandInteraction | APIModalSubmitInteraction,
        visibility: Visibility,
        work: () => Promise<Reply>,
    ): Promise<void> {
        const deferred = await deps.attempt("interaction not acknowledged", () =>
            api.interactions.defer(
                interaction.id,
                interaction.token,
                visibility === "ephemeral" ? { flags: MessageFlags.Ephemeral } : {},
            ),
        );
        if (!deferred.ok) return;
        const reply = await work();
        await deps.attempt("interaction reply failed", () =>
            api.interactions.editReply(interaction.application_id, interaction.token, {
                content: reply.content,
                components: componentsOf(reply),
                allowed_mentions: { parse: [] },
            }),
        );
    }

    async function link(userId: string, code: string | null): Promise<Reply> {
        const typed = LinkCode.safeParse(code ?? "");
        if (!typed.success) return { content: REPLIES.codeInvalid(linkPage()) };
        const linked = await platform.call("links.redeem", { userId, code: typed.data });
        if (linked.ok) {
            deps.syncLater(userId);
            return { content: REPLIES.linked };
        }
        switch (linked.error.code) {
            case "CODE_INVALID":
                return { content: REPLIES.codeInvalid(linkPage()) };
            case "ALREADY_LINKED":
                return { content: REPLIES.alreadyLinked };
            default:
                return { content: REPLIES.unavailable };
        }
    }

    async function unlink(userId: string): Promise<Reply> {
        const removed = await platform.call("links.remove", { userId });
        if (!removed.ok) return { content: REPLIES.unavailable };
        if (!removed.value.removed) return { content: REPLIES.notLinked };
        deps.syncLater(userId);
        return { content: REPLIES.unlinked };
    }

    async function me(userId: string): Promise<Reply> {
        const read = await platform.call("me.read", { userId });
        if (!read.ok) return { content: REPLIES.unavailable };
        const account = read.value;
        if (account.standing !== "active") return notActive(account.standing);
        const lines = [
            `**${ME_COPY.heading}**`,
            ...(account.products.length === 0
                ? [ME_COPY.noProducts]
                : account.products.map(ME_COPY.product)),
            ME_COPY.devices(account.devices.count, account.devices.limit),
            ME_COPY.nextExpiry(account.nextExpiry),
            ...account.restrictions.map((r) => ME_COPY.restriction(r.kind, r.product, r.endsAt)),
        ];
        return {
            content: lines.join("\n"),
            link: { label: ME_COPY.page, url: `${site()}/products` },
        };
    }

    async function status(): Promise<Reply> {
        const read = await platform.call("status.read", {});
        if (!read.ok) return { content: REPLIES.unavailable };
        if (read.value.products.length === 0) return { content: STATUS_COPY.none };
        return {
            content: read.value.products
                .map((p) => FEEDS_COPY.status(p.product, p.state, p.supported))
                .join("\n"),
        };
    }

    // The form is the answer itself, so what it offers is read before Discord's three seconds
    // run out; someone it can't serve gets an ephemeral reply instead.
    async function ticketForm(
        interaction: APIChatInputApplicationCommandInteraction,
        userId: string,
    ) {
        const offered = await platform.call("tickets.products", { userId });
        const refusal: Reply | null = !offered.ok
            ? { content: REPLIES.unavailable }
            : offered.value.standing !== "active"
              ? notActive(offered.value.standing)
              : null;
        if (refusal !== null || !offered.ok || offered.value.standing !== "active") {
            await deps.attempt("interaction reply failed", () =>
                api.interactions.reply(interaction.id, interaction.token, {
                    content: refusal?.content ?? REPLIES.unavailable,
                    flags: MessageFlags.Ephemeral,
                }),
            );
            return;
        }
        const products = offered.value.products.slice(0, SELECT_OPTIONS - 1);
        await deps.attempt("ticket form not shown", () =>
            api.interactions.createModal(interaction.id, interaction.token, {
                custom_id: TICKET_MODAL,
                title: TICKET_COPY.title,
                components: [
                    {
                        type: ComponentType.Label,
                        label: TICKET_COPY.product,
                        component: {
                            type: ComponentType.StringSelect,
                            custom_id: "product",
                            min_values: 1,
                            max_values: 1,
                            options: [
                                { label: TICKET_COPY.noProduct, value: NO_PRODUCT, default: true },
                                ...products.map((p) => ({ label: p.name, value: p.id })),
                            ],
                        },
                    },
                    {
                        type: ComponentType.Label,
                        label: TICKET_COPY.subject,
                        component: {
                            type: ComponentType.TextInput,
                            custom_id: "subject",
                            style: TextInputStyle.Short,
                            min_length: 1,
                            max_length: 120,
                            required: true,
                        },
                    },
                    {
                        type: ComponentType.Label,
                        label: TICKET_COPY.body,
                        component: {
                            type: ComponentType.TextInput,
                            custom_id: "body",
                            style: TextInputStyle.Paragraph,
                            min_length: 1,
                            max_length: 4_000,
                            required: true,
                        },
                    },
                ],
            }),
        );
    }

    async function openTicket(
        interaction: APIModalSubmitInteraction,
        userId: string,
    ): Promise<Reply> {
        const { components } = interaction.data;
        const product = fieldOf(components, "product");
        const subject = fieldOf(components, "subject");
        const body = fieldOf(components, "body");
        const chosen =
            product?.type === ComponentType.StringSelect
                ? (product.values[0] ?? NO_PRODUCT)
                : NO_PRODUCT;
        const typedSubject = TicketSubject.safeParse(
            subject?.type === ComponentType.TextInput ? subject.value : "",
        );
        const typedBody = MessageBody.safeParse(
            body?.type === ComponentType.TextInput ? body.value : "",
        );
        if (!typedSubject.success || !typedBody.success) return { content: REPLIES.unavailable };
        const opened = await platform.call("tickets.open", {
            userId,
            productId: chosen === NO_PRODUCT ? null : chosen,
            subject: typedSubject.data,
            body: typedBody.data,
        });
        if (opened.ok) {
            return {
                content: TICKET_COPY.opened,
                link: { label: TICKET_COPY.open, url: opened.value.url },
            };
        }
        switch (opened.error.code) {
            case "NOT_LINKED":
                return notActive("unlinked");
            case "ACCOUNT_UNAVAILABLE":
                return { content: REPLIES.locked(site()) };
            case "UNKNOWN_PRODUCT":
                return { content: TICKET_COPY.unknownProduct };
            case "TICKET_LIMIT":
                return { content: TICKET_COPY.limit };
            default:
                return { content: REPLIES.unavailable };
        }
    }

    return async (interaction: APIInteraction): Promise<void> => {
        if (interaction.guild_id !== deps.guildId) return;
        const userId = interaction.member?.user.id;
        if (userId === undefined) return;
        if (interaction.type === InteractionType.ModalSubmit) {
            if (interaction.data.custom_id !== TICKET_MODAL) return;
            await deferThen(interaction, "ephemeral", () => openTicket(interaction, userId));
            return;
        }
        if (interaction.type !== InteractionType.ApplicationCommand) return;
        if (interaction.data.type !== ApplicationCommandType.ChatInput) return;
        const command: APIChatInputApplicationCommandInteraction = {
            ...interaction,
            data: interaction.data,
        };
        switch (command.data.name) {
            case "link": {
                const option = command.data.options?.find((o) => o.name === "code");
                const code =
                    option?.type === ApplicationCommandOptionType.String ? option.value : null;
                await deferThen(command, "ephemeral", () => link(userId, code));
                return;
            }
            case "unlink":
                await deferThen(command, "ephemeral", () => unlink(userId));
                return;
            case "me":
                await deferThen(command, "ephemeral", () => me(userId));
                return;
            case "status":
                await deferThen(command, "public", status);
                return;
            case "ticket":
                await ticketForm(command, userId);
                return;
        }
    };
}
