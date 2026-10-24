const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** The most a stored (uncompressed) deflate block holds: its length field is 16 bits. */
export const STORED_BLOCK_MAX = 0xffff;
const ADLER_MODULUS = 65521;
/** Bytes Adler-32 can add before its sums need reducing to stay below 2^31. */
const ADLER_RUN = 3800;
/** Each scanline starts with its filter type; 0 (None) leaves the row's bytes as they are. */
const FILTER_NONE = new Uint8Array(1);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

/** CRC-32 of bytes[start, end), which every PNG chunk carries over its type and data. */
const crc32 = (bytes: Uint8Array, start: number, end: number): number => {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
};

/**
 * The bytes of an uncompressed 8-bit RGBA PNG holding `rgba` (ImageData's row-major RGBA order). Its
 * image data is a zlib stream of stored deflate blocks, so the pixels go in exactly as they are, each
 * row behind a filter byte of 0, and only the checksums need computing: a copy and one pass over the
 * bytes, where a real PNG encode compresses them (src/game/finishImage.ts says why that matters).
 */
export const encodePng = (width: number, height: number, rgba: Uint8Array | Uint8ClampedArray) => {
  const rowBytes = width * 4;
  const scanlineBytes = height * (1 + rowBytes);
  const blocks = Math.max(1, Math.ceil(scanlineBytes / STORED_BLOCK_MAX));
  const idatLength = 2 + blocks * 5 + scanlineBytes + 4;
  const png = new Uint8Array(PNG_SIGNATURE.length + (12 + 13) + (12 + idatLength) + 12);
  const view = new DataView(png.buffer);
  png.set(PNG_SIGNATURE);
  let at = PNG_SIGNATURE.length;

  /** Writes a chunk's length and type; the returned function writes its CRC once its data is in. */
  const chunk = (type: string, length: number) => {
    view.setUint32(at, length);
    const typeStart = at + 4;
    for (let i = 0; i < 4; i++) png[typeStart + i] = type.charCodeAt(i);
    at = typeStart + 4;
    return () => {
      view.setUint32(at, crc32(png, typeStart, at));
      at += 4;
    };
  };

  const endHeader = chunk('IHDR', 13);
  view.setUint32(at, width);
  view.setUint32(at + 4, height);
  png[at + 8] = 8; // bits per channel
  png[at + 9] = 6; // colour type: RGBA
  at += 13; // compression, filter method and interlacing all stay 0
  endHeader();

  const endData = chunk('IDAT', idatLength);
  png[at++] = 0x78; // zlib: deflate, 32K window
  png[at++] = 0x01; // no preset dictionary; 0x7801 is a multiple of 31, as the header check needs
  let adlerA = 1;
  let adlerB = 0;
  let unwritten = scanlineBytes;
  let room = 0;
  /** Copies scanline bytes in, opening the next stored block whenever the current one is full. */
  const put = (bytes: Uint8Array) => {
    for (let i = 0; i < bytes.length;) {
      if (room === 0) {
        room = Math.min(STORED_BLOCK_MAX, unwritten);
        unwritten -= room;
        png[at] = unwritten === 0 ? 1 : 0; // BFINAL on the last block; BTYPE 00, stored
        view.setUint16(at + 1, room, true);
        view.setUint16(at + 3, ~room & 0xffff, true);
        at += 5;
      }
      const count = Math.min(room, bytes.length - i);
      png.set(bytes.subarray(i, i + count), at);
      for (const end = at + count; at < end;) {
        for (const stop = Math.min(end, at + ADLER_RUN); at < stop; at++) {
          adlerA += png[at];
          adlerB += adlerA;
        }
        adlerA %= ADLER_MODULUS;
        adlerB %= ADLER_MODULUS;
      }
      i += count;
      room -= count;
    }
  };
  const pixels = new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength);
  for (let row = 0; row < height; row++) {
    put(FILTER_NONE);
    put(pixels.subarray(row * rowBytes, (row + 1) * rowBytes));
  }
  view.setUint32(at, adlerB * 0x10000 + adlerA);
  at += 4;
  endData();

  chunk('IEND', 0)();
  return png;
};
