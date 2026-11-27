import { toNotFound, toPage } from "../../server/route-control.ts";
import type { Session, Viewer } from "../../viewer.ts";
import { memberOf, viewerCan } from "../../viewer.ts";
import { queueKinds } from "./queue/merge.ts";

export type AdminSection =
    | "accounts"
    | "roles"
    | "releases"
    | "overrides"
    | "updates"
    | "review"
    | "crashes"
    | "moderation"
    | "cloud"
    | "tickets"
    | "resources"
    | "changelog"
    | "audit"
    | "system"
    | "usage"
    | "discord"
    | "applications"
    | "invites"
    | "queue";

export type AdminTab = "queue" | "members" | "products" | "cloud" | "system";

// The staff area in one table: tabs, their sub-tabs in order, each sub-tab's page and the section
// whose permissions decide it. A sub-tab shows only to a viewer who can do something in it, and a
// tab only with a sub-tab to show.
export const ADMIN_TABS = [
    {
        tab: "queue",
        subs: [
            { section: "queue", to: "/admin" },
            { section: "tickets", to: "/admin/queue/tickets" },
            { section: "applications", to: "/admin/queue/applications" },
            { section: "moderation", to: "/admin/queue/reports" },
            { section: "review", to: "/admin/queue/flags" },
        ],
    },
    {
        tab: "members",
        subs: [
            { section: "accounts", to: "/admin/members/accounts" },
            { section: "invites", to: "/admin/members/invites" },
            { section: "roles", to: "/admin/members/roles" },
        ],
    },
    {
        tab: "products",
        subs: [
            { section: "changelog", to: "/admin/products/changelog" },
            { section: "releases", to: "/admin/products/releases" },
            { section: "updates", to: "/admin/products/updates" },
            { section: "overrides", to: "/admin/products/overrides" },
            { section: "crashes", to: "/admin/products/crashes" },
            { section: "usage", to: "/admin/products/usage" },
        ],
    },
    {
        tab: "cloud",
        subs: [
            { section: "cloud", to: "/admin/cloud/listings" },
            { section: "resources", to: "/admin/cloud/resources" },
        ],
    },
    {
        tab: "system",
        subs: [
            { section: "audit", to: "/admin/system/audit" },
            { section: "system", to: "/admin/system/jobs" },
            { section: "discord", to: "/admin/system/discord" },
        ],
    },
] as const satisfies readonly {
    readonly tab: AdminTab;
    readonly subs: readonly { readonly section: AdminSection; readonly to: string }[];
}[];

export type AdminSub = (typeof ADMIN_TABS)[number]["subs"][number];

// The tabs a viewer sees, each with the sub-tabs they may open.
export function visibleTabs(viewer: Viewer) {
    const sections = adminSections(viewer);
    return ADMIN_TABS.map(({ tab, subs }) => ({
        tab,
        subs: subs.filter((sub) => sections[sub.section]),
    })).filter(({ subs }) => subs.length > 0);
}

// Which admin sections a viewer may see: each needs its read permission, roles, releases and update
// days either of their two. The review queue is read by whoever could act on it, and so are crashes; resources by
// whoever may publish one, which is a release of its own kind.
export function adminSections(viewer: Viewer): Readonly<Record<AdminSection, boolean>> {
    return {
        accounts: viewerCan(viewer, "accounts:read"),
        roles: viewerCan(viewer, "roles:assign") || viewerCan(viewer, "roles:manage"),
        releases: viewerCan(viewer, "releases:promote") || viewerCan(viewer, "facts:promote"),
        overrides: viewerCan(viewer, "facts:override"),
        updates: viewerCan(viewer, "releases:promote") || viewerCan(viewer, "facts:promote"),
        review: viewerCan(viewer, "risk:review"),
        crashes: viewerCan(viewer, "risk:review"),
        moderation: viewerCan(viewer, "moderation:remove"),
        cloud: viewerCan(viewer, "moderation:remove"),
        tickets: viewerCan(viewer, "tickets:reply"),
        queue: queueKinds((action) => viewerCan(viewer, action)).length > 0,
        resources: viewerCan(viewer, "releases:promote"),
        changelog: viewerCan(viewer, "releases:promote"),
        audit: viewerCan(viewer, "audit:read"),
        system: viewerCan(viewer, "audit:read"),
        usage: viewerCan(viewer, "audit:read"),
        discord: viewerCan(viewer, "roles:manage"),
        applications: viewerCan(viewer, "applications:review"),
        invites: viewerCan(viewer, "accounts:read"),
    };
}

export function isStaff(viewer: Viewer): boolean {
    return Object.values(adminSections(viewer)).some((visible) => visible);
}

// /admin has no page of its own yet: staff start at the first sub-tab they may open.
export function toFirstSection(session: Session): never {
    const viewer = memberOf(session);
    const first = viewer === null ? undefined : visibleTabs(viewer)[0]?.subs[0];
    return first === undefined ? toNotFound() : toPage(first.to);
}

// _admin lets any staff through; a section the viewer can't read is a 404 like the rest of the
// area, rather than platform's FORBIDDEN surfacing as a failure.
export function guardSection(session: Session, section: AdminSection): void {
    const viewer = memberOf(session);
    if (viewer === null || !adminSections(viewer)[section]) toNotFound();
}
