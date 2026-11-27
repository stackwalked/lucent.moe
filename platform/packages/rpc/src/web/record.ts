import { ProductState } from "@lucent/catalog/product";
import { EpochMs, ProductId } from "@lucent/core/scalars";
import { z } from "zod";
import { defineContract } from "../contract.ts";
import { Cursor, Done, refusal, SessionRefusals, StaffRefusals, Unavailable } from "./shared.ts";

// The record as members see it: per product whether it works today, and the changelog of the
// service, the loader and every product the member may see. Both reads take a member session
// and are scoped to what that member may see; a product the catalog doesn't list for them is
// simply absent. Staff write entries under releases:promote; plain text, bounded, rendered as
// text.

// No control characters but a body's line breaks and tabs, and no format characters (bidi
// overrides, zero widths, tags): text that reads other than it is. The table checks the same.
const Title = z
    .string()
    .trim()
    .min(1)
    .max(120)
    .refine((text) => !/[\p{Cc}\p{Cf}]/u.test(text));
const body = (max: number) =>
    z
        .string()
        .trim()
        .max(max)
        .refine((text) => !/\p{Cf}|[^\P{Cc}\n\r\t]/u.test(text));

// A version as the release names itself ("0.8.3-alpha.4"): free text, one line.
const Version = z
    .string()
    .trim()
    .min(1)
    .max(40)
    .refine((text) => !/[\p{Cc}\p{Cf}]/u.test(text));

// One line of an added/changed/fixed list.
const Line = z
    .string()
    .trim()
    .min(1)
    .max(200)
    .refine((text) => !/[\p{Cc}\p{Cf}]/u.test(text));
const Lines = z.array(Line).max(30);

export const ChangelogId = z.uuid();

export const ChangelogSubject = z.enum(["product", "loader", "service"]);
export type ChangelogSubject = z.output<typeof ChangelogSubject>;

// The cross-field rules (a productId exactly when the subject is a product, a version or a
// title, and some content) are the server's, in members/record/notes.rules.ts.
export const ChangelogFields = z.strictObject({
    subject: ChangelogSubject,
    productId: ProductId.nullable(),
    version: Version.nullable(),
    title: Title.nullable(),
    added: Lines,
    changed: Lines,
    fixed: Lines,
    body: body(4_000),
});

const ChangelogEntry = z.object({
    id: ChangelogId,
    subject: ChangelogSubject,
    productId: ProductId.nullable(),
    version: z.string().nullable(),
    title: z.string().nullable(),
    added: z.array(z.string()),
    changed: z.array(z.string()),
    fixed: z.array(z.string()),
    body: z.string(),
    publishedAt: EpochMs,
    updatedAt: EpochMs,
});

const Recovery = z.object({
    // When the build no set covered was first reported, and when a covering set was promoted
    // (null: still open).
    startedAt: EpochMs,
    endedAt: EpochMs.nullable(),
    latency: z.discriminatedUnion("state", [
        z.object({ state: z.literal("covered"), latencyMs: z.number() }),
        z.object({ state: z.literal("waiting"), waitingMs: z.number() }),
    ]),
});

const StaffRefusal = z.discriminatedUnion("code", [
    ...StaffRefusals,
    refusal("NOT_FOUND"),
    refusal("UNKNOWN_PRODUCT"),
    refusal("INVALID_ENTRY"),
]);

export const recordContract = defineContract({
    // The products listed for this member but the loader: whether each works today (`supported`
    // null: nothing to say yet). `recoveries` is each product's update history, newest first.
    "record.status.get": {
        session: "member",
        effect: "read",
        input: z.strictObject({}),
        output: z.object({
            products: z
                .array(
                    z.object({
                        productId: ProductId,
                        name: z.string(),
                        state: ProductState,
                        supported: z.boolean().nullable(),
                        recoveries: z.array(Recovery).readonly(),
                    }),
                )
                .readonly(),
        }),
        error: z.discriminatedUnion("code", [Unavailable, ...SessionRefusals]),
    },
    // The newest entries the member may see, 25 a page, newest first: `productId` absent is
    // everything (every subject), null the service's entries only, a product id that product's.
    // `subject` narrows further; a product the member may not see is an empty page, not a
    // refusal. `names` names every product the member may see.
    "record.changelog.list": {
        session: "member",
        effect: "read",
        input: z.strictObject({
            productId: ProductId.nullable().optional(),
            subject: ChangelogSubject.optional(),
            cursor: Cursor.optional(),
        }),
        output: z.object({
            entries: z.array(ChangelogEntry).readonly(),
            next: z.string().nullable(),
            names: z.array(z.object({ id: ProductId, name: z.string() })).readonly(),
        }),
        error: z.discriminatedUnion("code", [
            Unavailable,
            ...SessionRefusals,
            refusal("INVALID_CURSOR"),
        ]),
    },
    // Every entry, newest first, at most a fixed number; `truncated` says there were more.
    // `products` is the catalog one may name.
    "admin.record.list": {
        session: "member",
        effect: "read",
        input: z.strictObject({}),
        output: z.object({
            changelog: z.array(ChangelogEntry).readonly(),
            truncated: z.boolean(),
            products: z.array(z.object({ id: ProductId, name: z.string() })).readonly(),
        }),
        error: z.discriminatedUnion("code", [...StaffRefusals]),
    },
    "admin.changelog.add": {
        session: "member",
        effect: "write",
        input: ChangelogFields,
        output: z.object({ entryId: ChangelogId }),
        error: StaffRefusal,
    },
    "admin.changelog.update": {
        session: "member",
        effect: "write",
        input: ChangelogFields.extend({ entryId: ChangelogId }),
        output: Done,
        error: StaffRefusal,
    },
    "admin.changelog.delete": {
        session: "member",
        effect: "write",
        input: z.strictObject({ entryId: ChangelogId }),
        output: Done,
        error: StaffRefusal,
    },
});
