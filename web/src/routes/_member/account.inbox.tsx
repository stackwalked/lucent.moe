import { createFileRoute } from "@tanstack/react-router";
import { SITE_COPY } from "../../copy/site.ts";
import { INBOX_TITLE } from "../../features/inbox/copy.ts";
import { InboxPage } from "../../features/inbox/InboxPage.tsx";
import { fetchInbox } from "../../features/inbox/server.ts";
import { inboxSearch } from "../../search.ts";

export const Route = createFileRoute("/_member/account/inbox")({
    validateSearch: inboxSearch,
    loaderDeps: ({ search }) => ({ cursor: search.cursor ?? null }),
    loader: ({ deps }) => fetchInbox({ data: deps }),
    head: () => ({ meta: [{ title: SITE_COPY.pageTitle(INBOX_TITLE) }] }),
    component: InboxPage,
});
