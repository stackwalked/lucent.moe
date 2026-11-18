import { expect, test } from "bun:test";
import { loggablePath } from "../src/core/log.ts";

test("an allowlisted route is logged as is", () => {
    expect(loggablePath("/internal/web/rpc")).toBe("/internal/web/rpc");
});

test("an unlisted path is cut to its first segment so tokens in it never reach the log", () => {
    expect(loggablePath("/setup/secret_bearer_token_value")).toBe("/setup/*");
    expect(loggablePath("/internal/web/rpc/extra")).toBe("/internal/*");
    expect(loggablePath("/")).toBe("/*");
});
