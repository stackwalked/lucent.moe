import { ProductId } from "@lucent/core/scalars";
import { z } from "zod";
import { defineContract } from "../contract.ts";
import { Done, refusal, Unavailable } from "./shared.ts";

// What an applicant types. Control characters are refused (the free text keeps line breaks and
// tabs): staff read these as plain text, never as markup.
const Line = (max: number) =>
    z
        .string()
        .trim()
        .min(1)
        .max(max)
        .regex(/^[^\p{Cc}]+$/u);

export const ApplicationAbout = z
    .string()
    .trim()
    .min(1)
    .max(2000)
    .regex(/^(?:[^\p{Cc}]|[\n\t])+$/u);

export const waitlistContract = defineContract({
    // The products an applicant may ask for: the live ones.
    "waitlist.products.list": {
        session: "none",
        effect: "read",
        input: z.strictObject({}),
        output: z.array(z.object({ productId: ProductId, name: z.string() })).readonly(),
        error: z.never(),
    },
    // The same answer, after the same time, for a new address, one with an account and one with
    // an application waiting. PRODUCT_NOT_OFFERED: a product that isn't live.
    "waitlist.application.submit": {
        session: "none",
        effect: "write",
        input: z.strictObject({
            email: z.email().max(254),
            products: z.array(ProductId).min(1).max(16),
            about: ApplicationAbout,
            // A plain string for staff to read; it links nothing and is never verified.
            discord: Line(64).nullable(),
            // The username of a member who knows the applicant. Staff see it; it fast-tracks
            // nothing.
            knownBy: Line(64).nullable(),
        }),
        output: Done,
        error: z.discriminatedUnion("code", [Unavailable, refusal("PRODUCT_NOT_OFFERED")]),
    },
});
