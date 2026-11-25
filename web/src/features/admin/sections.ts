import { toNotFound, toPage } from "../../server/route-control.ts";
import type { Session, Viewer } from "../../viewer.ts";
import { memberOf, viewerCan } from "../../viewer.ts";

export type AdminSection =
    | "accounts"
    | "roles"
    | "releases"
    | "overrides"
    | "updates"
    | "review"
    | "moderation"
    | "tickets"
    | "resources"
    | "audit"
    | "system"
    | "usage"
    | "discord";

// In the order the nav lists them.
export const SECTION_PATHS = [
    ["accounts", "/admin/accounts"],
    ["roles", "/admin/roles"],
    ["releases", "/admin/releases"],
    ["overrides", "/admin/overrides"],
    ["updates", "/admin/updates"],
    ["review", "/admin/review"],
    ["moderation", "/admin/moderation"],
    ["tickets", "/admin/tickets"],
    ["resources", "/admin/resources"],
    ["audit", "/admin/audit"],
    ["system", "/admin/system"],
    ["usage", "/admin/usage"],
    ["discord", "/admin/discord"],
] as const satisfies readonly (readonly [AdminSection, string])[];

// Which admin sections a viewer may see: each needs its read permission, roles, releases and update
// days either of their two. The review queue is read by whoever could act on it; resources by
// whoever may publish one, which is a release of its own kind.
export function adminSections(viewer: Viewer): Readonly<Record<AdminSection, boolean>> {
    return {
        accounts: viewerCan(viewer, "accounts:read"),
        roles: viewerCan(viewer, "roles:assign") || viewerCan(viewer, "roles:manage"),
        releases: viewerCan(viewer, "releases:promote") || viewerCan(viewer, "facts:promote"),
        overrides: viewerCan(viewer, "facts:override"),
        updates: viewerCan(viewer, "releases:promote") || viewerCan(viewer, "facts:promote"),
        review: viewerCan(viewer, "accounts:suspend"),
        moderation: viewerCan(viewer, "moderation:remove"),
        tickets: viewerCan(viewer, "tickets:reply"),
        resources: viewerCan(viewer, "releases:promote"),
        audit: viewerCan(viewer, "audit:read"),
        system: viewerCan(viewer, "audit:read"),
        usage: viewerCan(viewer, "audit:read"),
        discord: viewerCan(viewer, "roles:manage"),
    };
}

export function isStaff(viewer: Viewer): boolean {
    return Object.values(adminSections(viewer)).some((visible) => visible);
}

// /admin has no page of its own: staff start at the first section they may see.
export function toFirstSection(session: Session): never {
    const viewer = memberOf(session);
    const sections = viewer === null ? null : adminSections(viewer);
    const first = SECTION_PATHS.find(([section]) => sections?.[section] === true);
    return first === undefined ? toNotFound() : toPage(first[1]);
}

// _admin lets any staff through; a section the viewer can't read is a 404 like the rest of the
// area, rather than platform's FORBIDDEN surfacing as a failure.
export function guardSection(session: Session, section: AdminSection): void {
    const viewer = memberOf(session);
    if (viewer === null || !adminSections(viewer)[section]) toNotFound();
}
