import { EpochMs } from "@lucent/core/scalars";
import { z } from "zod";
import { SIGNAL_KINDS } from "./signals.rules.ts";

// risk_signal.kind and review_item.signals as the database holds them, shared by the scoring job
// and the staff reads.

export const SignalKindSchema = z.enum(SIGNAL_KINDS);

export const Contributions = z.array(
    z.object({
        kind: SignalKindSchema,
        sessions: z.number().int().nonnegative(),
        lastAt: EpochMs,
        weight: z.number(),
    }),
);
