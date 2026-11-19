import { expect, test } from "bun:test";
import { deviceLabel } from "../src/user-agent.ts";

test("common browsers read as browser on system", () => {
    const cases: readonly (readonly [string, string])[] = [
        [
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:147.0) Gecko/20100101 Firefox/147.0",
            "Firefox on Windows",
        ],
        [
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0",
            "Edge on Windows",
        ],
        [
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
            "Safari on macOS",
        ],
        [
            "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1",
            "Safari on iOS",
        ],
        [
            "Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36",
            "Chrome on Android",
        ],
        [
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
            "Chrome on Linux",
        ],
    ];
    for (const [ua, label] of cases)
        expect({ ua, label: deviceLabel(ua, "?") }).toEqual({ ua, label });
});

test("an unknown or missing agent gets the fallback", () => {
    expect(deviceLabel(null, "Unknown device")).toBe("Unknown device");
    expect(deviceLabel("curl/8.0", "Unknown device")).toBe("Unknown device");
});
