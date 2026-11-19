// The headers every response carries. Pages get a CSP naming their nonce; everything else gets
// one that allows nothing, since it isn't meant to run.

export const REPORT_PATH = "/_report";

function pageCsp(nonce: string): string {
    return [
        "default-src 'none'",
        `script-src 'nonce-${nonce}' 'strict-dynamic'`,
        "style-src 'self'",
        "img-src 'self' data:",
        "font-src 'self'",
        "connect-src 'self'",
        "manifest-src 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
        "base-uri 'none'",
        "report-to csp",
    ].join("; ");
}

const INERT_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'";

// Trusted Types starts report-only: violations reach /_report while nothing breaks, and the
// policy moves into the enforced CSP once the reports are clean.
const TRUSTED_TYPES_REPORT_ONLY = "require-trusted-types-for 'script'; report-to csp";

// Everything a page could ask for is off, except passkeys.
const PERMISSIONS = [
    "accelerometer=()",
    "autoplay=()",
    "camera=()",
    "display-capture=()",
    "geolocation=()",
    "gyroscope=()",
    "magnetometer=()",
    "microphone=()",
    "payment=()",
    "usb=()",
    "publickey-credentials-create=(self)",
    "publickey-credentials-get=(self)",
].join(", ");

export function securityHeaders(nonce: string | null): Readonly<Record<string, string>> {
    return {
        "content-security-policy": nonce === null ? INERT_CSP : pageCsp(nonce),
        "content-security-policy-report-only": TRUSTED_TYPES_REPORT_ONLY,
        "reporting-endpoints": `csp="${REPORT_PATH}"`,
        "referrer-policy": "no-referrer",
        "strict-transport-security": "max-age=63072000; includeSubDomains; preload",
        "cross-origin-opener-policy": "same-origin",
        "cross-origin-resource-policy": "same-origin",
        "x-content-type-options": "nosniff",
        "permissions-policy": PERMISSIONS,
    };
}

// Start's responses may be streamed and immutable; the body passes through untouched.
export function withHeaders(res: Response, headers: Readonly<Record<string, string>>): Response {
    const merged = new Headers(res.headers);
    for (const [name, value] of Object.entries(headers)) merged.set(name, value);
    return new Response(res.body, {
        status: res.status,
        statusText: res.statusText,
        headers: merged,
    });
}
