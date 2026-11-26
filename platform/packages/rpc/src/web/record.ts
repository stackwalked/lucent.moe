import { EpochMs, ProductId } from "@lucent/core/scalars";
import { z } from "zod";
import { defineContract } from "../contract.ts";
import { Done, refusal, StaffRefusals, Unavailable } from "./shared.ts";

// The public record: per product the public home lists, whether it works today, what is known to
// be broken, what changed and how long each game update took to recover from. The public reads
// take no session and say nothing a signed-out visitor should not see: no seed product, no
// account, no session, no count of members. Staff write issues and entries under
// releases:promote; plain text, bounded, rendered as text.

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

export const IssueId = z.uuid();
export const ChangelogId = z.uuid();

export const IssueFields = z.strictObject({
    productId: ProductId.nullable(),
    title: Title,
    body: body(2_000),
});

export const ChangelogFields = z.strictObject({
    productId: ProductId.nullable(),
    title: Title,
    body: body(4_000),
});

// `productId` null: the service as a whole.
const Issue = z.object({
    id: IssueId,
    productId: ProductId.nullable(),
    title: z.string(),
    body: z.string(),
    openedAt: EpochMs,
    updatedAt: EpochMs,
});

const ChangelogEntry = z.object({
    id: ChangelogId,
    productId: ProductId.nullable(),
    title: z.string(),
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
]);

export const recordContract = defineContract({
    // `at`: when platform answered, for web to show beside a snapshot it serves later.
    // `supported` null: nothing to say yet (announced, or nothing promoted). `issues` are the
    // open ones; `changelog` the newest few of each product and of the service.
    "record.status.get": {
        session: "none",
        effect: "read",
        input: z.strictObject({}),
        output: z.object({
            at: EpochMs,
            products: z
                .array(
                    z.object({
                        productId: ProductId,
                        name: z.string(),
                        state: z.enum(["announced", "live"]),
                        supported: z.boolean().nullable(),
                        recoveries: z.array(Recovery).readonly(),
                    }),
                )
                .readonly(),
            issues: z.array(Issue).readonly(),
            changelog: z.array(ChangelogEntry).readonly(),
        }),
        error: Unavailable,
    },
    // The newest entries, of the service and of every listed product; `names` names their
    // products.
    "record.changelog.list": {
        session: "none",
        effect: "read",
        input: z.strictObject({}),
        output: z.object({
            at: EpochMs,
            entries: z.array(ChangelogEntry).readonly(),
            names: z.array(z.object({ id: ProductId, name: z.string() })).readonly(),
        }),
        error: Unavailable,
    },
    // Every issue (closed ones with `closedAt`) and entry, newest first, at most a fixed number
    // of each; `truncated` says there were more. `products` is the catalog one may name.
    "admin.record.list": {
        session: "member",
        effect: "read",
        input: z.strictObject({}),
        output: z.object({
            issues: z.array(Issue.extend({ closedAt: EpochMs.nullable() })).readonly(),
            changelog: z.array(ChangelogEntry).readonly(),
            truncated: z.boolean(),
            products: z.array(z.object({ id: ProductId, name: z.string() })).readonly(),
        }),
        error: z.discriminatedUnion("code", [...StaffRefusals]),
    },
    "admin.issues.add": {
        session: "member",
        effect: "write",
        input: IssueFields,
        output: z.object({ issueId: IssueId }),
        error: StaffRefusal,
    },
    "admin.issues.update": {
        session: "member",
        effect: "write",
        input: IssueFields.extend({ issueId: IssueId }),
        output: Done,
        error: StaffRefusal,
    },
    // Closing a closed issue changes nothing.
    "admin.issues.close": {
        session: "member",
        effect: "write",
        input: z.strictObject({ issueId: IssueId }),
        output: Done,
        error: StaffRefusal,
    },
    "admin.issues.delete": {
        session: "member",
        effect: "write",
        input: z.strictObject({ issueId: IssueId }),
        output: Done,
        error: StaffRefusal,
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
