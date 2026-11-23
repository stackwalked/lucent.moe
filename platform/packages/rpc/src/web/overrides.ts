import { EpochMs } from "@lucent/core/scalars";
import { z } from "zod";
import { defineContract } from "../contract.ts";
import { ReadRefusal, refusal, StaffRefusals, WireId } from "./shared.ts";

// A feature's or capability's keyed id in the release manifest, as 16 hex digits.
const ManifestKey = z.string().regex(/^[0-9a-f]{16}$/);

const OverrideKind = z.enum(["feature", "capability"]);

export const overridesContract = defineContract({
    // A module release's kill switches: what its manifest declares, which of it is off, and the
    // override document's revision.
    "admin.overrides.list": {
        session: "member",
        effect: "read",
        input: z.strictObject({ releaseId: WireId }),
        output: z.object({
            releaseId: WireId,
            productId: z.string(),
            channel: z.string(),
            revision: z.number().int().nonnegative(),
            features: z
                .array(z.object({ key: ManifestKey, tag: z.string(), off: z.boolean() }))
                .readonly(),
            capabilities: z
                .array(
                    z.object({
                        key: ManifestKey,
                        level: z.enum(["optional", "core"]),
                        off: z.boolean(),
                    }),
                )
                .readonly(),
            switches: z
                .array(
                    z.object({
                        kind: OverrideKind,
                        key: ManifestKey,
                        setAt: EpochMs,
                        setBy: z.object({ id: z.string(), username: z.string().nullable() }),
                    }),
                )
                .readonly(),
        }),
        error: ReadRefusal,
    },
    // Turns one feature or capability of the release off, or back on, for every session on it.
    // Switching to the state it is in changes nothing.
    "admin.overrides.set": {
        session: "member",
        effect: "write",
        input: z.strictObject({
            releaseId: WireId,
            kind: OverrideKind,
            key: ManifestKey,
            off: z.boolean(),
        }),
        output: z.object({ changed: z.boolean(), revision: z.number().int().nonnegative() }),
        error: z.discriminatedUnion("code", [
            ...StaffRefusals,
            refusal("NOT_FOUND"),
            refusal("UNKNOWN_TARGET"),
        ]),
    },
});
