import { systemClock } from "@lucent/core/clock";
import { createIsomorphicFn } from "@tanstack/react-start";
import { getCookie } from "@tanstack/react-start/server";
import { THEME_NAMES, type ThemeName } from "./ui/tokens.ts";

// The account's theme: a plain display-preference cookie (not HttpOnly; nothing secret in it).
// The server reads it so the first paint is already right, with no script in the head; with no
// cookie, the system's preference decides through color-scheme.
export const THEME_COOKIE = "lucent-theme";
const YEAR_MS = 365 * 24 * 60 * 60 * 1_000;

export type ThemeChoice = ThemeName | "system";

function parseTheme(raw: string | undefined): ThemeChoice {
    return THEME_NAMES.find((name) => name === raw) ?? "system";
}

export const currentTheme = createIsomorphicFn()
    .server((): ThemeChoice => parseTheme(getCookie(THEME_COOKIE)))
    .client((): ThemeChoice => parseTheme(document.documentElement.dataset["theme"]));

export async function chooseTheme(choice: ThemeChoice): Promise<void> {
    const root = document.documentElement;
    if (choice === "system") {
        root.removeAttribute("data-theme");
        await cookieStore.delete({ name: THEME_COOKIE, path: "/" });
        return;
    }
    root.dataset["theme"] = choice;
    await cookieStore.set({
        name: THEME_COOKIE,
        value: choice,
        path: "/",
        expires: systemClock.now() + YEAR_MS,
        sameSite: "lax",
    });
}
