import { createWriter, type FormatError, malformed, openReader } from "@lucent/bundle/wire";
import { invariant } from "@lucent/core/contain";
import type { Result } from "@lucent/core/result";
import { finish, ID_SIZE, readContext } from "./codec.ts";
import { decompressLz4Block } from "./lz4.ts";

// The module container (contracts/container/v1), as native/libs/wire/src/container.cpp reads and
// writes it. The server decodes containers only to check one at publish time (its release id and
// boot_info version against its seal's); the loader maps them.
//
// Version 1:
//   packed: context "lucent container v1" (32), u32 body size, u32 block size, the body as one
//     LZ4 block of exactly block size bytes.
//   body: release id (16), u32 image size, u32 entry rva, u32 boot rva, u32 boot_info version,
//     u32 pdata rva, u32 pdata size, import key (32), u32 section count, u32 relocation count,
//     u32 import count;
//     per section: u32 rva, u32 mapped size, u32 stored size, u8 access; per relocation: u32 slot
//     rva; per import: u64 module hash, u64 function hash, u32 slot rva; then every section's
//     stored bytes, in section order.

const VERSION = 1;
export const CONTAINER_PAGE_SIZE = 0x1000;
export const MAX_CONTAINER_IMAGE_SIZE = 256 << 20;
const MAX_BODY_SIZE = 512 << 20;
export const IMPORT_KEY_SIZE = 32;
const SECTION_ENTRY_SIZE = 13;
const IMPORT_ENTRY_SIZE = 20;
const RUNTIME_FUNCTION_SIZE = 12;
const SLOT_SIZE = 8;

export type SectionAccess = "read" | "read_write" | "read_execute";

const ACCESS_CODES: Readonly<Record<SectionAccess, number>> = {
    read: 1,
    read_write: 2,
    read_execute: 3,
};

function accessOf(code: number): SectionAccess | null {
    switch (code) {
        case 1:
            return "read";
        case 2:
            return "read_write";
        case 3:
            return "read_execute";
        default:
            return null;
    }
}

export type ContainerSection = {
    readonly rva: number;
    readonly mappedSize: number;
    readonly access: SectionAccess;
    readonly data: Uint8Array;
};

export type ContainerImport = {
    readonly moduleHash: bigint;
    readonly functionHash: bigint;
    readonly slotRva: number;
};

export type Container = {
    readonly release: Uint8Array;
    readonly imageSize: number;
    readonly entryRva: number;
    readonly bootRva: number;
    readonly bootInfoVersion: number;
    readonly pdataRva: number;
    readonly pdataSize: number;
    readonly importsKey: Uint8Array;
    readonly sections: readonly ContainerSection[];
    readonly relocations: readonly number[];
    readonly imports: readonly ContainerImport[];
};

function isPageAligned(value: number): boolean {
    return value % CONTAINER_PAGE_SIZE === 0;
}

function isCanonicalData(section: ContainerSection): boolean {
    const stored = section.data.byteLength;
    if (stored % CONTAINER_PAGE_SIZE !== 0 || stored > section.mappedSize) return false;
    if (stored === 0) return true;
    return section.data.subarray(stored - CONTAINER_PAGE_SIZE).some((byte) => byte !== 0);
}

function isCanonicalLayout(container: Container): boolean {
    let end = 0;
    for (const section of container.sections) {
        const sectionEnd = section.rva + section.mappedSize;
        if (
            !isPageAligned(section.rva) ||
            !isPageAligned(section.mappedSize) ||
            section.mappedSize === 0 ||
            section.rva < end ||
            sectionEnd > container.imageSize ||
            !isCanonicalData(section)
        ) {
            return false;
        }
        end = sectionEnd;
    }
    return true;
}

function sectionHolding(container: Container, rva: number, size: number) {
    return container.sections.find(
        (section) => rva >= section.rva && rva + size <= section.rva + section.mappedSize,
    );
}

function areCanonicalSlots(container: Container, slots: readonly number[]): boolean {
    return slots.every((slot, index) => {
        const previous = slots[index - 1];
        return (
            (previous === undefined || slot >= previous + SLOT_SIZE) &&
            sectionHolding(container, slot, SLOT_SIZE) !== undefined
        );
    });
}

// 0, or inside an executable section.
function isCanonicalCodeRva(container: Container, rva: number): boolean {
    if (rva === 0) return true;
    return sectionHolding(container, rva, 1)?.access === "read_execute";
}

function isCanonicalPdata(container: Container): boolean {
    const { pdataRva, pdataSize } = container;
    if (pdataRva === 0 && pdataSize === 0) return true;
    if (pdataSize === 0 || pdataSize % RUNTIME_FUNCTION_SIZE !== 0) return false;
    return sectionHolding(container, pdataRva, pdataSize)?.access === "read";
}

