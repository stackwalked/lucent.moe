import { createFileRoute } from "@tanstack/react-router";
import { toFirstSection } from "../../features/admin/sections.ts";

export const Route = createFileRoute("/_admin/admin/")({
    beforeLoad: ({ context }) => toFirstSection(context.session),
});
