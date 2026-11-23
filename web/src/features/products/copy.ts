export const PRODUCTS_COPY = {
    lifecycle: {
        announced: "coming soon",
        seed: "early access",
        live: "live",
        retired: "retired",
    },
    title: "products",
    none: "you have no products yet.",
    noneListed: "no products are listed.",
    product: "product",
    channels: "channels",
    channel: "channel",
    features: "features",
    allFeatures: "all",
    state: "state",
    ready: "ready",
    since: "since",
    notYetSupported: "not yet supported",
    notYetSupportedHint:
        "nothing runs on this channel yet. after a game update this lasts until support for the new build is out.",
    loader: "the loader starts it.",
    download: "download the loader",
    shouts: "shouts",
} as const;

export const PRODUCT_DESCRIPTIONS: Readonly<Record<string, string>> = {
    cs2: "for counter-strike 2.",
    "lucent-loader": "starts the products you have access to.",
};
