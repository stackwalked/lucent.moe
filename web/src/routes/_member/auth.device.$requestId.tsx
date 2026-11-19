import { createFileRoute } from "@tanstack/react-router";
import { SITE_COPY } from "../../copy/site.ts";
import { SIGN_IN_REQUEST_COPY } from "../../features/devices/copy.ts";
import { SignInRequestPage } from "../../features/devices/SignInRequestPage.tsx";
import { fetchSignInRequest } from "../../features/devices/server.ts";
import { toNotFound } from "../../server/route-control.ts";

// Where the loader's pushed sign-in request sends the browser. Signed out, the member signs in
// first and comes back here.
export const Route = createFileRoute("/_member/auth/device/$requestId")({
    loader: ({ params }) => {
        if (!/^lauth_[A-Za-z0-9_-]{22}$/.test(params.requestId)) return toNotFound();
        return fetchSignInRequest({ data: { requestId: params.requestId } });
    },
    head: () => ({ meta: [{ title: SITE_COPY.pageTitle(SIGN_IN_REQUEST_COPY.title) }] }),
    component: SignInRequestPage,
});
