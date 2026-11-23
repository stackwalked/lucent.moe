import { EpochMs, ProductId } from "@lucent/core/scalars";
import { z } from "zod";
import { refusal, Unavailable } from "./shared.ts";

export const RestrictionKind = z.enum(["muted", "barred"]);

// Refused when the account's community standing closes the place it tried to write. The reason
// staff gave is not part of it.
export const PostingRestricted = z.object({
    code: z.literal("POSTING_RESTRICTED"),
    kind: RestrictionKind,
    productId: ProductId.nullable(),
    endsAt: EpochMs.nullable(),
});

// What a member reading community content can be refused with: gone (or not theirs to see) is
// one answer, so a hidden thing and a missing one look the same.
export const ViewRefusal = z.discriminatedUnion("code", [
    Unavailable,
    refusal("SESSION_INVALID"),
    refusal("NOT_FOUND"),
]);

// Refused when the account is at a volume limit (open reports, posts a minute, guides in a
// product); which one is in `limit`.
export const LimitReached = z.object({
    code: z.literal("LIMIT_REACHED"),
    limit: z.enum(["reports", "posts", "guides"]),
});

// Writing adds the account's community standing and volume limits.
export const PostRefusal = z.discriminatedUnion("code", [
    Unavailable,
    refusal("SESSION_INVALID"),
    refusal("NOT_FOUND"),
    PostingRestricted,
    LimitReached,
]);

export const ReportRefusal = z.discriminatedUnion("code", [
    Unavailable,
    refusal("SESSION_INVALID"),
    refusal("NOT_FOUND"),
    LimitReached,
]);

export const ContentId = z.uuid();

// Who wrote it: usernames are the only public name an account has.
export const Author = z.object({ username: z.string().nullable() });
