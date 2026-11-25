import type { WebContract } from "@lucent/rpc/web";
import { createServerFn } from "@tanstack/react-start";
import type { z } from "zod";
import { callPlatform } from "../../server/platform.ts";
import { createSnapshot } from "./snapshot.ts";

// The public record pages read platform through these, and fall back to what web last had. A
// refusal of any kind (platform down, throttled) is served from the snapshot, never shown.

type Status = z.output<WebContract["record.status.get"]["output"]>;
type Changelog = z.output<WebContract["record.changelog.list"]["output"]>;

const readStatus = () => callPlatform("record.status.get", {});
const readChangelog = () => callPlatform("record.changelog.list", {});

const statusSnapshot = createSnapshot<Status>();
const changelogSnapshot = createSnapshot<Changelog>();

export const fetchStatus = createServerFn({ method: "GET" }).handler(() =>
    statusSnapshot(async () => {
        const reply = await readStatus();
        return reply.ok ? { ok: true, value: reply.value, at: reply.value.at } : { ok: false };
    }),
);

export const fetchChangelog = createServerFn({ method: "GET" }).handler(() =>
    changelogSnapshot(async () => {
        const reply = await readChangelog();
        return reply.ok ? { ok: true, value: reply.value, at: reply.value.at } : { ok: false };
    }),
);
