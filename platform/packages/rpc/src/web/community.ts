import { z } from "zod";
import { PostingRestricted } from "./privacy.ts";
import { refusal, Unavailable } from "./shared.ts";

// What a member reading community content can be refused with: gone (or not theirs to see) is
// one answer, so a hidden thing and a missing one look the same.
export const ViewRefusal = z.discriminatedUnion("code", [
    Unavailable,
    refusal("SESSION_INVALID"),
    refusal("NOT_FOUND"),
]);

// Writing adds the account's community standing.
export const PostRefusal = z.discriminatedUnion("code", [
    Unavailable,
    refusal("SESSION_INVALID"),
    refusal("NOT_FOUND"),
    PostingRestricted,
]);

export const ContentId = z.uuid();

// Who wrote it: usernames are the only public name an account has.
export const Author = z.object({ username: z.string().nullable() });
