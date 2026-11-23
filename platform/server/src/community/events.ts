import { trySync } from "@lucent/core/contain";
import { err, ok, type Result } from "@lucent/core/result";
import type { AccountId } from "@lucent/core/scalars";
import { decideStreamAdmission, type StreamRefusal } from "./events.rules.ts";

// A stream carries presence and nothing else. Content pings were left out: they would go to every
// stream whatever its reader may see (blocks, product listing), and nothing consumed them.
export type PresenceEvent = { readonly kind: "presence"; readonly online: number };

export type StreamEnd = {
    // False when the stream cannot take the event (its reader is not keeping up, or it is gone):
    // the hub drops it.
    readonly send: (event: PresenceEvent) => boolean;
    // Ends the stream from the hub's side (server stop, or a stream that fell behind).
    readonly close: () => void;
};

export type EventHub = {
    // Joins a stream: the returned function leaves it. The joiner is told the count at once.
    readonly connect: (
        accountId: AccountId,
        stream: StreamEnd,
    ) => Result<() => void, StreamRefusal>;
    readonly online: () => number;
    // Ends every stream and refuses new ones: the server is stopping.
    readonly close: () => void;
};

// Presence changes only when an account's first stream opens or its last one ends, and the new
// count goes to everyone at most once per coalescing delay, however many connect in between, so
// n connections cost n sends a delay, not n squared. In process, because platform-server is the
// only holder of presence. Online counts accounts: two tabs are one.
export function createEventHub(options?: {
    readonly schedule?: (run: () => void) => void;
}): EventHub {
    const schedule =
        options?.schedule ??
        ((run: () => void) => {
            const timer = setTimeout(run, 1_000);
            timer.unref();
        });
    const streams = new Map<symbol, StreamEnd & { readonly accountId: AccountId }>();
    const perAccount = new Map<AccountId, number>();
    let pending = false;
    let closed = false;

    const drop = (id: symbol) => {
        const stream = streams.get(id);
        if (stream === undefined) return;
        streams.delete(id);
        const left = (perAccount.get(stream.accountId) ?? 1) - 1;
        if (left > 0) {
            perAccount.set(stream.accountId, left);
            return;
        }
        perAccount.delete(stream.accountId);
        changed();
    };

    const deliver = (id: symbol, event: PresenceEvent) => {
        const stream = streams.get(id);
        if (stream === undefined) return;
        const sent = trySync(
            () => stream.send(event),
            () => false,
        );
        if (sent.ok && sent.value) return;
        drop(id);
        stream.close();
    };

    const flush = () => {
        pending = false;
        const event: PresenceEvent = { kind: "presence", online: perAccount.size };
        for (const id of [...streams.keys()]) deliver(id, event);
    };
    function changed() {
        if (pending || closed) return;
        pending = true;
        schedule(flush);
    }

    return {
        connect: (accountId, stream) => {
            const admitted = decideStreamAdmission({
                accountStreams: perAccount.get(accountId) ?? 0,
                totalStreams: streams.size,
            });
            if (closed) return err({ code: "SERVICE_UNAVAILABLE" });
            if (!admitted.ok) return admitted;
            const id = Symbol("stream");
            streams.set(id, { ...stream, accountId });
            const first = !perAccount.has(accountId);
            perAccount.set(accountId, (perAccount.get(accountId) ?? 0) + 1);
            if (first) changed();
            deliver(id, { kind: "presence", online: perAccount.size });
            return ok(() => drop(id));
        },
        online: () => perAccount.size,
        close: () => {
            closed = true;
            const open = [...streams.values()];
            streams.clear();
            perAccount.clear();
            for (const stream of open) stream.close();
        },
    };
}
