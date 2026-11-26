import { systemClock } from "@lucent/core/clock";
import { createIsomorphicFn } from "@tanstack/react-start";
import { getCookie } from "@tanstack/react-start/server";

// The product a browser last looked at, so /products can send it back there: a plain
// display-preference cookie like the theme's, written when a product page is viewed.
export const LAST_PRODUCT_COOKIE = "lucent-product";
const YEAR_MS = 365 * 24 * 60 * 60 * 1_000;

export const lastProduct = createIsomorphicFn()
    .server((): string | undefined => {
        const value = getCookie(LAST_PRODUCT_COOKIE);
        return value === "" ? undefined : value;
    })
    .client((): string | undefined => undefined);

export async function noteLastProduct(productId: string): Promise<void> {
    await cookieStore.set({
        name: LAST_PRODUCT_COOKIE,
        value: productId,
        path: "/",
        expires: systemClock.now() + YEAR_MS,
        sameSite: "lax",
    });
}
