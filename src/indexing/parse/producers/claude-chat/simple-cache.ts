// Chromium Simple Cache entry reader (just enough for the claude.ai desktop cache).
//
// The Claude desktop app is an Electron/Chromium wrapper around claude.ai; its HTTP cache stores the
// same API responses the web app fetches, including the full chat-transcript endpoint. Each cache
// entry is a `<hash>_0` file in the Simple Cache format:
//
//   SimpleFileHeader (20 bytes): uint64 magic (LE) · uint32 version · uint32 key_length · uint32 key_hash
//   key bytes (key_length)      : the request URL, as plaintext
//   stream 1                    : the response body (what we want)
//   stream 0 + EOF records      : HTTP headers and trailers at the tail
//
// Bodies arrive over the wire as `content-encoding: zstd` (Cloudflare), so the body stream is a raw
// zstd frame. We locate the frame magic after the key and decompress from there; the decoder stops at
// the frame boundary and ignores the trailing stream-0 bytes, so explicit stream bounding isn't needed.
import zlib from "node:zlib";

/** kSimpleInitialMagicNumber — identifies a Simple Cache entry file. */
const SIMPLE_FILE_MAGIC = 0xfcfb6d1ba7725c30n;
/** zstd frame magic (little-endian 0xFD2FB528). */
const ZSTD_FRAME_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const HEADER_BYTES = 20;
/** A Simple Cache key never realistically exceeds this; guards against a corrupt length field. */
const MAX_KEY_LENGTH = 64 * 1024;

export interface SimpleCacheHeader {
  version: number;
  /** The request URL stored as the cache key. */
  key: string;
  /** Byte offset where the response-body stream begins (immediately after the key). */
  bodyStart: number;
}

/**
 * Parse the fixed header + URL key of a Simple Cache entry. Returns null when the buffer is too small
 * or the magic doesn't match (i.e. not a Simple Cache entry). Reads only the header + key, so it's
 * cheap enough to run over every `<hash>_0` file during discovery.
 */
export function parseSimpleCacheHeader(buf: Buffer): SimpleCacheHeader | null {
  if (buf.length < HEADER_BYTES) return null;
  if (buf.readBigUInt64LE(0) !== SIMPLE_FILE_MAGIC) return null;
  const version = buf.readUInt32LE(8);
  const keyLength = buf.readUInt32LE(12);
  if (keyLength <= 0 || keyLength > MAX_KEY_LENGTH || HEADER_BYTES + keyLength > buf.length) return null;
  const key = buf.subarray(HEADER_BYTES, HEADER_BYTES + keyLength).toString("utf8");
  return { version, key, bodyStart: HEADER_BYTES + keyLength };
}

/**
 * Decode the response body of a Simple Cache entry into UTF-8 text. claude.ai responses arrive
 * `content-encoding: zstd` (Cloudflare), so the body is a zstd frame located at/after `bodyStart`; we
 * decompress from the frame magic (the decoder stops at the frame boundary, ignoring trailing stream-0
 * bytes). Returns null when no zstd frame is present — some small responses are stored uncompressed
 * (identity), but the response body isn't cleanly delimited without parsing the Simple Cache stream
 * lengths, so we don't guess. Callers treat null as "couldn't decode this entry" and handle it.
 */
export function decodeSimpleCacheBody(buf: Buffer, bodyStart: number): string | null {
  const frameStart = buf.indexOf(ZSTD_FRAME_MAGIC, bodyStart);
  if (frameStart < 0) return null;
  try {
    return zlib.zstdDecompressSync(buf.subarray(frameStart)).toString("utf8");
  } catch {
    return null;
  }
}
