import { Link } from "@tanstack/react-router";
import styles from "./Who.module.css";

// An account as staff see it named: its username, linked to its admin page. An account still
// being set up has no username yet and shows `pending`; an actor that isn't an account (ops)
// shows its name, unlinked.
export function Who({
    accountId,
    username,
    pending,
}: {
    readonly accountId: string | null;
    readonly username: string | null;
    readonly pending: string;
}) {
    if (accountId === null || !accountId.startsWith("acc_")) {
        return <span className={styles.who}>{username ?? accountId ?? pending}</span>;
    }
    return (
        <Link
            to="/admin/accounts/$accountId"
            params={{ accountId }}
            className={styles.link}
            // `pending` is a mark, not a name; the id is what tells two such accounts apart.
            {...(username === null ? { "aria-label": accountId } : {})}
        >
            {username ?? pending}
        </Link>
    );
}
