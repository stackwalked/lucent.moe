import { tryAsync, trySync } from "@lucent/core/contain";
import { err, ok, type Result } from "@lucent/core/result";
import type { AccountId } from "@lucent/core/scalars";
import {
    decideRoster,
    decideStreamAdmission,
    indexBlocks,
    type RosterEntry,
    type StreamRefusal,
} from "./events.rules.ts";
import { EMPTY_ROSTER, type RosterProvider } from "./presence.ts";

// A stream carries presence and nothing else. Content pings were left out: they would go to every
// stream whatever its reader may see (blocks, product listing), and nothing consumed them.
// `roster` names at most 50 of the accounts online (community/presence.ts decides who is named),
// as each reader may see them: never an account that blocked the reader or that they blocked.
export type PresenceEvent = {
    readonly kind: "presence";
    readonly online: number;
    readonly roster: readonly RosterEntry[];
};

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
    // Whether the account holds at least one live stream.
    readonly present: (accountId: AccountId) => boolean;
    // What the roster shows changed (an account's last seen or visibility, a block added or
    // removed): the next flush reads it afresh and goes to every stream, those affected included.
    readonly rosterChanged: () => void;
    // Ends every stream and refuses new ones: the server is stopping.
    readonly close: () => void;
};

// Presence changes only when an account's first stream opens or its last one ends, and the new
// count goes to everyone at most once per coalescing delay, however many connect in between, so
// n connections cost n sends a delay, not n squared. In process, because platform-server is the
// only holder of presence. Online counts accounts: two tabs are one.
export function createEventHub(options?: {
    readonly schedule?: (run: () => void) => void;
    // Reads the roster for the connected accounts (community/presence.ts). When given, events
    // are delivered once it answers — asynchronously; without it the roster is empty and
    // delivery stays synchronous, which is what the hub's own tests hold it to.
    readonly roster?: RosterProvider;
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
    // Set by rosterChanged, cleared by the flush that reads afresh.
    let stale = false;

    const drop = (id: symbol) => {
        const stream = streams.get(id);
        if (stream === undefined) return;
        streams.delete(id);
        latest.delete(id);
        const left = (perAccount.get(stream.accountId) ?? 1) - 1;
        if (left > 0) {
            perAccount.set(stream.accountId, left);
            return;
        }
        perAccount.delete(stream.accountId);
        changed();
    };

    // Reads finish in any order, so each carries the number it started with and a stream skips
    // one older than what it was last sent: a joiner's first event, slow to arrive, never
    // overwrites the flush that started after it.
    let started = 0;
    const latest = new Map<symbol, number>();

    const deliver = (id: symbol, event: PresenceEvent, generation: number = ++started) => {
        const stream = streams.get(id);
        if (stream === undefined) return;
        if (generation < (latest.get(id) ?? 0)) return;
        latest.set(id, generation);
        const sent = trySync(
            () => stream.send(event),
            () => false,
        );
        if (sent.ok && sent.value) return;
        drop(id);
        stream.close();
    };

    // One read per flush or join, however many streams take it; each stream's event is then cut
    // from it for its own account, once per account. A roster that cannot be read is an empty
    // one, never a dropped presence count.
    const buildEvents = async (source: "memo" | "fresh") => {
        const generation = ++started;
        const online = perAccount.size;
        const read = options?.roster;
        const snapshot =
            read === undefined
                ? EMPTY_ROSTER
                : await tryAsync(
                      () => read([...perAccount.keys()], { fresh: source === "fresh" }),
                      () => EMPTY_ROSTER,
                  ).then((answer) => (answer.ok ? answer.value : EMPTY_ROSTER));
        const blocked = indexBlocks(snapshot.blocks);
        const perViewer = new Map<AccountId, PresenceEvent>();
        const eventFor = (viewer: AccountId): PresenceEvent => {
            const cached = perViewer.get(viewer);
            if (cached !== undefined) return cached;
            const event: PresenceEvent = {
                kind: "presence",
                online,
                roster: decideRoster(snapshot.rows, blocked.get(viewer)),
            };
            perViewer.set(viewer, event);
            return event;
        };
        return { generation, eventFor };
    };

    const emit = (id: symbol) => {
        const accountId = streams.get(id)?.accountId;
        if (accountId === undefined) return;
        if (options?.roster === undefined) {
            deliver(id, { kind: "presence", online: perAccount.size, roster: [] });
            return;
        }
        void buildEvents(stale ? "fresh" : "memo").then(({ generation, eventFor }) =>
            deliver(id, eventFor(accountId), generation),
        );
    };

    const flush = () => {
        pending = false;
        if (options?.roster === undefined) {
            const event: PresenceEvent = { kind: "presence", online: perAccount.size, roster: [] };
            for (const id of [...streams.keys()]) deliver(id, event);
            return;
        }
        const source = stale ? "fresh" : "memo";
        stale = false;
        void buildEvents(source).then(({ generation, eventFor }) => {
            for (const [id, stream] of [...streams]) {
                deliver(id, eventFor(stream.accountId), generation);
            }
        });
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
            emit(id);
            return ok(() => drop(id));
        },
        online: () => perAccount.size,
        present: (accountId) => perAccount.has(accountId),
        rosterChanged: () => {
            stale = true;
            changed();
        },
        close: () => {
            closed = true;
            const open = [...streams.values()];
            streams.clear();
            perAccount.clear();
            for (const stream of open) stream.close();
        },
    };
}
