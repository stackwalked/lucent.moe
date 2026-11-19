import { invariant } from "@lucent/core/contain";
import {
    createContext,
    type ReactNode,
    useCallback,
    useContext,
    useEffect,
    useRef,
    useState,
} from "react";
import styles from "./Toast.module.css";

const LIFETIME_MS = 4000;

type Push = (message: string) => void;
type Entry = { readonly id: number; readonly message: string };

const ToastContext = createContext<Push | null>(null);

// Says "Session ended" or "Setup link copied" in a corner for a few seconds: only for a result
// that happened somewhere else. Anything the reader is looking at answers in place. The region
// is always in the page, so a screen reader hears each message when it arrives.
export function ToastProvider({ children }: { readonly children: ReactNode }) {
    const [entries, setEntries] = useState<readonly Entry[]>([]);
    const last = useRef(0);

    const push = useCallback((message: string) => {
        last.current += 1;
        const id = last.current;
        setEntries((current) => [...current, { id, message }]);
    }, []);

    const drop = useCallback((id: number) => {
        setEntries((current) => current.filter((entry) => entry.id !== id));
    }, []);

    return (
        <ToastContext value={push}>
            {children}
            <div className={styles.region} role="status" aria-live="polite">
                {entries.map((entry) => (
                    <Message key={entry.id} id={entry.id} message={entry.message} onDone={drop} />
                ))}
            </div>
        </ToastContext>
    );
}

export function useToast(): Push {
    const push = useContext(ToastContext);
    invariant(push !== null, "useToast needs a ToastProvider above it");
    return push;
}

function Message({
    id,
    message,
    onDone,
}: {
    readonly id: number;
    readonly message: string;
    readonly onDone: (id: number) => void;
}) {
    useEffect(() => {
        const timer = setTimeout(() => onDone(id), LIFETIME_MS);
        return () => clearTimeout(timer);
    }, [id, onDone]);
    return <p className={styles.toast}>{message}</p>;
}
