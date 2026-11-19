import type { AccountStatus } from "@lucent/rpc/web";
import { Status } from "../../../ui/Status/Status.tsx";
import { STATUS_COPY } from "./copy.ts";

// Pink for what needs someone (setup pending), shu for what's stopped.
export function AccountStatusBadge({ status }: { readonly status: AccountStatus }) {
    if (status === "active") return <Status icon="check">{STATUS_COPY.active}</Status>;
    if (status === "setup_pending") return <Status tone="pink">{STATUS_COPY.setup_pending}</Status>;
    return <Status tone="shu">{STATUS_COPY[status]}</Status>;
}
