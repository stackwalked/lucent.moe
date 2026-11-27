import { err, ok, type Result } from "@lucent/core/result";
import type { AccountId } from "@lucent/core/scalars";

// Streams are open connections held in memory, so they are bounded: per account, so one account
// cannot hold the process's connections, and overall, so all of them together cannot.
export const MAX_STREAMS_PER_ACCOUNT = 4;
export const MAX_STREAMS = 2_000;

export type StreamRefusal = { readonly code: "SERVICE_UNAVAILABLE" };

export function decideStreamAdmission(params: {
    readonly accountStreams: number;
    readonly totalStreams: number;
}): Result<null, StreamRefusal> {
    if (params.accountStreams >= MAX_STREAMS_PER_ACCOUNT) {
        return err({ code: "SERVICE_UNAVAILABLE" });
    }
    if (params.totalStreams >= MAX_STREAMS) return err({ code: "SERVICE_UNAVAILABLE" });
    return ok(null);
}

// The roster is the people part of presence: who is online, capped, so a crowded night costs the
// same frame as a quiet one. Rows arrive with every fact the filter needs; the decision is pure
// so the cap and the hiding are table-tested. `online` in the event stays the true count of
// everyone connected, whoever the roster leaves out. The roster is built per reader: an account
// that blocked the reader, or that the reader blocked, is never named to them.
export const ROSTER_CAP = 50;

export type RosterRow = {
    readonly accountId: AccountId;
    readonly username: string;
    readonly avatar: string | null;
    readonly inGame: boolean;
    // False when the account hides its last seen or its profile is private: it is never named.
    readonly shown: boolean;
};

export type RosterEntry = {
    readonly username: string;
    readonly avatar: string | null;
    readonly inGame: boolean;
};

export type BlockPair = { readonly blocker: AccountId; readonly blocked: AccountId };

// For each account, everyone it shares a block with, whichever of them blocked.
export function indexBlocks(
    pairs: readonly BlockPair[],
): ReadonlyMap<AccountId, ReadonlySet<AccountId>> {
    const index = new Map<AccountId, Set<AccountId>>();
    const add = (from: AccountId, to: AccountId) => {
        const set = index.get(from) ?? new Set<AccountId>();
        set.add(to);
        index.set(from, set);
    };
    for (const pair of pairs) {
        add(pair.blocker, pair.blocked);
        add(pair.blocked, pair.blocker);
    }
    return index;
}

// `hidden` is the accounts the reader shares a block with; the cap counts only who is named.
export function decideRoster(
    rows: readonly RosterRow[],
    hidden: ReadonlySet<AccountId> = new Set(),
    cap: number = ROSTER_CAP,
): readonly RosterEntry[] {
    const named: RosterEntry[] = [];
    for (const row of rows) {
        if (named.length >= cap) break;
        if (!row.shown || hidden.has(row.accountId)) continue;
        named.push({ username: row.username, avatar: row.avatar, inGame: row.inGame });
    }
    return named;
}
