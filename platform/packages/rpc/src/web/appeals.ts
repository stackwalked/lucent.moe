import { EpochMs } from "@lucent/core/scalars";
import { z } from "zod";
import { defineContract } from "../contract.ts";
import { Done, refusal, Unavailable } from "./shared.ts";
import { MessageBody, TicketId, TicketMessage, TicketRefusal, TicketState } from "./tickets.ts";

// A suspended account's appeal, on the appeal session its full sign-in gave it; no other session
// reaches these, and that session reaches nothing else. The appeal shows the reason staff gave
// when suspending (null when none was recorded) and the thread staff answer as a ticket.

export const appealsContract = defineContract({
    "appeals.read": {
        session: "appeal",
        effect: "read",
        input: z.strictObject({}),
        output: z.object({
            suspension: z.object({ reason: z.string(), at: EpochMs }).nullable(),
            appeal: z
                .object({
                    id: TicketId,
                    state: TicketState,
                    openedAt: EpochMs,
                    messages: z.array(TicketMessage).readonly(),
                })
                .nullable(),
        }),
        error: z.discriminatedUnion("code", [Unavailable, refusal("SESSION_INVALID")]),
    },
    // The first message files the appeal; later ones add to it, reopening it if staff closed it.
    "appeals.send": {
        session: "appeal",
        effect: "write",
        input: z.strictObject({ body: MessageBody }),
        output: Done,
        error: TicketRefusal,
    },
});
