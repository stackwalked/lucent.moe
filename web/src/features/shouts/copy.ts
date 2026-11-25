export const SHOUTS_COPY = {
    none: "no shouts",
    table: "shouts",
    body: "shout",
    you: "you",
    post: "post",
    productField: "product",
    noProduct: "none",
    allShouts: "all shouts",
    forProduct: (product: string) => `shouts about ${product}`,
} as const;
