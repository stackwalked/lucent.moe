import { systemClock } from "@lucent/core/clock";
import { ACTION_POLICY, type Action } from "@lucent/policy/action-list";
import { RECENT_WINDOW_SECONDS, STEP_UP_WINDOW_SECONDS } from "@lucent/policy/policy";
import { useRouteContext } from "@tanstack/react-router";
import type { Outcome } from "../../server/outcome.ts";
import { memberOf } from "../../viewer.ts";
import { useStepUp, useStepUpPrompt } from "../step-up/StepUp.tsx";

// A staff action: when it needs a step-up and the viewer's last one is older than the window,
// the passkey is asked for before anything is sent. The guard behind it still catches a step-up
// that lapsed in between, and retries once.
export function useStaffAction() {
    const guard = useStepUp();
    const { ask, provenAt } = useStepUpPrompt();
    const { session } = useRouteContext({ from: "__root__" });
    const viewer = memberOf(session);
    return async <T>(action: Action, run: () => Promise<Outcome<T>>): Promise<Outcome<T>> => {
        const stepUpAt = Math.max(viewer?.stepUpAt ?? 0, provenAt() ?? 0);
        const tier = ACTION_POLICY[action].stepUp;
        // "fresh" asks for a step-up in the last 30 minutes; "recent" for a confirmation (the
        // sign-in or a step-up) in the last 7 days.
        const confirmedAt = Math.max(stepUpAt, viewer?.authenticatedAt ?? 0);
        const age = systemClock.now() - (tier === "recent" ? confirmedAt : stepUpAt);
        const window = tier === "recent" ? RECENT_WINDOW_SECONDS : STEP_UP_WINDOW_SECONDS;
        if (tier !== "none" && age >= window * 1_000) {
            const proof = await ask();
            if (proof === "cancelled")
                return { ok: false, refused: { code: "STEP_UP_REQUIRED", reference: null } };
            if (proof !== "confirmed") return { ok: false, refused: proof };
        }
        return await guard(run);
    };
}
