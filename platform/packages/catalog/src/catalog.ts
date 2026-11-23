import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describeUnknownError, trySync } from "@lucent/core/contain";
import { err, ok, type Result } from "@lucent/core/result";
import { ChannelId, ProductId } from "@lucent/core/scalars";
import { z } from "zod";
import { type ProductDefinition, ProductState } from "./product.ts";

const DEFAULT_PRODUCTS_DIR = join(import.meta.dir, "../../../../products");

const ProductFile = z.strictObject({
    id: ProductId,
    name: z.string().min(1).max(64),
    kind: z.enum(["module", "standalone"]),
    state: ProductState,
    channels: z.array(ChannelId).min(1).max(16),
    defaults: z.strictObject({
        concurrent_slots: z.number().int().min(1).max(16),
    }),
});

export type ProductCatalog = ReadonlyMap<ProductId, ProductDefinition>;

export type CatalogError =
    | { readonly code: "CATALOG_READ_FAILED"; readonly detail: string }
    | { readonly code: "CATALOG_INVALID"; readonly file: string; readonly detail: string };

export function loadProductCatalog(
    dir = DEFAULT_PRODUCTS_DIR,
): Result<ProductCatalog, CatalogError> {
    const filesRes = trySync(
        () =>
            readdirSync(dir)
                .filter((file) => file.endsWith(".toml"))
                .sort(),
        (cause) => ({
            code: "CATALOG_READ_FAILED" as const,
            detail: describeUnknownError(cause),
        }),
    );
    if (!filesRes.ok) return filesRes;

    const map = new Map<ProductId, ProductDefinition>();
    for (const file of filesRes.value) {
        const parsedToml = trySync(
            () => Bun.TOML.parse(readFileSync(join(dir, file), "utf8")),
            (cause) => ({
                code: "CATALOG_INVALID" as const,
                file,
                detail: describeUnknownError(cause),
            }),
        );
        if (!parsedToml.ok) return parsedToml;

        const checked = ProductFile.safeParse(parsedToml.value);
        if (!checked.success) {
            return err({
                code: "CATALOG_INVALID",
                file,
                detail: checked.error.issues[0]?.message ?? "invalid product schema",
            });
        }

        const expectedFile = `${checked.data.id}.toml`;
        if (file !== expectedFile) {
            return err({
                code: "CATALOG_INVALID",
                file,
                detail: `filename must match id (${expectedFile})`,
            });
        }

        const uniqueChannels = new Set(checked.data.channels);
        if (uniqueChannels.size !== checked.data.channels.length) {
            return err({
                code: "CATALOG_INVALID",
                file,
                detail: "duplicate channel in product definition",
            });
        }

        map.set(checked.data.id, {
            id: checked.data.id,
            name: checked.data.name,
            kind: checked.data.kind,
            state: checked.data.state,
            channels: checked.data.channels,
            concurrentSlots: checked.data.defaults.concurrent_slots,
        });
    }

    return ok(map);
}
