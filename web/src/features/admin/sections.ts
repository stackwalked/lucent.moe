import { toNotFound, toPage } from "../../server/route-control.ts";
import type { Session, Viewer } from "../../viewer.ts";
import { memberOf, viewerCan } from "../../viewer.ts";

export type AdminSection = "accounts" | "roles" | "releases" | "audit";

// In the order the nav lists them.
export const SECTION_PATHS = [
    ["accounts", "/admin/accounts"],
    ["roles", "/admin/roles"],
    ["releases", "/admin/releases"],
    ["audit", "/admin/audit"],
] as const satisfies readonly (readonly [AdminSection, string])[];

// Which admin sections a viewer may see: each needs its read permission, roles and releases either
// of their two.
export function adminSections(viewer: Viewer): Readonly<Record<AdminSection, boolean>> {
    return {
        accounts: viewerCan(viewer, "accounts:read"),
        roles: viewerCan(viewer, "roles:assign") || viewerCan(viewer, "roles:manage"),
        releases: viewerCan(viewer, "releases:promote") || viewerCan(viewer, "facts:promote"),
        audit: viewerCan(viewer, "audit:read"),
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
