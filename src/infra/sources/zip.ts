// Plan 13 R-F: Epoch ships its tables as one zip. Reading it needs only the central directory and
// raw deflate (`Bun.inflateSync`), so there is no dependency for it.

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

/**
 * The files of a zip archive whose names `want` accepts, by name: stored (method 0) or deflated (8). Throws
 * on a malformed archive or another method. ZIP64 archives are not read (Epoch's is 2 MB).
 */
export function unzip(
  bytes: Uint8Array,
  want: (name: string) => boolean = () => true,
): Map<string, Uint8Array> {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  // the end record is 22 bytes plus a comment of up to 64 KiB
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--)
    if (dv.getUint32(i, true) === EOCD) {
      end = i;
      break;
    }
  if (end < 0) throw new Error("not a zip archive");
  const count = dv.getUint16(end + 10, true);
  let at = dv.getUint32(end + 16, true);
  const decode = new TextDecoder();
  const out = new Map<string, Uint8Array>();
  for (let k = 0; k < count; k++) {
    if (dv.getUint32(at, true) !== CENTRAL) throw new Error("a malformed zip directory");
    const method = dv.getUint16(at + 10, true);
    const size = dv.getUint32(at + 20, true);
    const nameLen = dv.getUint16(at + 28, true);
    const extraLen = dv.getUint16(at + 30, true);
    const commentLen = dv.getUint16(at + 32, true);
    const local = dv.getUint32(at + 42, true);
    const name = decode.decode(bytes.subarray(at + 46, at + 46 + nameLen));
    at += 46 + nameLen + extraLen + commentLen;
    if (!want(name)) continue;
    if (dv.getUint32(local, true) !== LOCAL) throw new Error(`a malformed zip entry: ${name}`);
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    const data = bytes.subarray(start, start + size);
    if (method === 0) out.set(name, data);
    else if (method === 8) out.set(name, Bun.inflateSync(data.slice()));
    else throw new Error(`zip method ${method} is not read: ${name}`);
  }
  return out;
}
