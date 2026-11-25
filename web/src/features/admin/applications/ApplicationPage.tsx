import { getRouteApi, Link } from "@tanstack/react-router";
import { Page } from "../../../ui/Page/Page.tsx";
import { Pairs } from "../../../ui/Pairs/Pairs.tsx";
import { Section } from "../../../ui/Section/Section.tsx";
import { Stack } from "../../../ui/Stack/Stack.tsx";
import { Status } from "../../../ui/Status/Status.tsx";
import { Time } from "../../../ui/Time/Time.tsx";
import { Who } from "../../../ui/Who/Who.tsx";
import { RefusalNote } from "../../auth/RefusalNote.tsx";
import { AccountAction } from "../accounts/AccountAction.tsx";
import { ADMIN_COPY } from "../copy.ts";
import styles from "./ApplicationPage.module.css";
import { APPLICATIONS_COPY } from "./copy.ts";
import { approveApplication, declineApplication } from "./server.ts";

const route = getRouteApi("/_admin/admin/applications/$applicationId");

type Read = Extract<ReturnType<typeof route.useLoaderData>, { ok: true }>["value"];

// One application. Everything the applicant typed is shown as text, never as markup; the member
// they named and their Discord handle are what they claim, nothing checked.
export function ApplicationPage() {
    const read = route.useLoaderData();
    const trail = <Link to="/admin/applications">{APPLICATIONS_COPY.title}</Link>;
    if (!read.ok) {
        return (
            <Page title={APPLICATIONS_COPY.title} width="narrow" trail={trail}>
                <RefusalNote refused={read.refused} />
            </Page>
        );
    }
    const application = read.value;
    return (
        <Page title={application.email} width="narrow" trail={trail}>
            <Section caption={APPLICATIONS_COPY.title}>
                <Pairs
                    items={[
                        {
                            label: APPLICATIONS_COPY.state,
                            value: (
                                <Status tone={application.state === "pending" ? "pink" : "neutral"}>
                                    {APPLICATIONS_COPY.states[application.state]}
                                </Status>
                            ),
                        },
                        { label: APPLICATIONS_COPY.email, value: application.email },
                        {
                            label: APPLICATIONS_COPY.products,
                            value: application.products.join(", "),
                        },
                        {
                            label: APPLICATIONS_COPY.applied,
                            value: <Time at={application.createdAt} />,
                        },
                        {
                            label: APPLICATIONS_COPY.discord,
                            value: application.discord ?? APPLICATIONS_COPY.none,
                        },
                        {
                            label: APPLICATIONS_COPY.knownBy,
                            value: <KnownBy application={application} />,
                        },
                        ...decision(application),
                    ]}
                />
            </Section>
            <Section caption={APPLICATIONS_COPY.about}>
                <p className={styles.about}>{application.about}</p>
            </Section>
            {application.state === "pending" ? <Decide application={application} /> : null}
        </Page>
    );
}

function KnownBy({ application }: { readonly application: Read }) {
    if (application.knownBy === null) return APPLICATIONS_COPY.none;
    return (
        <Stack gap={1}>
            <span>{application.knownBy}</span>
            {application.knownByMember === null ? (
                <span>{APPLICATIONS_COPY.noMatch}</span>
            ) : (
                <span>
                    {APPLICATIONS_COPY.knownByMember}{" "}
                    <Who
                        accountId={application.knownByMember.accountId}
                        username={application.knownByMember.username}
                        pending={ADMIN_COPY.pending}
                    />
                </span>
            )}
        </Stack>
    );
}

function decision(application: Read) {
    if (application.decidedAt === null) return [];
    return [
        { label: APPLICATIONS_COPY.decided, value: <Time at={application.decidedAt} /> },
        {
            label: APPLICATIONS_COPY.by,
            value: (
                <Who
                    accountId={application.decidedBy?.id ?? null}
                    username={application.decidedBy?.username ?? null}
                    pending={ADMIN_COPY.pending}
                />
            ),
        },
        ...(application.accountId === null
            ? []
            : [
                  {
                      label: APPLICATIONS_COPY.account,
                      value: (
                          <Who
                              accountId={application.accountId}
                              username={null}
                              pending={application.accountId}
                          />
                      ),
                  },
              ]),
    ];
}

function Decide({ application }: { readonly application: Read }) {
    const id = application.applicationId;
    return (
        <Section caption={APPLICATIONS_COPY.decide}>
            {application.emailHasAccount ? <p>{APPLICATIONS_COPY.hasAccount}</p> : null}
            {application.returningAccountId == null ? null : (
                <p>
                    {APPLICATIONS_COPY.returningBody}{" "}
                    <Link
                        to="/admin/accounts/$accountId"
                        params={{ accountId: application.returningAccountId }}
                    >
                        {APPLICATIONS_COPY.returningLink}
                    </Link>
                </p>
            )}
            <Stack direction="row" gap={2}>
                {application.emailHasAccount ? null : (
                    <AccountAction
                        action="applications:review"
                        label={APPLICATIONS_COPY.approve}
                        title={APPLICATIONS_COPY.approveTitle(application.email)}
                        tone="pink"
                        fields={<p>{APPLICATIONS_COPY.approveBody}</p>}
                        run={() => approveApplication({ data: { applicationId: id } })}
                        shown={() => <p>{APPLICATIONS_COPY.mailed}</p>}
                    />
                )}
                <AccountAction
                    action="applications:review"
                    label={APPLICATIONS_COPY.decline}
                    title={APPLICATIONS_COPY.declineTitle(application.email)}
                    fields={<p>{APPLICATIONS_COPY.declineBody}</p>}
                    run={() => declineApplication({ data: { applicationId: id } })}
                />
            </Stack>
        </Section>
    );
}
