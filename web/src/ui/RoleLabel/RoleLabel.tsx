import styles from "./RoleLabel.module.css";

export type RoleColor = "pink" | "shu" | "ok" | "wait" | "violet" | "aqua";

// A role's name in its label colour, shown after a username. Colour only helps: the name is the
// content. --size-13 is the nearest type size to the mock's 12.5px.
export function RoleLabel({ name, color }: { readonly name: string; readonly color: RoleColor }) {
    return (
        <span className={styles.label} data-color={color}>
            {name}
        </span>
    );
}
