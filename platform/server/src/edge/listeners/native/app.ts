import { containBoundary } from "@lucent/core/contain";
import { Hono } from "hono";
import { mountAuth } from "./auth.ts";
import { mountDelivery } from "./delivery.ts";
import { mountEnrollments } from "./enrollments.ts";
import { refusalResponse } from "./http.ts";
import { createRouteContext, type NativeDeps } from "./route-context.ts";
import { mountRuntime } from "./runtime.ts";

export function createNativeApp(deps: NativeDeps): Hono {
    const app = new Hono();
    const routes = createRouteContext(deps);
    const { unavailable } = routes;
    // Hono routes thrown Errors to onError but rethrows anything else (invariant defects are plain
    // objects) out of fetch; the outermost middleware contains those.
    app.onError((cause) => unavailable(cause.message, "exception"));
    app.use("*", async (_c, next) => {
        const contained = await containBoundary({
            run: async () => {
                await next();
                return null;
            },
            onUnhandled: (detail, kind) => unavailable(detail, kind),
        });
        return contained ?? undefined;
    });
    app.use("*", async (_c, next) => {
        if (deps.isSuperseded()) return refusalResponse({ code: "SERVICE_UNAVAILABLE" });
        return await next();
    });

    mountAuth(app, routes);
    mountEnrollments(app, routes);
    mountRuntime(app, routes);
    mountDelivery(app, routes);
    app.notFound(() => refusalResponse({ code: "NOT_FOUND" }));
    return app;
}
