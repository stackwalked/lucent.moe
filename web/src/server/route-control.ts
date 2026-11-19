import { notFound, redirect } from "@tanstack/react-router";
import { createIsomorphicFn } from "@tanstack/react-start";
import { setResponseStatus } from "@tanstack/react-start/server";
import type { Unavailable } from "../failure.ts";

// TanStack Router changes routes by throwing (redirect, notFound): the one place in web that
// throws, as core/contain.ts is everywhere else (ast-grep: ts-contain-only). Safe in the browser
// bundle too: route guards run on client navigations, and the server-only status call is
// stripped there.

export const SIGN_IN_PATH = "/sign-in";

export function toSignIn(): never {
    throw redirect({ href: SIGN_IN_PATH, statusCode: 303 });
}

// Somewhere of ours already checked (a safe returnTo); after a POST or a guard, so 303.
export function toPage(href: string): never {
    throw redirect({ href, statusCode: 303 });
}

export function toNotFound(): never {
    throw notFound();
}

const markUnavailable = createIsomorphicFn()
    .server(() => setResponseStatus(503))
    .client(() => undefined);

export function toUnavailable(reference: string): never {
    markUnavailable();
    const unavailable: Unavailable = { unavailable: true, reference };
    throw unavailable;
}
