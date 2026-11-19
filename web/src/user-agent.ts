// "firefox on windows" from a user agent string: a new passkey's default name, and how the
// session list says where you're signed in. Order matters: Edge and Opera also say Chrome, Chrome
// also says Safari, Android also says Linux, iOS also says Mac OS X.
const BROWSERS: readonly (readonly [RegExp, string])[] = [
    [/Edg\//, "edge"],
    [/OPR\//, "opera"],
    [/Firefox\//, "firefox"],
    [/Chrome\//, "chrome"],
    [/Safari\//, "safari"],
];

const SYSTEMS: readonly (readonly [RegExp, string])[] = [
    [/Windows/, "windows"],
    [/Android/, "android"],
    [/iPhone|iPad|iPod/, "ios"],
    [/CrOS/, "chromeos"],
    [/Mac OS X|Macintosh/, "macos"],
    [/Linux/, "linux"],
];

export function deviceLabel(userAgent: string | null, unknown: string): string {
    if (userAgent === null) return unknown;
    const browser = BROWSERS.find(([pattern]) => pattern.test(userAgent))?.[1];
    const system = SYSTEMS.find(([pattern]) => pattern.test(userAgent))?.[1];
    if (browser === undefined) return system ?? unknown;
    return system === undefined ? browser : `${browser} on ${system}`;
}
