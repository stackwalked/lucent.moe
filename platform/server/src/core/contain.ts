import { err, ok, type Result } from "./result.ts";

const defectBrand: unique symbol = Symbol("lucent.invariant.defect");

export type InvariantDefect = {
    readonly [defectBrand]: true;
    readonly message: string;
    readonly stack: string | undefined;
};

export function isInvariantDefect(cause: unknown): cause is InvariantDefect {
    return typeof cause === "object" && cause !== null && defectBrand in cause;
}

export function raiseInvariant(message: string): never {
    const captured = new Error(message);
    const defect: InvariantDefect = {
        [defectBrand]: true,
        message,
        stack: captured.stack,
    };
    throw defect;
}

export function invariant(condition: unknown, message: string): asserts condition {
    if (!condition) {
        raiseInvariant(message);
    }
}

export function unreachable(value: never, context = "unreachable branch"): never {
    return raiseInvariant(`${context}: ${String(value)}`);
}

export function trySync<T, E>(work: () => T, mapError: (cause: unknown) => E): Result<T, E> {
    try {
        return ok(work());
    } catch (cause) {
        if (isInvariantDefect(cause)) {
            throw cause;
        }
        return err(mapError(cause));
    }
}

export async function tryAsync<T, E>(
    work: () => Promise<T>,
    mapError: (cause: unknown) => E,
): Promise<Result<T, E>> {
    try {
        return ok(await work());
    } catch (cause) {
        if (isInvariantDefect(cause)) {
            throw cause;
        }
        return err(mapError(cause));
    }
}

export function describeUnknownError(cause: unknown): string {
    if (isInvariantDefect(cause)) {
        return `invariant violation: ${cause.message}`;
    }
    if (cause instanceof Error) {
        return cause.message;
    }
    return String(cause);
}

export async function containBoundary<R, U = R>(params: {
    readonly run: () => Promise<R>;
    readonly onUnhandled: (detail: string, failureKind: "defect" | "exception") => U | Promise<U>;
}): Promise<R | U> {
    try {
        return await params.run();
    } catch (cause) {
        const kind = isInvariantDefect(cause) ? "defect" : "exception";
        return await params.onUnhandled(describeUnknownError(cause), kind);
    }
}

export function ignoreErrorsSync(work: () => void): void {
    try {
        work();
    } catch (cause) {
        if (isInvariantDefect(cause)) {
            throw cause;
        }
    }
}

export async function ignoreErrors(work: () => Promise<unknown>): Promise<void> {
    try {
        await work();
    } catch (cause) {
        if (isInvariantDefect(cause)) {
            throw cause;
        }
    }
}

export async function onThrowCleanup<T>(
    work: () => Promise<T>,
    cleanup: () => void | Promise<void>,
): Promise<T> {
    try {
        return await work();
    } catch (cause) {
        await cleanup();
        throw cause;
    }
}
