// Neither component of the invitation belongs in a request URL or a return-to cookie.
export function consumeShareFragment(url: URL, replace: (path: string) => void) {
    if (!url.hash) return null;
    // Clear malformed invitations too, and do not copy a query into the clean address.
    replace(url.pathname);
    const parts = /^#([a-z0-9][a-z0-9-]{1,31})\/([A-Za-z0-9_-]{43})$/.exec(url.hash);
    const productId = parts?.[1];
    const token = parts?.[2];
    return productId === undefined || token === undefined ? null : { productId, token };
}
