import { EpochMs } from "@lucent/core/scalars";

// The given date, as the start of that day in UTC: a role or entitlement held "until" it.
export function untilFrom(raw: FormDataEntryValue | null): EpochMs | null {
    const match = typeof raw === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw) : null;
    if (match === null) return null;
    const parsed = EpochMs.safeParse(
        Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])),
    );
    return parsed.success ? parsed.data : null;
}
