import { systemClock } from "@lucent/core/clock";
import type { WebContract } from "@lucent/rpc/web";
import { createServerFn } from "@tanstack/react-start";
import type { z } from "zod";
import { callPlatform } from "../../server/platform.ts";
import { createSnapshot } from "./snapshot.ts";

// The public record pages read platform through these, and fall back to what web last had. A
// refusal of any kind (platform down, throttled) is served from the snapshot, never shown.

type Status = z.output<WebContract["record.status.get"]["output"]>;
type Changelog = z.output<WebContract["record.changelog.list"]["output"]>;

const status = createSnapshot<Status>({
    clock: systemClock,
    read: async () => {
        const reply = await callPlatform("record.status.get", {});
        return reply.ok ? { ok: true, value: reply.value, at: reply.value.at } : { ok: false };
    },
});

const changelog = createSnapshot<Changelog>({
    clock: systemClock,
    read: async () => {
        const reply = await callPlatform("record.changelog.list", {});
        return reply.ok ? { ok: true, value: reply.value, at: reply.value.at } : { ok: false };
    },
});

export const fetchStatus = createServerFn({ method: "GET" }).handler(() => status());

export const fetchChangelog = createServerFn({ method: "GET" }).handler(() => changelog());
