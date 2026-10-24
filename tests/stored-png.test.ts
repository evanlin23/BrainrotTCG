// The finish renders' PNG encoder (src/game/storedPng.ts), checked against Node's zlib (CRC-32,
// inflate with its Adler-32 check) and sharp's PNG decoder rather than against itself.
import { crc32, inflateSync } from 'node:zlib';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { encodePng, STORED_BLOCK_MAX } from '../src/game/storedPng';

interface Pixels { width: number; height: number; data: Uint8ClampedArray }

/** Deterministic RGBA pixels that vary every channel, alpha 0 and 255 included. */
const samplePixels = (width: number, height: number): Pixels => {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i++) data[i] = (i * 37 + (i >> 5) * 11) & 0xff;
  return { width, height, data };
};

const encode = ({ width, height, data }: Pixels) => encodePng(width, height, data);

interface Chunk { type: string; data: Uint8Array; crc: number; covered: Uint8Array }

/** Splits a PNG after its signature into chunks, keeping the bytes each CRC covers (type and data). */
const chunksOf = (png: Uint8Array): Chunk[] => {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const chunks: Chunk[] = [];
  for (let at = 8; at < png.length;) {
    const length = view.getUint32(at);
    chunks.push({
      type: String.fromCharCode(...png.subarray(at + 4, at + 8)),
      data: png.subarray(at + 8, at + 8 + length),
      crc: view.getUint32(at + 8 + length),
      covered: png.subarray(at + 4, at + 8 + length),
    });
    at += 12 + length;
  }
  return chunks;
};

/** Adler-32 by its definition, one byte and one modulo at a time. */
const referenceAdler32 = (bytes: Uint8Array) => {
  let a = 1;
  let b = 0;
  for (const byte of bytes) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  return b * 65536 + a;
};

const trailingUint32 = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset + bytes.length - 4, 4).getUint32(0);

/** The scanlines a PNG with filter None holds: each row behind a 0 byte. */
const scanlinesOf = ({ width, height, data }: Pixels) => {
  const rowBytes = width * 4;
  const out = new Uint8Array(height * (1 + rowBytes));
  for (let row = 0; row < height; row++) out.set(data.subarray(row * rowBytes, (row + 1) * rowBytes), row * (1 + rowBytes) + 1);
  return out;
};

describe('uncompressed PNG encoding', () => {
  it('writes a PNG signature, an 8-bit RGBA header, image data and an end chunk, each with its CRC', () => {
    const png = encode(samplePixels(3, 2));
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const chunks = chunksOf(png);
    expect(chunks.map((chunk) => chunk.type)).toEqual(['IHDR', 'IDAT', 'IEND']);
    for (const chunk of chunks) expect(chunk.crc).toBe(crc32(chunk.covered));
    expect(chunks[2].data).toHaveLength(0);
    expect(chunks[2].crc).toBe(0xae426082);

    const [header] = chunks;
    expect(header.data).toHaveLength(13);
    const fields = new DataView(header.data.buffer, header.data.byteOffset, 13);
    expect([fields.getUint32(0), fields.getUint32(4)]).toEqual([3, 2]);
    // Bit depth 8, colour type 6 (RGBA), deflate compression, adaptive filtering, no interlace.
    expect([...header.data.subarray(8)]).toEqual([8, 6, 0, 0, 0]);
  });

  it('stores short scanlines in one final stored block, then their Adler-32', () => {
    const image = samplePixels(3, 2);
    const idat = chunksOf(encode(image))[1].data;
    const scanlines = scanlinesOf(image);
    expect(scanlines).toHaveLength(26);
    // zlib header: deflate with a 32K window, no preset dictionary, a valid check value.
    expect([idat[0], idat[1]]).toEqual([0x78, 0x01]);
    expect((idat[0] * 256 + idat[1]) % 31).toBe(0);
    // BFINAL 1 and BTYPE 00, then LEN and its complement, little-endian.
    expect([...idat.subarray(2, 7)]).toEqual([1, 26, 0, 0xff - 26, 0xff]);
    expect([...idat.subarray(7, 7 + 26)]).toEqual([...scanlines]);
    expect(idat).toHaveLength(2 + 5 + 26 + 4);
    expect(trailingUint32(idat)).toBe(referenceAdler32(scanlines));
    expect(inflateSync(idat)).toEqual(Buffer.from(scanlines));
  });

  it('splits scanlines longer than one stored block into full blocks, mid-row, with only the last final', () => {
    // 300 rows of 513 bytes: 153900 bytes, so two full blocks and a 22830-byte last one.
    const image = samplePixels(128, 300);
    const [, idatChunk] = chunksOf(encode(image));
    expect(idatChunk.crc).toBe(crc32(idatChunk.covered));
    const idat = idatChunk.data;
    const scanlines = scanlinesOf(image);
    expect(scanlines).toHaveLength(153900);
    expect(STORED_BLOCK_MAX).toBe(65535);

    const blocks: { final: number; length: number }[] = [];
    let at = 2;
    let stored = 0;
    while (blocks.length === 0 || !blocks[blocks.length - 1].final) {
      expect(idat[at] >> 1).toBe(0); // BTYPE 00, stored
      const length = idat[at + 1] | (idat[at + 2] << 8);
      expect(idat[at + 3] | (idat[at + 4] << 8)).toBe(~length & 0xffff);
      expect([...idat.subarray(at + 5, at + 5 + length)]).toEqual([...scanlines.subarray(stored, stored + length)]);
      blocks.push({ final: idat[at] & 1, length });
      stored += length;
      at += 5 + length;
    }
    expect(blocks).toEqual([{ final: 0, length: 65535 }, { final: 0, length: 65535 }, { final: 1, length: 22830 }]);
    expect(at).toBe(idat.length - 4);
    expect(trailingUint32(idat)).toBe(referenceAdler32(scanlines));
    expect(inflateSync(idat)).toEqual(Buffer.from(scanlines));
  });

  it('decodes, with an independent PNG decoder, to exactly the pixels it was given', async () => {
    // Full-size card width too: 687 RGBA pixels per row.
    for (const [width, height] of [[1, 1], [5, 3], [128, 300], [687, 40]]) {
      const image = samplePixels(width, height);
      const { data, info } = await sharp(encode(image)).raw().toBuffer({ resolveWithObject: true });
      expect(info).toMatchObject({ width, height, channels: 4 });
      expect(data.equals(Buffer.from(image.data.buffer))).toBe(true);
    }
  });

  it('reads the pixels from where their view starts in its buffer', async () => {
    const backing = new Uint8ClampedArray([9, 9, 9, 9, 255, 0, 0, 255, 0, 0, 255, 128]);
    const png = encodePng(2, 1, backing.subarray(4));
    const { data } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
    expect([...data]).toEqual([255, 0, 0, 255, 0, 0, 255, 128]);
  });
});
