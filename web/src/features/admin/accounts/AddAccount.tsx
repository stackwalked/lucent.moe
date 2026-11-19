import { z } from "zod";
import { TextField } from "../../../ui/TextField/TextField.tsx";
import { AccountAction } from "./AccountAction.tsx";
import { ACCOUNTS_COPY } from "./copy.ts";
import { SetupLink } from "./SetupLink.tsx";
import { createAccount } from "./server.ts";

// The browser's own email check takes "a@b"; platform holds addresses to zod's, so this does too
// and a typo is said here rather than coming back as a failure.
const Email = z.email();

// One field, then the setup link, shown once. A replay of an add that already happened has no
// link to show.
export function AddAccount() {
    return (
        <AccountAction
            action="accounts:create"
            label={ACCOUNTS_COPY.add}
            submitLabel={ACCOUNTS_COPY.addSubmit}
            title={ACCOUNTS_COPY.addTitle}
            tone="pink"
            icon="plus"
            fields={
                <TextField
                    name="email"
                    label={ACCOUNTS_COPY.email}
                    type="email"
                    required
                    maxLength={254}
                    customCheck={(value) =>
                        value.trim() === "" || Email.safeParse(value.trim()).success
                            ? undefined
                            : ACCOUNTS_COPY.notEmail
                    }
                />
            }
            run={(form, operationId) =>
                createAccount({
                    data: { operationId, email: String(form.get("email") ?? "").trim() },
                })
            }
            shown={(added) =>
                added.setupToken === null ? (
                    <p>{ACCOUNTS_COPY.replayNoLink}</p>
                ) : (
                    <SetupLink token={added.setupToken} />
                )
            }
        />
    );
}
