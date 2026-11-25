import { SideNav } from "../../ui/SideNav/SideNav.tsx";
import type { Viewer } from "../../viewer.ts";
import { ADMIN_COPY } from "./copy.ts";
import { adminSections, SECTION_PATHS } from "./sections.ts";

// The admin side nav: only the sections the viewer may read, hidden rather than disabled.
export function AdminNav({ viewer }: { readonly viewer: Viewer }) {
    const sections = adminSections(viewer);
    return (
        <SideNav
            label={ADMIN_COPY.admin}
            items={SECTION_PATHS.filter(([section]) => sections[section]).map(
                ([section, path]) => ({ to: path, label: ADMIN_COPY[section] }),
            )}
        />
    );
}
