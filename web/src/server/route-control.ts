import { notFound, redirect } from "@tanstack/react-router";
import { setResponseStatus } from "@tanstack/react-start/server";
import type { Unavailable } from "../failure.ts";

// TanStack Router changes routes by throwing (redirect, notFound): the one place in web that
// throws, as core/contain.ts is everywhere else (ast-grep: ts-contain-only).

export const SIGN_IN_PATH = "/sign-in";

export function toSignIn(): never {
    throw redirect({ href: SIGN_IN_PATH, statusCode: 303 });
}

export function toNotFound(): never {
    throw notFound();
}

export function toUnavailable(reference: string): never {
    setResponseStatus(503);
    const unavailable: Unavailable = { unavailable: true, reference };
    throw unavailable;
}
