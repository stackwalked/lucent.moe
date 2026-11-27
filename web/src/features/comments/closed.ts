import type { EpochMs } from "@lucent/core/scalars";
import { formatDate } from "../../ui/Time/format.ts";
import { useTimeContext } from "../../ui/Time/TimeProvider.tsx";
import { COMMENTS_COPY } from "./copy.ts";

type Restriction = {
    readonly kind: "muted" | "barred";
    readonly productId: string | null;
    readonly endsAt: EpochMs | null;
};

// What closes the member's own words on the site: a mute or a bar that names no product (the
// shout input and walls belong to none). A restriction on one product closes only that
// product's surfaces. The one that lasts longest is the one told, as the server's refusal does.
export type Closed = Pick<Restriction, "kind" | "endsAt">;

export function closedBy(restrictions: readonly Restriction[]): Closed | null {
    let binding: Restriction | null = null;
    for (const restriction of restrictions) {
        if (restriction.productId !== null) continue;
        const longer =
            binding === null ||
            (binding.endsAt !== null &&
                (restriction.endsAt === null || restriction.endsAt > binding.endsAt));
        if (longer) binding = restriction;
    }
    return binding === null ? null : { kind: binding.kind, endsAt: binding.endsAt };
}

// The placeholder of an input that is closed: "muted" or "posting barred", and until when.
export function useClosedWords(closed: Closed | null): string | null {
    const { timeZone } = useTimeContext();
    if (closed === null) return null;
    const word = closed.kind === "muted" ? COMMENTS_COPY.muted : COMMENTS_COPY.barred;
    return closed.endsAt === null
        ? word
        : `${word} ${COMMENTS_COPY.until} ${formatDate(closed.endsAt, timeZone)}`;
}
