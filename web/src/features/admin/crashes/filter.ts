import { isProductId, type ProductId } from "@lucent/core/brands";
import { parseQuery } from "../query.ts";

export const CRASHES_KEYS = ["product", "release"] as const;

export type CrashesFilter = {
    readonly productId: ProductId | null;
    readonly releaseId: string | null;
};

const RELEASE_ID = /^[0-9a-f]{32}$/;

// ?q= as platform's crash filter: "product:cs2", "release:<32 hex digits>". Free text means
// nothing here; a token whose value doesn't fit is left out and said back as ignored.
export function readCrashesQuery(q: string | undefined): {
    readonly filter: CrashesFilter;
    readonly ignored: readonly string[];
} {
    const { tokens, text, ignored } = parseQuery(q, CRASHES_KEYS);
    const filter: CrashesFilter = {
        productId: isProductId(tokens.product) ? tokens.product : null,
        releaseId:
            tokens.release !== undefined && RELEASE_ID.test(tokens.release) ? tokens.release : null,
    };
    const used = { product: filter.productId, release: filter.releaseId };
    const unfit = CRASHES_KEYS.flatMap((key) => {
        const value = tokens[key];
        return value !== undefined && used[key] === null ? [`${key}:${value}`] : [];
    });
    return { filter, ignored: [...ignored, ...unfit, ...(text === null ? [] : [text])] };
}
