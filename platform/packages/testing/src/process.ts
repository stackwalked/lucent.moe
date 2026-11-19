import { invariant } from "@lucent/core/contain";
import type { Subprocess } from "bun";
import { inheritedEnvironment } from "./config.ts";

// A server a test runs in its own process, as production does. Its output is read for as long as
// it runs: a pipe nobody drains fills up and blocks the child mid-log.
export type ChildServer = {
    // Resolves with the first line matching `pattern`; fails with everything printed so far if the
    // child exits or `timeoutMs` passes first.
    readonly waitFor: (pattern: RegExp, timeoutMs?: number) => Promise<string>;
    readonly output: () => string;
    readonly stop: () => Promise<void>;
};

export function spawnServer(params: {
    readonly command: readonly string[];
    readonly cwd: string;
    readonly env: Readonly<Record<string, string>>;
}): ChildServer {
    const child: Subprocess<"ignore", "pipe", "pipe"> = Bun.spawn([...params.command], {
        cwd: params.cwd,
        env: { ...inheritedEnvironment(), ...params.env },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
    });
    const lines: string[] = [];
    let exited = false;
    const waiters = new Set<() => void>();
    const wake = (): void => {
        for (const waiter of waiters) waiter();
    };
    const drain = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
        const decoder = new TextDecoder();
        let partial = "";
        for await (const chunk of stream) {
            partial += decoder.decode(chunk, { stream: true });
            const complete = partial.split("\n");
            partial = complete.pop() ?? "";
            lines.push(...complete);
            wake();
        }
        if (partial !== "") lines.push(partial);
    };
    void drain(child.stdout);
    void drain(child.stderr);
    void child.exited.then(() => {
        exited = true;
        wake();
    });

    const output = (): string => lines.join("\n");
    return {
        output,
        waitFor: (pattern, timeoutMs = 20_000) =>
            new Promise((resolve, reject) => {
                let timedOut = false;
                const timer = setTimeout(() => {
                    timedOut = true;
                    settle();
                }, timeoutMs);
                const settle = (): void => {
                    const line = lines.find((candidate) => pattern.test(candidate));
                    if (line === undefined && !exited && !timedOut) return;
                    clearTimeout(timer);
                    waiters.delete(settle);
                    if (line !== undefined) resolve(line);
                    else reject(new Error(`no line matching ${pattern}:\n${output()}`));
                };
                waiters.add(settle);
                settle();
            }),
        stop: async () => {
            child.kill();
            await child.exited;
        },
    };
}

// A command run to its end, for its exit code and output.
export async function runToEnd(params: {
    readonly command: readonly string[];
    readonly cwd: string;
    readonly env: Readonly<Record<string, string>>;
}): Promise<{ readonly stdout: string }> {
    const child = Bun.spawn([...params.command], {
        cwd: params.cwd,
        env: { ...inheritedEnvironment(), ...params.env },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
    ]);
    invariant(code === 0, `${params.command.join(" ")} exited ${code}: ${stderr}${stdout}`);
    return { stdout };
}
