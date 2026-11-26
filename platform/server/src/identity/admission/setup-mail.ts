import { ok, type Result } from "@lucent/core/result";
import type { BearerToken } from "@lucent/core/scalars";
import { type DbFailure, execute, sql, type Tx } from "../../base/db/pool.ts";
import { setupLinkMail } from "../../members/notify/copy.ts";
import { setupPath } from "../auth/setup.ts";
import { hashToken } from "../auth/tokens.ts";

// Staff hand over the link `accounts.create` shows them. An invite or an application has only the
// address to reach, which the mail also proves is the applicant's. The caller has checked that a
// provider drains the outbox (`mailEnabled`).
export async function queueSetupMail(
    tx: Tx,
    params: { readonly origin: string; readonly email: string; readonly setupToken: BearerToken },
): Promise<Result<void, DbFailure>> {
    const mail = setupLinkMail(`${params.origin}${setupPath(params.setupToken)}`);
    // Tied to its link (migration 0034): the queued text, bearer included, goes when the link is
    // used or replaced, and is never sent once the link has expired.
    const queued = await execute(
        tx,
        sql`insert into mail_outbox (kind, recipient, subject, body, setup_hash)
            values ('setup', ${params.email}, ${mail.subject}, ${mail.body},
                    ${await hashToken(params.setupToken)})`,
    );
    return queued.ok ? ok(undefined) : queued;
}
