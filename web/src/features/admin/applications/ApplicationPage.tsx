import { getRouteApi, Link } from "@tanstack/react-router";
import { Pairs } from "../../../ui/Pairs/Pairs.tsx";
import { Section } from "../../../ui/Section/Section.tsx";
import { Stack } from "../../../ui/Stack/Stack.tsx";
import { Time } from "../../../ui/Time/Time.tsx";
import { Who } from "../../../ui/Who/Who.tsx";
import { RefusalNote } from "../../auth/RefusalNote.tsx";
import { AccountAction } from "../accounts/AccountAction.tsx";
import { ADMIN_COPY } from "../copy.ts";
import { DetailPage } from "../DetailPage.tsx";
import styles from "./ApplicationPage.module.css";
import { APPLICATIONS_COPY } from "./copy.ts";
import { approveApplication, declineApplication } from "./server.ts";

const route = getRouteApi("/_admin/admin/queue/applications/$applicationId");

type Read = Extract<ReturnType<typeof route.useLoaderData>, { ok: true }>["value"];

// One application. Everything the applicant typed is shown as text, never as markup; the member
// they vouch by and their Discord handle are what they claim, nothing checked.
export function ApplicationPage() {
    const read = route.useLoaderData();
    const { from } = route.useSearch();
    const back = { to: "/admin/queue/applications", label: APPLICATIONS_COPY.title } as const;
    if (!read.ok) {
        return (
            <DetailPage
                from={from}
                back={back}
                title={APPLICATIONS_COPY.title}
                main={<RefusalNote refused={read.refused} />}
                aside={null}
            />
        );
    }
    const application = read.value;
    return (
        <DetailPage
            from={from}
            back={back}
            title={application.email}
            main={
                <>
                    <Answer caption={APPLICATIONS_COPY.experience} text={application.experience} />
                    <Answer caption={APPLICATIONS_COPY.games} text={application.games} />
                    <Answer caption={APPLICATIONS_COPY.additional} text={application.additional} />
                </>
            }
            aside={
                <>
                    <Section caption={APPLICATIONS_COPY.title}>
                        <Pairs
                            align="end"
                            items={[
                                {
                                    label: APPLICATIONS_COPY.state,
                                    value: APPLICATIONS_COPY.states[application.state],
                                    tone: application.state === "pending" ? "wait" : "dim",
                                },
                                { label: APPLICATIONS_COPY.email, value: application.email },
                                {
                                    label: APPLICATIONS_COPY.applied,
                                    value: <Time at={application.createdAt} />,
                                },
                                { label: APPLICATIONS_COPY.discord, value: application.discord },
                                {
                                    label: APPLICATIONS_COPY.knownBy,
                                    value: <KnownBy application={application} />,
                                },
                                ...decision(application),
                            ]}
                        />
                    </Section>
                    {application.state === "pending" ? <Decide application={application} /> : null}
                </>
            }
        />
    );
}
// A long answer as the applicant wrote it. One they were never asked (an application from before
// the form) has nothing to show, so it has no section.
function Answer({ caption, text }: { readonly caption: string; readonly text: string | null }) {
    if (text === null || text === "") return null;
    return (
        <Section caption={caption}>
            <p className={styles.answer}>{text}</p>
        </Section>
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
                        to="/admin/members/accounts/$accountId"
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
                    tone="danger"
                    title={APPLICATIONS_COPY.declineTitle(application.email)}
                    fields={<p>{APPLICATIONS_COPY.declineBody}</p>}
                    run={() => declineApplication({ data: { applicationId: id } })}
                />
            </Stack>
        </Section>
    );
}
