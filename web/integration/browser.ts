import { invariant } from "@lucent/core/contain";
import { fromCrossJSON, toJSONAsync } from "seroval";
import { z } from "zod";

// What a browser does on our pages, minus rendering: it keeps cookies, sends the headers our entry
// checks, and calls server functions the way Start's client does. Start's wire format is its own:
// the arguments go as seroval JSON under `data` (the body of a POST, `?payload=` of a GET), and the
// answer comes back as one seroval cross-JSON record of `{ result }` or `{ error }`
// (start-server-core, server-functions-handler). If a Start upgrade changes that, these tests
// fail before anything ships.
export type TestBrowser = {
    // A page or redirect, never followed, so a test sees each 303.
    readonly get: (path: string) => Promise<Response>;
    // A POST server function by its readable id (vite.config.ts), as a page calls it.
    readonly call: (id: string, data?: unknown) => Promise<unknown>;
    // A GET server function, as a loader calls it.
    readonly read: (id: string, data?: unknown) => Promise<unknown>;
    readonly hasCookie: (name: string) => boolean;
};

const Answer = z.union([z.object({ result: z.unknown() }), z.object({ error: z.unknown() })]);

export function createTestBrowser(params: {
    // Where the socket is: the entry listens on loopback.
    readonly socket: string;
    // What the browser thinks it's talking to: the public origin, sent as Host and Origin.
    readonly origin: string;
}): TestBrowser {
    const jar = new Map<string, string>();
    const host = new URL(params.origin).host;

    const remember = (res: Response): void => {
        for (const line of res.headers.getSetCookie()) {
            const [pair = "", ...attributes] = line.split(";");
            const eq = pair.indexOf("=");
            const name = pair.slice(0, eq).trim();
            const value = pair.slice(eq + 1).trim();
            const gone = attributes.some((attribute) => /^\s*max-age=0\s*$/i.test(attribute));
            if (gone || value === "") jar.delete(name);
            else jar.set(name, value);
        }
    };
    const headers = (extra: Record<string, string>): Headers => {
        const sent = new Headers({ host, ...extra });
        if (jar.size > 0) {
            sent.set("cookie", [...jar].map(([name, value]) => `${name}=${value}`).join("; "));
        }
        return sent;
    };
    const serverFn = async (
        method: "GET" | "POST",
        id: string,
        data: unknown,
    ): Promise<unknown> => {
        const payload =
            data === undefined ? undefined : JSON.stringify(await toJSONAsync({ data }));
        const query =
            method === "GET" && payload !== undefined ? `?${new URLSearchParams({ payload })}` : "";
        const body = method === "POST" ? payload : undefined;
        const res = await fetch(`${params.socket}/_serverFn/${id}${query}`, {
            method,
            headers: headers({
                origin: params.origin,
                "sec-fetch-site": "same-origin",
                "x-tsr-serverfn": "true",
                accept: "application/json",
                ...(body === undefined ? {} : { "content-type": "application/json" }),
            }),
            ...(body === undefined ? {} : { body }),
            redirect: "manual",
        });
        remember(res);
        invariant(res.ok, `${id} answered ${res.status}: ${await res.clone().text()}`);
        const answer = Answer.parse(fromCrossJSON(await res.json(), { refs: new Map() }));
        invariant("result" in answer, `${id} threw: ${JSON.stringify(answer)}`);
        return answer.result;
    };

    return {
        async get(path) {
            const res = await fetch(`${params.socket}${path}`, {
                headers: headers({ "sec-fetch-site": "none" }),
                redirect: "manual",
            });
            remember(res);
            return res;
        },
        call: (id, data) => serverFn("POST", id, data),
        read: (id, data) => serverFn("GET", id, data),
        hasCookie: (name) => jar.has(name),
    };
}

// What our server functions hand back (src/server/outcome.ts), checked rather than trusted.
const Outcome = z.union([
    z.object({ ok: z.literal(true), value: z.unknown() }),
    z.object({ ok: z.literal(false), refused: z.object({ code: z.string() }) }),
]);

export function accepted<T extends z.ZodType>(value: T, answer: unknown): z.output<T> {
    const parsed = Outcome.parse(answer);
    invariant(parsed.ok, `refused: ${JSON.stringify(parsed)}`);
    return value.parse(parsed.value);
}

export function refusedCode(answer: unknown): string {
    const parsed = Outcome.parse(answer);
    invariant(!parsed.ok, "expected a refusal");
    return parsed.refused.code;
}
