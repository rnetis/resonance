"use strict";

/**
 * ID3v2 tag reader (MP3).
 *
 * Reads the leading ID3v2 tag of an MP3 file and returns its text frames plus
 * the embedded cover art (APIC frame) when present. Supports ID3v2.2, v2.3 and
 * v2.4. ID3v1 (the 128-byte trailer) is used as a fallback.
 */

const fs = require("node:fs/promises");

const MAX_TAG_BYTES = 8 * 1024 * 1024;

// ID3v2.2 (3 chars) and ID3v2.3/2.4 (4 chars) frame ids mapped to our names.
const FRAME_IDS = {
    // v2.2
    TT2: "title",
    TP1: "artist",
    TP2: "albumArtist",
    TAL: "album",
    TRK: "track",
    TYE: "year",
    TCO: "genre",
    PIC: "picture",
    // v2.3 / v2.4
    TIT2: "title",
    TPE1: "artist",
    TPE2: "albumArtist",
    TALB: "album",
    TRCK: "track",
    TYER: "year",
    TDRC: "year",
    TCON: "genre",
    TLEN: "durationMs",
    APIC: "picture"
};

function syncSafe32(buffer, offset) {
    return (
        ((buffer[offset] & 0x7f) << 21) |
        ((buffer[offset + 1] & 0x7f) << 14) |
        ((buffer[offset + 2] & 0x7f) << 7) |
        (buffer[offset + 3] & 0x7f)
    );
}

function decodeText(data, encoding) {
    switch (encoding) {
        case 0:
            return data.toString("latin1");
        case 1: {
            // UTF-16 with BOM: 0xFEFF = big endian (needs swapping), 0xFFFE = little endian.
            if (data.length >= 2) {
                const bom = data.readUInt16BE(0);
                const body = data.subarray(2);
                if (bom === 0xfeff) {
                    const swapped = Buffer.from(body);
                    swapped.swap16();
                    return stripTrailingNulls(swapped.toString("utf16le"));
                }
                return stripTrailingNulls(body.toString("utf16le"));
            }
            return stripTrailingNulls(data.toString("utf16le"));
        }
        case 2:
            return stripTrailingNulls(data.toString("utf16be"));
        default:
            return stripTrailingNulls(data.toString("utf8"));
    }
}

function stripTrailingNulls(value) {
    return value.replace(/\0+$/, "").replace(/^\0+/, "");
}

/**
 * Split a concatenated text frame (null-separated) and keep the first value.
 */
function firstValue(text) {
    const parts = text.split(/\0/).filter(Boolean);
    return (parts[0] || "").trim();
}

function parsePicture(frame, version) {
    // v2.2 PIC: encoding(1) + format(3) + type(1) + description + 0 + data
    // v2.3/2.4 APIC: encoding(1) + mime(len, null term) + type(1) + description + 0 + data
    const encoding = frame[0];
    let offset = 1;
    let mime = "image/jpeg";

    if (version === 2) {
        mime = frame.subarray(1, 4).toString("latin1").toLowerCase();
        if (mime === "jpg") mime = "image/jpeg";
        if (mime === "png") mime = "image/png";
        offset = 4;
    } else {
        const end = frame.indexOf(0, offset);
        if (end === -1) return null;
        mime = frame.subarray(offset, end).toString("latin1") || "image/jpeg";
        offset = end + 1;
    }

    offset += 1; // picture type byte

    // Description is null terminated, encoded like the text frames.
    if (encoding === 1 || encoding === 2) {
        let i = offset;
        while (i + 1 < frame.length && !(frame[i] === 0 && frame[i + 1] === 0)) {
            i += 2;
        }
        offset = i + 2;
    } else {
        const end = frame.indexOf(0, offset);
        if (end === -1) return null;
        offset = end + 1;
    }

    const data = frame.subarray(offset);
    if (!data.length) return null;

    if (mime === "image/jpg") mime = "image/jpeg";
    if (!mime.startsWith("image/")) mime = sniffImageMime(data);
    if (!mime) return null;

    return { mime, data };
}

function sniffImageMime(data) {
    if (data.length > 3 && data[0] === 0xff && data[1] === 0xd8) return "image/jpeg";
    if (data.length > 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
        return "image/png";
    }
    return null;
}

function readFrames(buffer, version) {
    const tags = {};
    const idLength = version === 2 ? 3 : 4;
    let offset = 0;

    while (offset + idLength + (version === 2 ? 3 : 6) <= buffer.length) {
        const id = buffer.subarray(offset, offset + idLength).toString("latin1");
        if (!/^[A-Z0-9]{3,4}$/.test(id)) break;

        let size;
        let headerSize;

        if (version === 2) {
            size = (buffer[offset + 3] << 16) | (buffer[offset + 4] << 8) | buffer[offset + 5];
            headerSize = 6;
        } else if (version === 4) {
            size = syncSafe32(buffer, offset + 4);
            headerSize = 10;
        } else {
            size = buffer.readUInt32BE(offset + 4);
            headerSize = 10;
        }

        if (size <= 0 || offset + headerSize + size > buffer.length) break;

        const name = FRAME_IDS[id];
        const frame = buffer.subarray(offset + headerSize, offset + headerSize + size);

        if (name === "picture") {
            const picture = parsePicture(frame, version);
            if (picture) tags.picture = picture;
        } else if (name === "durationMs") {
            const value = Number.parseInt(firstValue(decodeText(frame.subarray(1), frame[0])), 10);
            if (Number.isFinite(value) && value > 0) tags.duration = value / 1000;
        } else if (name && tags[name] === undefined) {
            const value = firstValue(decodeText(frame.subarray(1), frame[0]));
            if (value) tags[name] = value;
        }

        offset += headerSize + size;
    }

    return tags;
}

async function readId3v1(handle, fileSize) {
    if (fileSize < 128) return {};
    const trailer = Buffer.alloc(128);
    await handle.read(trailer, 0, 128, fileSize - 128);
    if (trailer.subarray(0, 3).toString("latin1") !== "TAG") return {};

    const text = (start, length) => stripTrailingNulls(trailer.subarray(start, start + length).toString("latin1")).trim();

    return {
        title: text(3, 30) || undefined,
        artist: text(33, 30) || undefined,
        album: text(63, 30) || undefined
    };
}

/**
 * @param {string} filePath
 * @returns {Promise<{title?:string, artist?:string, album?:string, picture?:{mime:string,data:Buffer}, duration?:number}>}
 */
async function readTags(filePath) {
    let handle;

    try {
        handle = await fs.open(filePath, "r");
        const stat = await handle.stat();
        const header = Buffer.alloc(10);
        const { bytesRead } = await handle.read(header, 0, 10, 0);

        if (bytesRead < 10 || header.subarray(0, 3).toString("latin1") !== "ID3") {
            return await readId3v1(handle, stat.size);
        }

        const version = header[3];
        const flags = header[5];
        const size = syncSafe32(header, 6);

        if (size <= 0 || size > MAX_TAG_BYTES) {
            return await readId3v1(handle, stat.size);
        }

        // Extended header (v2.3/2.4) sits between the header and the frames.
        let bodySize = size;
        const body = Buffer.alloc(bodySize);
        await handle.read(body, 0, bodySize, 10);

        let frameBuffer = body;
        if ((flags & 0x40) && version >= 3) {
            const extSize = version === 4 ? syncSafe32(body, 0) : body.readUInt32BE(0);
            frameBuffer = body.subarray(extSize);
        }

        return readFrames(frameBuffer, version);
    } catch {
        return {};
    } finally {
        await handle?.close().catch(() => {});
    }
}

module.exports = { readTags };
