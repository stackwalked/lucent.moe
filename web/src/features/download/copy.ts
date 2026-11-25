export const DOWNLOAD_COPY = {
    title: "download",
    loader: "loader",
    none: "no products",
    unavailable: "loader not released yet",
    download: "download the loader",
    warnings: "what windows will say",
    unsigned: "the loader isn't code-signed, so windows can't tell who made it.",
    smartScreen: "smartscreen may block it: choose more info, then run anyway.",
    antivirus:
        "antivirus may flag or remove it, since it loads code into a game. allow it there to run it.",
    onlyHere: "download it only from lucent.moe. a copy from anywhere else isn't ours.",
} as const;
