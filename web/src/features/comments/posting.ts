import type { Refused } from "../../server/outcome.ts";
import { COMMENTS_COPY } from "./copy.ts";

// Where a refused post sends the reader: their standing page says what and until when.
export function postingNote(refused: Refused | null): string | undefined {
    return refused?.code === "POSTING_RESTRICTED" ? COMMENTS_COPY.seePrivacy : undefined;
}
