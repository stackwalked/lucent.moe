import { expect, test } from "bun:test";
import type { Clock } from "@lucent/core/clock";
import { invariant } from "@lucent/core/contain";
import { createSeededRng } from "@lucent/core/rng";
import { EpochMs } from "@lucent/core/scalars";
import { createWebEntry, type StartHandler } from "../src/server/entry.ts";
import { createThrottle } from "../src/server/throttle.ts";

const ORIGIN = "https://lucent.moe";

function manualClock(): Clock & { readonly advance: (ms: number) => void } {
    let now = 1_800_000_000_000;
    return {
        now: () => EpochMs.parse(now),
        advance: (ms) => {
            now += ms;
        },
    };
}

// Start's stand-in answers with the nonce it was handed, so a test can match it to the header.
const echoNonce: StartHandler = (_req, { context }) =>
    Promise.resolve(new Response(`<script nonce="${context.nonce}"></script>`));

function entryWith(overrides?: {
    readonly start?: StartHandler;
    readonly platformUp?: boolean;
    readonly clock?: ReturnType<typeof manualClock>;
}) {
    const lines: string[] = [];
    const clock = overrides?.clock ?? manualClock();
    const entry = createWebEntry({
        publicOrigin: ORIGIN,
        clock,
        rng: createSeededRng(7),
        start: overrides?.start ?? echoNonce,
        assets: (pathname) => Promise.resolve(new Response(`asset ${pathname}`)),
        checkPlatform: () => Promise.resolve(overrides?.platformUp ?? true),
        throttle: createThrottle({ clock }),
        sink: (line) => lines.push(line),
    });
    return { entry, lines };
}

function request(path: string, init?: RequestInit & { readonly headers?: Record<string, string> }) {
    return new Request(`${ORIGIN}${path}`, {
        ...init,
        headers: { host: "lucent.moe", ...init?.headers },
    });
}

test("a page's CSP names the nonce Start stamped on its scripts", async () => {
    const { entry } = entryWith();
    const res = await entry(request("/"), "203.0.113.9");
    const nonce = /nonce="([^"]+)"/.exec(await res.text())?.[1];
    invariant(nonce !== undefined, "the page carries a nonce");
    expect(res.headers.get("content-security-policy")).toContain(
        `script-src 'nonce-${nonce}' 'strict-dynamic'`,
    );
    expect(res.headers.get("cache-control")).toBe("no-store");
});

test("an avatar image keeps the caching its route set, and every other route still gets no-store", async () => {
    const cached = "private, max-age=31536000, immutable";
    const start: StartHandler = () =>
        Promise.resolve(new Response("bytes", { headers: { "cache-control": cached } }));
    const { entry } = entryWith({ start });
    const digest = "a".repeat(64);
    expect((await entry(request(`/avatars/${digest}`), null)).headers.get("cache-control")).toBe(
        cached,
    );
    for (const path of ["/", "/resources/1/download", "/avatar/upload", "/members/alice"]) {
        expect((await entry(request(path), null)).headers.get("cache-control")).toBe("no-store");
    }
    const { entry: plain } = entryWith();
    expect((await plain(request(`/avatars/${digest}`), null)).headers.get("cache-control")).toBe(
        "no-store",
    );
});

test("every request gets its own nonce", async () => {
    const { entry } = entryWith();
    const first = (await entry(request("/"), null)).headers.get("content-security-policy");
    const second = (await entry(request("/"), null)).headers.get("content-security-policy");
    expect(first).not.toBe(second);
});

