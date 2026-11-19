import { expect, test } from "bun:test";
import { AccountId, EpochMs } from "@lucent/core/scalars";
import { auditDetail, auditFilter, startOfDayUtc } from "../src/features/admin/audit/filter.ts";

const ACCOUNT = AccountId.parse("acc_AAAAAAAAAAAAAAAAAAAAAA");

test("tokens map onto the platform filter and free text is dropped", () => {
    expect(
        auditFilter(
            `actor:cli:bootstrap target:${ACCOUNT} op:account.suspend before:2026-03-01 ali`,
        ),
    ).toEqual({
        actorId: "cli:bootstrap",
        targetAccountId: ACCOUNT,
        operation: "account.suspend",
        before: EpochMs.parse(Date.UTC(2026, 2, 1)),
    });
    expect(auditFilter(undefined)).toEqual({
        actorId: null,
        targetAccountId: null,
        operation: null,
        before: null,
    });
});

test("a value that does not fit its key is ignored, not refused", () => {
    expect(auditFilter("target:someone before:soon op:a/b actor:x*y")).toEqual({
        actorId: null,
        targetAccountId: null,
        operation: null,
        before: null,
    });
    expect(auditFilter(`op:${"a".repeat(65)}`).operation).toBeNull();
});

test("the first of a repeated key wins", () => {
    expect(auditFilter("op:role.assign op:role.unassign").operation).toBe("role.assign");
});

test("before takes only real calendar days from 1970, as 00:00 UTC", () => {
    expect(startOfDayUtc("1970-01-01")).toBe(EpochMs.parse(0));
    expect(startOfDayUtc("2024-02-29")).toBe(EpochMs.parse(Date.UTC(2024, 1, 29)));
    for (const bad of [
        "2026-02-29",
        "2026-02-31",
        "2026-13-01",
        "2026-00-10",
        "2026-04-00",
        "1969-12-31",
        "0050-01-01",
        "2026-3-1",
        "2026-03-01T00:00",
        " 2026-03-01",
        "",
    ]) {
        expect(startOfDayUtc(bad)).toBeNull();
    }
});

test("detail shows a reason, a rename or a role, and nothing it does not recognise", () => {
    expect(auditDetail("account.suspend", { accountId: ACCOUNT, reason: "spam" })).toEqual({
        kind: "reason",
        reason: "spam",
    });
    expect(auditDetail("account.rename", { accountId: ACCOUNT, from: null, to: "ali" })).toEqual({
        kind: "rename",
        from: null,
        to: "ali",
    });
    expect(auditDetail("role.assign", { roleId: "role_mod", expiresAt: EpochMs.parse(5) })).toEqual(
        {
            kind: "role",
            roleId: "role_mod",
            expiresAt: EpochMs.parse(5),
        },
    );
    expect(auditDetail("role.assign", { roleId: "role_mod", expiresAt: null })).toEqual({
        kind: "role",
        roleId: "role_mod",
        expiresAt: null,
    });
    expect(
        auditDetail("role.unassign", { roleId: "role_mod", expiresAt: EpochMs.parse(5) }),
    ).toEqual({
        kind: "role",
        roleId: "role_mod",
        expiresAt: null,
    });
    expect(auditDetail("account.rename", { from: 3, to: "x" })).toEqual({ kind: "none" });
    expect(auditDetail("role.upsert", { roleId: "role_mod", before: null })).toEqual({
        kind: "none",
    });
    expect(auditDetail("account.create", {})).toEqual({ kind: "none" });
});
