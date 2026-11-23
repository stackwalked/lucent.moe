import { type Ok, ok } from "@lucent/core/result";
import type { ProductState } from "./product.ts";

type Lifecycle = {
    readonly listed: boolean;
    readonly issuable: boolean;
    readonly startRefusal: "NOT_FOUND" | "RELEASE_UNAVAILABLE" | null;
};

export function decideProductLifecycle(
    state: ProductState,
    holding: "none" | "current" | "past" = "none",
): Ok<Lifecycle> {
    switch (state) {
        case "announced":
            return ok({ listed: true, issuable: false, startRefusal: "NOT_FOUND" });
        case "seed":
            return ok({ listed: holding === "current", issuable: true, startRefusal: null });
        case "live":
            return ok({ listed: true, issuable: true, startRefusal: null });
        case "retired":
            return ok({
                listed: holding !== "none",
                issuable: false,
                startRefusal: "RELEASE_UNAVAILABLE",
            });
    }
}
