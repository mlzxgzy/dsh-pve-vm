/**
 * Frames: parse a QMP PPM dump, then encode it locally as PNG or JPEG.
 *
 * The node has no ImageMagick and no Pillow (checked on pve04: python 3.9, no PIL), so all
 * encoding happens here. JPEG goes through the first available external encoder (ffmpeg,
 * ImageMagick, cjpeg); PNG is written by the built-in encoder below, which needs nothing but
 * `node:zlib` — so a screenshot always produces a viewable file, even on a bare machine.
 */
import zlib from 'node:zlib';
import { existsSync, statSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { VmError } from './errors.js';

/**
 * Parse a binary PPM (P6) frame produced by the QMP `screendump` command.
 * @param {Buffer} buffer the raw file bytes.
 * @returns {{width:number, height:number, pixels:Buffer, maxval:number}} the image.
 */
/**
 * Is this frame blank? A freshly booted guest can scan out nothing at all until the first input
 * event arrives (measured 2026-11-24: a 12,203-byte pure black 1280x800 frame with a live desktop
 * inside), and a guest whose monitor went to sleep looks the same. Both are "nothing to see",
 * which is what `pve_screenshot {wake:true}` reacts to.
 * @param {{width:number, height:number, pixels:Buffer}} image decoded frame.
 * @returns {{blank:boolean, min:number, max:number, mean:number}} luminance statistics.
 */
export function blankness(image) {
  const { width, height, pixels } = image;
  const channel = pixels.length / (width * height);
  const step = Math.max(1, Math.floor((width * height) / 4096)) * Math.max(1, Math.round(channel));
  let min = 255;
  let max = 0;
  let sum = 0;
  let count = 0;
  for (let index = 0; index + Math.round(channel) - 1 < pixels.length; index += step * Math.round(channel)) {
    const value = pixels[index];
    if (value < min) min = value;
    if (value > max) max = value;
    sum += value;
    count += 1;
  }
  if (count === 0) return { blank: true, min: 0, max: 0, mean: 0 };
  const mean = sum / count;
  // Near-black or a single flat colour: nothing recognisable is being scanned out.
  return { blank: max - min <= 8 || max <= 12, min, max, mean: Math.round(mean) };
}

export function parsePpm(buffer) {
  // Header: magic, width, height, maxval — separated by any whitespace, comments allowed.
  let offset = 0;
  const readToken = () => {
    for (;;) {
      while (offset < buffer.length && /\s/.test(String.fromCharCode(buffer[offset]))) offset += 1;
      if (buffer[offset] === 0x23) {
        while (offset < buffer.length && buffer[offset] !== 0x0a) offset += 1;
        continue;
      }
      break;
    }
    const start = offset;
    while (offset < buffer.length && !/\s/.test(String.fromCharCode(buffer[offset]))) offset += 1;
    return buffer.subarray(start, offset).toString('ascii');
  };
  const magic = readToken();
  if (magic !== 'P6') {
    throw new VmError('CONVERT_FAILED', `unexpected frame format "${magic}" (expected binary PPM P6)`);
  }
  const width = Number(readToken());
  const height = Number(readToken());
  const maxval = Number(readToken());
  offset += 1; // single whitespace byte before the raster
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new VmError('CONVERT_FAILED', `bad PPM size ${width}x${height}`);
  }
  const expected = width * height * 3;
  const pixels = buffer.subarray(offset, offset + expected);
  if (pixels.length < expected) {
    throw new VmError(
      'CONVERT_FAILED',
      `truncated PPM frame: ${pixels.length} of ${expected} raster bytes (${width}x${height})`,
    );
  }
  if (maxval !== 255) {
    throw new VmError('CONVERT_FAILED', `unsupported PPM maxval ${maxval} (only 8-bit frames are handled)`);
  }
  return { width, height, pixels, maxval };
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

/**
 * CRC-32 as PNG wants it.
 * @param {Buffer} buffer data.
 * @returns {number} the checksum.
 */
function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

/**
 * One PNG chunk.
 * @param {string} type four ASCII letters.
 * @param {Buffer} data chunk payload.
 * @returns {Buffer} the serialized chunk.
 */
function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/**
 * Encode RGB pixels as PNG (no dependencies).
 * @param {{width:number, height:number, pixels:Buffer}} image the frame.
 * @returns {Buffer} PNG bytes.
 */
export function encodePng(image) {
  const { width, height, pixels } = image;
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Candidate external JPEG encoders, probed once per process. */
const JPEG_ENCODERS = [
  {
    name: 'ffmpeg',
    binaries: ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg'],
    argv: (image, quality, out) => [
      '-v',
      'error',
      '-y',
      '-f',
      'rawvideo',
      '-pixel_format',
      'rgb24',
      '-video_size',
      `${image.width}x${image.height}`,
      '-i',
      'pipe:0',
      '-frames:v',
      '1',
      '-q:v',
      String(quality),
      out,
    ],
  },
  {
    name: 'convert',
    binaries: ['/usr/bin/convert', '/usr/local/bin/convert'],
    argv: (image, quality, out) => [
      '-size',
      `${image.width}x${image.height}`,
      '-depth',
      '8',
      'rgb:-',
      '-quality',
      String(Math.max(1, 100 - quality * 5)),
      out,
    ],
  },
  {
    name: 'magick',
    binaries: ['/usr/bin/magick', '/usr/local/bin/magick'],
    argv: (image, quality, out) => [
      '-size',
      `${image.width}x${image.height}`,
      '-depth',
      '8',
      'rgb:-',
      '-quality',
      String(Math.max(1, 100 - quality * 5)),
      out,
    ],
  },
  {
    name: 'cjpeg',
    binaries: ['/usr/bin/cjpeg', '/usr/local/bin/cjpeg'],
    argv: (image, quality, out) => ['-quality', String(Math.max(10, 100 - quality * 5)), '-outfile', out],
  },
];

let encoderCache;

/**
 * The first JPEG encoder that exists on this machine.
 * @returns {object|null} encoder descriptor or null.
 */
function jpegEncoder() {
  if (encoderCache !== undefined) return encoderCache;
  encoderCache = JPEG_ENCODERS.find((encoder) => encoder.binaries.some((path) => existsSync(path))) ?? null;
  return encoderCache;
}

/**
 * Write one frame to `outPath`, choosing the format by the file extension.
 *
 * JPEG is preferred (smaller files for the same picture) but is only possible with an external
 * encoder; when none answers, the frame is written as PNG instead and the caller is told so.
 * @param {{width:number, height:number, pixels:Buffer}} image the frame.
 * @param {{format:'jpeg'|'png', quality:number, outPath:string, spawn:(spec:object)=>object, cwd:string, timeoutMs?:number}} options encoding options.
 * @returns {Promise<{path:string, format:'jpeg'|'png', bytes:number, width:number, height:number, encoder:string}>} what was written.
 */
export async function writeFrame(image, options) {
  const { outPath, format, quality, spawn, cwd } = options;
  await mkdir(dirname(outPath), { recursive: true });
  if (format === 'jpeg') {
    const encoder = jpegEncoder();
    if (encoder !== null) {
      const binary = encoder.binaries.find((path) => existsSync(path));
      const handle = spawn({
        argv: [binary, ...encoder.argv(image, quality, outPath)],
        cwd,
        stdio: { stdin: 'pipe', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } },
        graceMs: 2000,
      });
      handle.stdin.end(image.pixels);
      const outcome = await handle.done;
      const written = existsSync(outPath) ? statSync(outPath).size : 0;
      if (outcome?.exitCode === 0 && written > 0) {
        return {
          path: outPath,
          format: 'jpeg',
          bytes: written,
          width: image.width,
          height: image.height,
          encoder: encoder.name,
        };
      }
    }
  }
  const pngPath = format === 'jpeg' ? outPath.replace(/\.jpe?g$/i, '.png') : outPath;
  const png = encodePng(image);
  await writeFile(pngPath, png);
  return {
    path: pngPath,
    format: 'png',
    bytes: png.length,
    width: image.width,
    height: image.height,
    encoder: 'builtin',
  };
}