test("a response that isn't a page gets a CSP that allows nothing", async () => {
    const { entry } = entryWith();
    const res = await entry(request("/assets/app.js"), null);
    expect(res.headers.get("content-security-policy")).toBe(
        "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    );
});

test("a request for another host is refused with 421 before anything runs", async () => {
    let ran = false;
    const { entry } = entryWith({
        start: () => {
            ran = true;
            return Promise.resolve(new Response("page"));
        },
    });
    const res = await entry(request("/", { headers: { host: "evil.test" } }), null);
    expect([res.status, ran]).toEqual([421, false]);
});

test("a write is refused unless it comes from our own pages", async () => {
    const { entry } = entryWith();
    const post = (headers: Record<string, string>) =>
        entry(request("/_serverFn/abc", { method: "POST", headers }), null);
    expect((await post({})).status).toBe(403);
    expect((await post({ origin: "https://evil.test" })).status).toBe(403);
    expect((await post({ origin: ORIGIN, "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await post({ origin: ORIGIN, "sec-fetch-site": "same-site" })).status).toBe(403);
    expect((await post({ origin: ORIGIN, "sec-fetch-site": "same-origin" })).status).toBe(200);
    expect((await post({ origin: ORIGIN })).status).toBe(200);
});

test("health answers on the socket only, and deep health asks platform", async () => {
    const down = entryWith({ platformUp: false }).entry;
    expect((await down(request("/_health"), null)).status).toBe(200);
    expect((await down(request("/_health?deep"), null)).status).toBe(503);
    const proxied = request("/_health", { headers: { "x-forwarded-for": "203.0.113.9" } });
    expect((await down(proxied, null)).status).toBe(404);
});

test("source maps are never served", async () => {
    const { entry } = entryWith();
    expect((await entry(request("/assets/app.js.map"), null)).status).toBe(404);
});

test("one address gets 300 requests a minute, and more once the minute has passed", async () => {
    const clock = manualClock();
    const { entry } = entryWith({ clock });
    const from = (ip: string) => entry(request("/", { headers: { "x-forwarded-for": ip } }), null);
    for (let i = 0; i < 300; i++) await from("203.0.113.9");
    expect((await from("203.0.113.9")).status).toBe(429);
    expect((await from("203.0.113.10")).status).toBe(200);
    clock.advance(60_000);
    expect((await from("203.0.113.9")).status).toBe(200);
});

test("when Start fails, the page shows a reference that the log line carries too", async () => {
    const { entry, lines } = entryWith({
        start: () => Promise.resolve(JSON.parse("{")),
    });
    const res = await entry(request("/"), null);
    const reference = /reference: ([A-Za-z0-9_-]+)/.exec(await res.text())?.[1];
    invariant(reference !== undefined, "the failure page carries a reference");
    expect(res.status).toBe(500);
    const logged = lines.map((line) => JSON.parse(line));
    expect(logged.find((line) => line.msg === "unhandled")?.requestId).toBe(reference);
    expect(logged.at(-1)).toMatchObject({ status: 500, requestId: reference });
});

test("a setup link's token never reaches the request log", async () => {
    const { entry, lines } = entryWith();
    const token = "t".repeat(43);
    await entry(request(`/setup/${token}`), null);
    expect(lines.join("")).not.toContain(token);
    expect(JSON.parse(lines.at(-1) ?? "{}").path).toBe("/setup/*");
});

test("a browser report is logged as closed fields, once a minute, and never from elsewhere", async () => {
    const clock = manualClock();
    const { entry, lines } = entryWith({ clock });
    const body = JSON.stringify({
        kind: "render",
        route: "/setup/secret",
        message: "boom",
        stack: null,
        requestId: null,
        extra: "dropped",
    });
    const report = (origin: string) =>
        entry(request("/_report", { method: "POST", body, headers: { origin } }), null);
    // Unknown fields fail the strict shape, so the report is ignored rather than logged raw.
    expect((await report(ORIGIN)).status).toBe(204);
    expect(lines.some((line) => line.includes("dropped"))).toBe(false);

    const clean = JSON.stringify({
        kind: "render",
        route: "/setup/secret",
        message: "boom",
        stack: null,
        requestId: null,
    });
    const send = () =>
        entry(
            request("/_report", { method: "POST", body: clean, headers: { origin: ORIGIN } }),
            null,
        );
    await send();
    await send();
    const reports = () => lines.filter((line) => line.includes("browser report"));
    expect(reports()).toHaveLength(1);
    expect(JSON.parse(reports()[0] ?? "{}").route).toBe("/setup/*");
    clock.advance(60_000);
    await send();
    expect(reports()).toHaveLength(2);
    expect((await report("https://evil.test")).status).toBe(403);
});
