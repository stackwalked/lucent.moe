import type { EpochMs } from "@lucent/core/scalars";
import type { ReactNode } from "react";
import { Time } from "../Time/Time.tsx";
import styles from "./Messages.module.css";

export type Message = {
    readonly key: string;
    readonly author: ReactNode;
    readonly at: EpochMs;
    readonly body: string;
    // Beside the author and time: what the message is about, a report button.
    readonly aside?: ReactNode;
};

// A conversation, oldest or newest first as given: each message its author, when, and the text
// as written, line breaks kept.
export function Messages({
    label,
    messages,
}: {
    readonly label: string;
    readonly messages: readonly Message[];
}) {
    return (
        <ol className={styles.list} aria-label={label}>
            {messages.map((message) => (
                <li key={message.key} className={styles.message}>
                    <div className={styles.head}>
                        <span className={styles.author}>{message.author}</span>
                        <Time at={message.at} format="relative" />
                        {message.aside === undefined ? null : (
                            <span className={styles.aside}>{message.aside}</span>
                        )}
                    </div>
                    <p className={styles.body}>{message.body}</p>
                </li>
            ))}
        </ol>
    );
}
