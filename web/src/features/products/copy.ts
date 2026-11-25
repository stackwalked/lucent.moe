export const PRODUCTS_COPY = {
    lifecycle: {
        announced: "coming soon",
        seed: "early access",
        live: "live",
        retired: "retired",
    },
    title: "products",
    none: "no products",
    noneListed: "no products",
    product: "product",
    channels: "channels",
    channel: "channel",
    features: "features",
    allFeatures: "all",
    state: "state",
    ready: "ready",
    since: "since",
    notYetSupported: "not yet supported",
    download: "download the loader",
    shouts: "shouts",
} as const;

export const PRODUCT_DESCRIPTIONS: Readonly<Record<string, string>> = {
    cs2: "for counter-strike 2",
    "lucent-loader": "starts your products",
};
