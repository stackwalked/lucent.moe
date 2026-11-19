import { expect, test } from "bun:test";
import { deviceLabel } from "../src/user-agent.ts";

test("common browsers read as browser on system", () => {
    const cases: readonly (readonly [string, string])[] = [
        [
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:147.0) Gecko/20100101 Firefox/147.0",
            "firefox on windows",
        ],
        [
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0",
            "edge on windows",
        ],
        [
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
            "safari on macos",
        ],
        [
            "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1",
            "safari on ios",
        ],
        [
            "Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36",
            "chrome on android",
        ],
        [
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
            "chrome on linux",
        ],
    ];
    for (const [ua, label] of cases)
        expect({ ua, label: deviceLabel(ua, "?") }).toEqual({ ua, label });
});

test("an unknown or missing agent gets the fallback", () => {
    expect(deviceLabel(null, "Unknown device")).toBe("Unknown device");
    expect(deviceLabel("curl/8.0", "Unknown device")).toBe("Unknown device");
});
