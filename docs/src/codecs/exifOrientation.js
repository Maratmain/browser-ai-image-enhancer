function readUint16(view, offset, littleEndian) {
    if (offset < 0 || offset + 2 > view.byteLength)
        return undefined;
    return view.getUint16(offset, littleEndian);
}
function readUint32(view, offset, littleEndian) {
    if (offset < 0 || offset + 4 > view.byteLength)
        return undefined;
    return view.getUint32(offset, littleEndian);
}
export function parseExifOrientation(bytes) {
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8)
        return 1;
    let offset = 2;
    while (offset + 4 <= bytes.length) {
        if (bytes[offset] !== 0xff)
            break;
        const marker = bytes[offset + 1] ?? 0;
        offset += 2;
        if (marker === 0xd9 || marker === 0xda)
            break;
        if (marker >= 0xd0 && marker <= 0xd7)
            continue;
        if (offset + 2 > bytes.length)
            break;
        const segmentLength = ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
        if (segmentLength < 2 || offset + segmentLength > bytes.length)
            break;
        if (marker === 0xe1 &&
            segmentLength >= 10 &&
            bytes[offset + 2] === 0x45 &&
            bytes[offset + 3] === 0x78 &&
            bytes[offset + 4] === 0x69 &&
            bytes[offset + 5] === 0x66 &&
            bytes[offset + 6] === 0x00 &&
            bytes[offset + 7] === 0x00) {
            const tiffStart = offset + 8;
            const tiffBytes = bytes.subarray(tiffStart, offset + segmentLength);
            const view = new DataView(tiffBytes.buffer, tiffBytes.byteOffset, tiffBytes.byteLength);
            if (view.byteLength < 8)
                return 1;
            const byteOrder = view.getUint16(0, false);
            const littleEndian = byteOrder === 0x4949;
            if (!littleEndian && byteOrder !== 0x4d4d)
                return 1;
            if (readUint16(view, 2, littleEndian) !== 42)
                return 1;
            const ifdOffset = readUint32(view, 4, littleEndian);
            if (ifdOffset === undefined)
                return 1;
            const count = readUint16(view, ifdOffset, littleEndian);
            if (count === undefined)
                return 1;
            for (let index = 0; index < count; index += 1) {
                const entry = ifdOffset + 2 + index * 12;
                const tag = readUint16(view, entry, littleEndian);
                if (tag !== 0x0112)
                    continue;
                const type = readUint16(view, entry + 2, littleEndian);
                const itemCount = readUint32(view, entry + 4, littleEndian);
                if (type !== 3 || itemCount !== 1)
                    return 1;
                const value = readUint16(view, entry + 8, littleEndian);
                return value !== undefined && value >= 1 && value <= 8 ? value : 1;
            }
        }
        offset += segmentLength;
    }
    return 1;
}
