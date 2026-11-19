import { createFileRoute } from "@tanstack/react-router";
import { SITE_COPY } from "../../copy/site.ts";
import { DOWNLOAD_COPY } from "../../features/download/copy.ts";
import { DownloadPage } from "../../features/download/DownloadPage.tsx";
import { fetchProducts } from "../../features/products/server.ts";

export const Route = createFileRoute("/_member/download")({
    loader: () => fetchProducts(),
    head: () => ({ meta: [{ title: SITE_COPY.pageTitle(DOWNLOAD_COPY.title) }] }),
    component: DownloadPage,
});
