import { invariant } from "@lucent/core/contain";

// A tiny MaxMind DB (the format DB-IP Lite ships in), written here so tests need neither the real
// file nor a binary fixture: an IPv4 tree with 24-bit records, its data section and metadata,
// after the MaxMind DB File Format Specification 2.0. Deterministic: the same networks give the
// same bytes.

type Value = string | number | readonly Value[] | { readonly [key: string]: Value };

const TYPE = { string: 2, uint16: 5, uint32: 6, map: 7, uint64: 9, array: 11 } as const;

function control(type: number, size: number): number[] {
    const sized =
        size < 29
            ? [size]
            : size < 285
              ? [29, size - 29]
              : [30, (size - 285) >> 8, (size - 285) & 0xff];
    const [low = 0, ...extra] = sized;
    return type <= 7 ? [(type << 5) | low, ...extra] : [low, type - 7, ...extra];
}

function uint(type: number, value: number): number[] {
    const bytes: number[] = [];
    for (let rest = value; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest % 256);
    return [...control(type, bytes.length), ...bytes];
}

function encode(value: Value): number[] {
    if (typeof value === "string") {
        const bytes = [...new TextEncoder().encode(value)];
        return [...control(TYPE.string, bytes.length), ...bytes];
    }
    if (typeof value === "number") return uint(TYPE.uint32, value);
    if (Array.isArray(value)) {
        return [...control(TYPE.array, value.length), ...value.flatMap(encode)];
    }
    const entries = Object.entries(value);
    return [
        ...control(TYPE.map, entries.length),
        ...entries.flatMap(([key, item]) => [...encode(key), ...encode(item)]),
    ];
}

type Ref = { readonly node: number } | { readonly data: number } | null;
type Node = { left: Ref; right: Ref };

export type Network = { readonly cidr: string; readonly country: string };

function bitsOf(address: string): number[] {
    const octets = address.split(".").map(Number);
    invariant(octets.length === 4, `${address} is an IPv4 address`);
    return octets.flatMap((octet) => [7, 6, 5, 4, 3, 2, 1, 0].map((shift) => (octet >> shift) & 1));
}

// Networks must not overlap. Each maps its addresses to `{ country: { iso_code } }`, as DB-IP's
// country file does.
export function countryDatabase(networks: readonly Network[]): Uint8Array {
    const nodes: Node[] = [{ left: null, right: null }];
    const data: number[] = [];
    for (const network of networks) {
        const [address = "", length = ""] = network.cidr.split("/");
        const prefix = Number(length);
        const offset = data.length;
        data.push(...encode({ country: { iso_code: network.country } }));
        const bits = bitsOf(address).slice(0, prefix);
        let at = 0;
        bits.forEach((bit, depth) => {
            const node = nodes[at];
            invariant(node !== undefined, "the walk stays in the tree");
            const side = bit === 1 ? "right" : "left";
            if (depth === bits.length - 1) {
                node[side] = { data: offset };
                return;
            }
            const next = node[side];
            if (next !== null && "node" in next) {
                at = next.node;
                return;
            }
            nodes.push({ left: null, right: null });
            at = nodes.length - 1;
            node[side] = { node: at };
        });
    }
    const count = nodes.length;
    const record = (ref: Ref): number =>
        ref === null ? count : "node" in ref ? ref.node : count + 16 + ref.data;
    const tree = nodes.flatMap((node) =>
        [record(node.left), record(node.right)].flatMap((value) => [
            (value >> 16) & 0xff,
            (value >> 8) & 0xff,
            value & 0xff,
        ]),
    );
    const metadata = [
        ...control(TYPE.map, 9),
        ...encode("node_count"),
        ...uint(TYPE.uint32, count),
        ...encode("record_size"),
        ...uint(TYPE.uint16, 24),
        ...encode("ip_version"),
        ...uint(TYPE.uint16, 4),
        ...encode("database_type"),
        ...encode("DBIP-Country-Lite"),
        ...encode("languages"),
        ...encode(["en"]),
        ...encode("binary_format_major_version"),
        ...uint(TYPE.uint16, 2),
        ...encode("binary_format_minor_version"),
        ...uint(TYPE.uint16, 0),
        ...encode("build_epoch"),
        ...uint(TYPE.uint64, 1_700_000_000),
        ...encode("description"),
        ...encode({ en: "test countries" }),
    ];
    const marker = [0xab, 0xcd, 0xef, ...new TextEncoder().encode("MaxMind.com")];
    return Uint8Array.from([
        ...tree,
        ...new Array<number>(16).fill(0),
        ...data,
        ...marker,
        ...metadata,
    ]);
}
