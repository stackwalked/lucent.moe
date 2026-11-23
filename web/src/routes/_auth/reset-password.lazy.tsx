import { createLazyFileRoute } from "@tanstack/react-router";
import { ResetPage } from "../../features/auth/ResetPage.tsx";
export const Route = createLazyFileRoute("/_auth/reset-password")({ component: ResetPage });
