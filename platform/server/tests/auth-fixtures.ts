import { expect } from "bun:test";
import {
    beginPasskeyRegistration,
    beginTotpEnrollment,
    confirmTotpEnrollment,
    finishPasskeyRegistration,
    setPassword,
} from "../src/auth/credentials.ts";
import type { AuthDeps } from "../src/auth/deps.ts";
import { mintSession } from "../src/auth/sessions.ts";
import { chooseUsername, redeemSetupLink } from "../src/auth/setup.ts";
import { totpCode, totpStepAt } from "../src/auth/totp.ts";
import { createAccount } from "../src/authority/writers.ts";
import { RegistrationResponse } from "../src/contract/webauthn.ts";
import { invariant } from "../src/core/contain.ts";
import type { SeededRng } from "../src/core/rng.ts";
import {
    type AccountId,
    type BearerToken,
    type ClientInfo,
    newOperationId,
} from "../src/core/scalars.ts";
import type { Db } from "../src/db/pool.ts";
import { withTx } from "../src/db/tx.ts";
import { dbNow, seedRoot, steppedUp } from "./authority-fixtures.ts";
import { createTestAuthenticator, type TestAuthenticator } from "./harness/authenticator.ts";

export const MEMBER_PASSWORD = "correct horse battery staple";

export type Member = {
    readonly accountId: AccountId;
    readonly username: string;
    readonly sessionToken: BearerToken;
    readonly passkey: TestAuthenticator | null;
    readonly totpSecret: Uint8Array | null;
};

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function fromBase32(text: string): Uint8Array {
    const out: number[] = [];
    let buffer = 0;
    let bits = 0;
    for (const ch of text) {
        buffer = (buffer << 5) | BASE32.indexOf(ch);
        bits += 5;
        if (bits >= 8) {
            out.push((buffer >>> (bits - 8)) & 0xff);
            bits -= 8;
        }
    }
    return Uint8Array.from(out);
}

// The code for the step `offset` steps from the database's now. Offsets stay within the one-step
// window either side, so crossing a step boundary mid-test still lands inside it.
export async function codeAt(db: Db, secret: Uint8Array, offset: -1 | 0 | 1): Promise<string> {
    return await totpCode(secret, totpStepAt(await dbNow(db)) + offset);
}

export async function newSetupLink(
    deps: AuthDeps,
    rng: SeededRng,
    email: string,
): Promise<{ readonly accountId: AccountId; readonly setupToken: BearerToken }> {
    const rootId = await seedRootOnce(deps.db, rng);
    const created = await createAccount({
        db: deps.db,
        rng,
        caller: await steppedUp(deps.db, rootId),
        operationId: newOperationId(rng),
        email,
    });
    invariant(created.ok && !created.value.replayed, `creating ${email} failed`);
    return { accountId: created.value.accountId, setupToken: created.value.setupToken };
}

const roots = new WeakMap<Db, Promise<AccountId>>();

export function seedRootOnce(db: Db, rng: SeededRng): Promise<AccountId> {
    let root = roots.get(db);
    if (root === undefined) {
        root = seedRoot(db, rng);
        roots.set(db, root);
    }
    return root;
}

export async function memberSession(
    deps: AuthDeps,
    accountId: AccountId,
    client: ClientInfo | null = null,
): Promise<BearerToken> {
    const minted = await withTx(deps.db, (tx, txNow) =>
        mintSession(tx, { rng: deps.rng, accountId, purpose: "member", txNow, client }),
    );
    invariant(minted.ok, "minting a member session failed");
    return minted.value.token;
}

export async function registerPasskey(
    deps: AuthDeps,
    sessionToken: BearerToken,
    authenticator: TestAuthenticator,
): Promise<void> {
    const begun = await beginPasskeyRegistration(deps, { sessionToken });
    invariant(begun.ok, `passkey registration didn't start: ${JSON.stringify(begun)}`);
    const finished = await finishPasskeyRegistration(deps, {
        sessionToken,
        flowToken: begun.value.flowToken,
        label: "test key",
        response: RegistrationResponse.parse(await authenticator.register(begun.value.options)),
    });
    expect(finished.ok).toBe(true);
}

// An account set up through its setup link with the given credentials, holding a member session
// minted directly (so no TOTP step is spent signing in).
export async function newMember(
    deps: AuthDeps,
    rng: SeededRng,
    params: { readonly username: string; readonly with: "passkey" | "password+totp" | "all" },
): Promise<Member> {
    const link = await newSetupLink(deps, rng, `${params.username}@lucent.test`);
    const setup = await redeemSetupLink(deps, { setupToken: link.setupToken });
    invariant(setup.ok, "redeeming the setup link failed");
    const setupSession = setup.value.sessionToken;
    const named = await chooseUsername(deps, {
        sessionToken: setupSession,
        username: params.username,
    });
    invariant(named.ok, `choosing ${params.username} failed`);

    let passkey: TestAuthenticator | null = null;
    if (params.with !== "password+totp") {
        passkey = await createTestAuthenticator({ rng });
        await registerPasskey(deps, setupSession, passkey);
    }
    let totpSecret: Uint8Array | null = null;
    if (params.with !== "passkey") {
        const set = await setPassword(deps, {
            sessionToken: setupSession,
            password: MEMBER_PASSWORD,
        });
        invariant(set.ok, "setting the password failed");
        const enrolled = await beginTotpEnrollment(deps, { sessionToken: setupSession });
        invariant(enrolled.ok, "TOTP enrollment didn't start");
        totpSecret = fromBase32(enrolled.value.secret);
        const confirmed = await confirmTotpEnrollment(deps, {
            sessionToken: setupSession,
            code: await codeAt(deps.db, totpSecret, 0),
        });
        invariant(confirmed.ok, `TOTP confirmation failed: ${JSON.stringify(confirmed)}`);
    }

    return {
        accountId: link.accountId,
        username: params.username,
        sessionToken: await memberSession(deps, link.accountId),
        passkey,
        totpSecret,
    };
}
