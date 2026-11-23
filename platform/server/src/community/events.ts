import { trySync } from "@lucent/core/contain";
import type { AccountId } from "@lucent/core/scalars";

// What a stream carries. Events hold no content and name no product: a ping tells a client to
// read again through the ordinary procedures, which apply listing, blocks and removal; so a
// stream can never show what a read would not.
export type CommunityEvent =
    | { readonly kind: "shout" }
    | { readonly kind: "comment" }
    | { readonly kind: "presence"; readonly online: number };

export type EventHub = {
    // Joins a stream; the returned function leaves it. Everyone, the joiner included, is told
    // the new count of accounts online.
    readonly connect: (accountId: AccountId, send: (event: CommunityEvent) => void) => () => void;
    readonly publish: (event: Exclude<CommunityEvent, { readonly kind: "presence" }>) => void;
    readonly online: () => number;
};

// In process, because platform-server is the only process that holds presence. Online counts
// accounts, not streams: two tabs are one account. A stream whose send throws has gone away and
// is dropped.
export function createEventHub(): EventHub {
    const streams = new Map<
        symbol,
        { readonly accountId: AccountId; readonly send: (event: CommunityEvent) => void }
    >();
    const online = () => new Set([...streams.values()].map((stream) => stream.accountId)).size;

    const deliver = (event: CommunityEvent) => {
        for (const [id, stream] of [...streams]) {
            const sent = trySync(
                () => stream.send(event),
                () => "gone",
            );
            if (!sent.ok) streams.delete(id);
        }
    };
    const announce = () => deliver({ kind: "presence", online: online() });

    return {
        connect: (accountId, send) => {
            const id = Symbol("stream");
            streams.set(id, { accountId, send });
            announce();
            return () => {
                if (streams.delete(id)) announce();
            };
        },
        publish: deliver,
        online,
    };
}