export function isCanonicalContainer(container: Container): boolean {
    return (
        container.release.byteLength === ID_SIZE &&
        container.importsKey.byteLength === IMPORT_KEY_SIZE &&
        container.imageSize !== 0 &&
        isPageAligned(container.imageSize) &&
        container.imageSize <= MAX_CONTAINER_IMAGE_SIZE &&
        isCanonicalLayout(container) &&
        isCanonicalCodeRva(container, container.entryRva) &&
        isCanonicalCodeRva(container, container.bootRva) &&
        isCanonicalPdata(container) &&
        areCanonicalSlots(container, container.relocations) &&
        areCanonicalSlots(
            container,
            container.imports.map((entry) => entry.slotRva),
        )
    );
}

export function toContainerBodyBytes(container: Container): Uint8Array<ArrayBuffer> {
    invariant(isCanonicalContainer(container), "container isn't canonical");
    const out = createWriter();
    out.bytes(container.release);
    out.u32(container.imageSize);
    out.u32(container.entryRva);
    out.u32(container.bootRva);
    out.u32(container.bootInfoVersion);
    out.u32(container.pdataRva);
    out.u32(container.pdataSize);
    out.bytes(container.importsKey);
    out.u32(container.sections.length);
    out.u32(container.relocations.length);
    out.u32(container.imports.length);
    for (const section of container.sections) {
        out.u32(section.rva);
        out.u32(section.mappedSize);
        out.u32(section.data.byteLength);
        out.u8(ACCESS_CODES[section.access]);
    }
    for (const slot of container.relocations) out.u32(slot);
    for (const entry of container.imports) {
        out.u64(entry.moduleHash);
        out.u64(entry.functionHash);
        out.u32(entry.slotRva);
    }
    for (const section of container.sections) out.bytes(section.data);
    return out.finish();
}

type SectionEntry = { rva: number; mappedSize: number; storedSize: number; access: number };

// Canonical or nothing, as native/libs/wire's decode_container_body.
export function parseContainerBody(bytes: Uint8Array): Result<Container, FormatError> {
    const input = openReader(bytes);
    if (input.remaining() < ID_SIZE + 6 * 4 + IMPORT_KEY_SIZE + 3 * 4) return malformed();
    const release = input.bytes(ID_SIZE);
    const imageSize = input.u32();
    const entryRva = input.u32();
    const bootRva = input.u32();
    const bootInfoVersion = input.u32();
    const pdataRva = input.u32();
    const pdataSize = input.u32();
    const importsKey = input.bytes(IMPORT_KEY_SIZE);
    const sectionCount = input.u32();
    const relocationCount = input.u32();
    const importCount = input.u32();
    if (sectionCount * SECTION_ENTRY_SIZE > input.remaining()) return malformed();
    const entries: SectionEntry[] = [];
    for (let index = 0; index < sectionCount; index += 1) {
        entries.push({
            rva: input.u32(),
            mappedSize: input.u32(),
            storedSize: input.u32(),
            access: input.u8(),
        });
    }
    if (relocationCount * 4 > input.remaining()) return malformed();
    const relocations: number[] = [];
    for (let index = 0; index < relocationCount; index += 1) relocations.push(input.u32());
    if (importCount * IMPORT_ENTRY_SIZE > input.remaining()) return malformed();
    const imports: ContainerImport[] = [];
    for (let index = 0; index < importCount; index += 1) {
        imports.push({ moduleHash: input.u64(), functionHash: input.u64(), slotRva: input.u32() });
    }
    const sections: ContainerSection[] = [];
    for (const entry of entries) {
        const access = accessOf(entry.access);
        if (access === null || entry.storedSize > input.remaining()) return malformed();
        sections.push({
            rva: entry.rva,
            mappedSize: entry.mappedSize,
            access,
            data: input.bytes(entry.storedSize),
        });
    }
    const container: Container = {
        release,
        imageSize,
        entryRva,
        bootRva,
        bootInfoVersion,
        pdataRva,
        pdataSize,
        importsKey,
        sections,
        relocations,
        imports,
    };
    if (!isCanonicalContainer(container)) return malformed();
    return finish(input, container);
}

// Decompresses and decodes, as native/libs/wire's unpack_container.
export function unpackContainer(packed: Uint8Array): Result<Container, FormatError> {
    const input = openReader(packed);
    const context = readContext(input, "container", VERSION);
    if (!context.ok) return context;
    if (input.remaining() < 8) return malformed();
    const bodySize = input.u32();
    const blockSize = input.u32();
    if (bodySize > MAX_BODY_SIZE || blockSize === 0 || blockSize !== input.remaining()) {
        return malformed();
    }
    const body = decompressLz4Block(input.bytes(blockSize), bodySize);
    if (body === null) return malformed();
    return parseContainerBody(body);
}
