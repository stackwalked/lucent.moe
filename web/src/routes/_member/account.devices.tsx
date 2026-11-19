import { createFileRoute } from "@tanstack/react-router";
import { SITE_COPY } from "../../copy/site.ts";
import { DEVICES_COPY } from "../../features/devices/copy.ts";
import { DevicesPage } from "../../features/devices/DevicesPage.tsx";
import { fetchDevices } from "../../features/devices/server.ts";

export const Route = createFileRoute("/_member/account/devices")({
    loader: () => fetchDevices(),
    head: () => ({ meta: [{ title: SITE_COPY.pageTitle(DEVICES_COPY.title) }] }),
    component: DevicesPage,
});
