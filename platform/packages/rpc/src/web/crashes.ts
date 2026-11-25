import { ChannelId, EpochMs, ProductId } from "@lucent/core/scalars";
import { z } from "zod";
import { defineContract } from "../contract.ts";
import { Cursor, pageOf, ReadRefusal, SealNumber, WireId } from "./shared.ts";

// A u64 module name hash in lowercase hex; all zeros is the module's own image.
export const ModuleHash = z.string().regex(/^[0-9a-f]{16}$/);

const U32 = z.number().int().min(0).max(0xffff_ffff);

// The crashes modules reported on one release at one place: the module and RVA they happened at.
// The newest one's exception code and frames stand for the rest.
const CrashSummary = z.object({
    productId: ProductId,
    releaseId: WireId,
    channel: ChannelId,
    // The release's seal on its channel; null for one never sealed.
    sealNumber: SealNumber.nullable(),
    moduleHash: ModuleHash,
    rva: U32,
    crashes: z.number().int().positive(),
    firstAt: EpochMs,
    lastAt: EpochMs,
    exceptionCode: U32,
    frames: z.array(U32).readonly(),
});

export const crashesContract = defineContract({
    // Crash summaries from the reports route, newest last crash first, 50 a page. Both filters
    // are optional. Read by whoever reads the review queue.
    "admin.crashes.summaries.list": {
        session: "member",
        effect: "read",
        input: z.strictObject({
            productId: ProductId.nullable(),
            releaseId: WireId.nullable(),
            cursor: Cursor.nullable(),
        }),
        output: pageOf(CrashSummary),
        error: ReadRefusal,
    },
});
