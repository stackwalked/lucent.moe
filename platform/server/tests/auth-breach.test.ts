import { expect, test } from "bun:test";
import { invariant } from "@lucent/core/contain";
import { err } from "@lucent/core/result";
import { createSeededRng } from "@lucent/core/rng";
import { z } from "zod";
import { createPwnedPasswordsCheck } from "../src/auth/breach.ts";
import { setPassword } from "../src/auth/credentials.ts";
import { redeemSetupLink } from "../src/auth/setup.ts";
import { queryOne, sql } from "../src/db/pool.ts";
import { newSetupLink } from "./auth-fixtures.ts";
import { createTestAuthDeps } from "./harness/auth.ts";
import { sharedTestCluster } from "./harness/pg-test.ts";

// SHA-1("password"), the range API's own example.
const PREFIX = "5BAA6";
const SUFFIX = "1E4C9B93F3F0682250B6CF8331B7EE68FD8";

function rangeApi(body: string) {
    const asked: Request[] = [];
    return {
        asked,
        fetch: (req: Request) => {
            asked.push(req);
            return Promise.resolve(new Response(body));
        },
    };
}

test("only the hash's first five hex digits leave, padded, and a listed suffix is a breach", async () => {
    const api = rangeApi(`0018A45C4D1DEF81644B54AB7F969B88D65:3\r\n${SUFFIX}:10434004\r\n`);
    const check = createPwnedPasswordsCheck({
        baseUrl: "https://range.test/range/",
        onUnavailable: () => {},
        fetch: api.fetch,
    });
    expect(await check("password")).toBe("breached");
    const [req] = api.asked;
    invariant(req !== undefined, "the range was asked for");
    expect(req.url).toBe(`https://range.test/range/${PREFIX}`);
    expect(req.headers.get("add-padding")).toBe("true");
});

test("a padding entry is no breach, and neither is a suffix that isn't listed", async () => {
    const padded = rangeApi(`${SUFFIX}:0\r\n`);
    const check = (fetcher: (req: Request) => Promise<Response>) =>
        createPwnedPasswordsCheck({
            baseUrl: "https://range.test/range/",
            onUnavailable: () => {},
            fetch: fetcher,
        })("password");
    expect(await check(padded.fetch)).toBe("clear");
    expect(await check(rangeApi("0018A45C4D1DEF81644B54AB7F969B88D65:3\r\n").fetch)).toBe("clear");
});

test("when the range API can't answer, the password is let through and the miss reported", async () => {
    const reported: string[] = [];
    const check = createPwnedPasswordsCheck({
        baseUrl: "https://range.test/range/",
        onUnavailable: (detail) => reported.push(detail),
        fetch: () => Promise.reject(new TypeError("connection refused")),
    });
    expect(await check("password")).toBe("unknown");
    const down = createPwnedPasswordsCheck({
        baseUrl: "https://range.test/range/",
        onUnavailable: (detail) => reported.push(detail),
        fetch: () => Promise.resolve(new Response("", { status: 503 })),
    });
    expect(await down("password")).toBe("unknown");
    expect(reported).toHaveLength(2);
    expect(reported[1]).toBe("status 503");
});

test("a breached password is refused and nothing is stored", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ browserDb }) => {
        const rng = createSeededRng(911);
        const deps = {
            ...(await createTestAuthDeps(browserDb, rng)),
            breachCheck: () => Promise.resolve("breached" as const),
        };
        const link = await newSetupLink(deps, rng, "alice@lucent.test");
        const setup = await redeemSetupLink(deps, { setupToken: link.setupToken });
        invariant(setup.ok, "the setup link redeems");
        expect(
            await setPassword(deps, {
                sessionToken: setup.value.sessionToken,
                password: "correct horse battery staple",
            }),
        ).toEqual(err({ code: "PASSWORD_BREACHED" }));
        const stored = await queryOne(
            browserDb,
            z.object({ stored: z.boolean() }),
            sql`select exists (select 1 from password_credential where account_id = ${link.accountId}) as stored`,
        );
        expect(stored.ok && stored.value?.stored).toBe(false);
    });
});
