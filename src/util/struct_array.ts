// Note: all "sizes" are measured in bytes

import assert from 'assert';

import type {Transferable} from '../types/transferable';

const viewTypes = {
    'Int8': Int8Array,
    'Uint8': Uint8Array,
    'Int16': Int16Array,
    'Uint16': Uint16Array,
    'Int32': Int32Array,
    'Uint32': Uint32Array,
    'Float32': Float32Array
};

export type ViewType = keyof typeof viewTypes;

/**
 * @private
 */
class Struct {
    // When reading the ArrayBuffer as an array of different data types, arrays have different length
    // depending on data type size. So to acess the same position,
    // we need to read different indexes depending on array data size.
    // _pos1 is the index reading an array with 1 byte data,
    // _pos2 is reading 2 byte data, and so forth.
    _pos1: number;
    _pos2: number;
    _pos4: number;
    _pos8: number;
    readonly _structArray: StructArray;

    // The following properties are defined on the prototype of sub classes.
    size: number;

    /**
     * @param {StructArray} structArray The StructArray the struct is stored in
     * @param {number} index The index of the struct in the StructArray.
     * @private
     */
    constructor(structArray: StructArray, index: number) {
        this._structArray = structArray;
        this._pos1 = index * this.size;
        this._pos2 = this._pos1 / 2;
        this._pos4 = this._pos1 / 4;
        this._pos8 = this._pos1 / 8;
    }
}

const DEFAULT_CAPACITY = 128;
const RESIZE_MULTIPLIER = 5;

export type StructArrayMember = {
    name: string;
    type: ViewType;
    components: number;
    offset: number;
};

export type StructArrayLayout = {
    members: Array<StructArrayMember>;
    size: number;
    alignment: number | null | undefined;
};

export interface IStructArrayLayout {
    _refreshViews: () => void;
    emplace: (...args: number[]) => number;
    emplaceBack: (...args: number[]) => number;
}

export type SerializedStructArray = {
    length: number;
    arrayBuffer: ArrayBuffer;
};

/**
 * `StructArray` provides an abstraction over `ArrayBuffer` and `TypedArray`
 * making it behave like an array of typed structs.
 *
 * Conceptually, a StructArray is comprised of elements, i.e., instances of its
 * associated struct type. Each particular struct type, together with an
 * alignment size, determines the memory layout of a StructArray whose elements
 * are of that type.  Thus, for each such layout that we need, we have
 * a corrseponding StructArrayLayout class, inheriting from StructArray and
 * implementing `emplaceBack()` and `_refreshViews()`.
 *
 * In some cases, where we need to access particular elements of a StructArray,
 * we implement a more specific subclass that inherits from one of the
 * StructArrayLayouts and adds a `get(i): T` accessor that returns a structured
 * object whose properties are proxies into the underlying memory space for the
 * i-th element.  This affords the convience of working with (seemingly) plain
 * Javascript objects without the overhead of serializing/deserializing them
 * into ArrayBuffers for efficient web worker transfer.
 *
 * @private
 */
class StructArray implements IStructArrayLayout {
    capacity: number;
    length: number;
    arrayBuffer: ArrayBuffer;
    int8: Int8Array;
    uint8: Uint8Array;
    int16: Int16Array;
    uint16: Uint16Array;
    int32: Int32Array;
    uint32: Uint32Array;
    float32: Float32Array;

    // The following properties are defined on the prototype.
    members: Array<StructArrayMember>;
    bytesPerElement: number;

    constructor() {
        this.capacity = -1;
        this.resize(0);
    }

    /**
     * Serialize a StructArray instance.  Serializes both the raw data and the
     * metadata needed to reconstruct the StructArray base class during
     * deserialization.
     * @private
     */
    static serialize(array: StructArray, transferables?: Set<Transferable>): SerializedStructArray {
        array._trim();

        if (transferables) {
            transferables.add(array.arrayBuffer);
        }

        return {
            length: array.length,
            arrayBuffer: array.arrayBuffer,
        };
    }

    static deserialize(input: SerializedStructArray): StructArray {
        const structArray: StructArray = Object.create(this.prototype);
        structArray.arrayBuffer = input.arrayBuffer;
        structArray.length = input.length;
        structArray.capacity = input.arrayBuffer.byteLength / structArray.bytesPerElement;
        structArray._refreshViews();
        return structArray;
    }

    /**
     * Resize the array to discard unused capacity.
     */
    _trim() {
        if (this.length !== this.capacity) {
            this.capacity = this.length;
            this.arrayBuffer = this.arrayBuffer.slice(0, this.length * this.bytesPerElement);
            this._refreshViews();
        }
    }

    /**
     * Resets the the length of the array to 0 without de-allocating capacity.
     */
    clear() {
        this.length = 0;
    }

    /**
     * Resize the array.
     * If `n` is greater than the current length then additional elements with undefined values are added.
     * If `n` is less than the current length then the array will be reduced to the first `n` elements.
     * @param {number} n The new size of the array.
     */
    resize(n: number) {
        this.reserve(n);
        this.length = n;
    }

    /**
     * Indicate a planned increase in size, so that any necessary allocation may
     * be done once, ahead of time.
     * @param {number} n The expected size of the array.
     */
    reserve(n: number) {
        if (n > this.capacity) {
            this.capacity = Math.max(n, Math.floor(this.capacity * RESIZE_MULTIPLIER), DEFAULT_CAPACITY);
            this.arrayBuffer = new ArrayBuffer(this.capacity * this.bytesPerElement);

            const oldUint8Array = this.uint8;
            this._refreshViews();
            if (oldUint8Array) this.uint8.set(oldUint8Array);
        }
    }

    /**
     * Create TypedArray views for the current ArrayBuffer.
     */
    _refreshViews(): void {
        throw new Error('StructArray#_refreshViews() must be implemented by each concrete StructArray layout');
    }

    emplace(..._: number[]): number {
        throw new Error('StructArray#emplace() must be implemented by each concrete StructArray layout');
    }

    emplaceBack(..._: number[]): number {
        throw new Error('StructArray#emplaceBack() must be implemented by each concrete StructArray layout');
    }

    destroy() {
        this.int8 = this.uint8 = this.int16 = this.uint16 = this.int32 = this.uint32 = this.float32 = null;
        this.arrayBuffer = null;
    }
}

/**
 * Given a list of member fields, create a full StructArrayLayout, in
 * particular calculating the correct byte offset for each field.  This data
 * is used at build time to generate StructArrayLayout_*#emplaceBack() and
 * other accessors, and at runtime for binding vertex buffer attributes.
 *
 * @private
 */
function createLayout(
    members: Array<{
        name: string;
        type: ViewType;
        readonly components?: number;
    }>,
    alignment: number = 1,
): StructArrayLayout {

    let offset = 0;
    let maxSize = 0;
    const layoutMembers = members.map((member) => {
        assert(member.name.length);
        const typeSize = sizeOf(member.type);
        const memberOffset = offset = align(offset, Math.max(alignment, typeSize));
        const components = member.components || 1;

        maxSize = Math.max(maxSize, typeSize);
        offset += typeSize * components;

        return {
            name: member.name,
            type: member.type,
            components,
            offset: memberOffset,
        };
    });

    const size = align(offset, Math.max(maxSize, alignment));

    return {
        members: layoutMembers,
        size,
        alignment
    };
}

function sizeOf(type: ViewType): number {
    return viewTypes[type].BYTES_PER_ELEMENT;
}

function align(offset: number, size: number): number {
    return Math.ceil(offset / size) * size;
}

export {StructArray, Struct, viewTypes, createLayout};
