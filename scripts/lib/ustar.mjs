/**
 * A minimal ustar archive writer (DX-5648, copied from @danxbot/ui DX-5645).
 *
 * WHY NOT `tar`: the test runner is invoked from Windows PowerShell, git-bash and
 * CI alike, and their `tar` binaries disagree on the flags that matter here (GNU
 * `--owner=1000` against bsdtar `--uid 1000`). An archive written here is
 * byte-identical on every host, carries exactly the owner the container's
 * non-root user needs, and takes each file's mode from the caller (the git index
 * mode, which a Windows checkout cannot report from the filesystem).
 */

const BLOCK = 512;

function octal(value, width) {
  const text = value.toString(8);
  if (text.length > width - 1) throw new Error(`ustar: ${value} does not fit a ${width}-byte octal field`);
  return text.padStart(width - 1, "0") + "\0";
}

function put(header, offset, text, width) {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length > width) throw new Error(`ustar: "${text}" is longer than its ${width}-byte field`);
  bytes.copy(header, offset);
}

/** Split a path into the ustar (prefix, name) pair, or throw: a path that cannot be split cannot be archived. */
export function splitUstarPath(path) {
  if (Buffer.byteLength(path) <= 100) return { prefix: "", name: path };
  for (let i = path.indexOf("/"); i !== -1; i = path.indexOf("/", i + 1)) {
    const prefix = path.slice(0, i);
    const name = path.slice(i + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { prefix, name };
  }
  throw new Error(`ustar: path cannot be archived (over 100 bytes with no split point): ${path}`);
}

function header({ path, mode, uid, gid, size, mtime, type }) {
  const { prefix, name } = splitUstarPath(path);
  const h = Buffer.alloc(BLOCK);
  put(h, 0, name, 100);
  put(h, 100, octal(mode, 8), 8);
  put(h, 108, octal(uid, 8), 8);
  put(h, 116, octal(gid, 8), 8);
  put(h, 124, octal(size, 12), 12);
  put(h, 136, octal(Math.floor(mtime), 12), 12);
  h.fill(0x20, 148, 156); // the checksum field counts as spaces while it is summed
  h[156] = type.charCodeAt(0);
  put(h, 257, "ustar\0", 6);
  put(h, 263, "00", 2);
  put(h, 345, prefix, 155);
  let sum = 0;
  for (const byte of h) sum += byte;
  put(h, 148, sum.toString(8).padStart(6, "0") + "\0 ", 8);
  return h;
}

/**
 * @param {{ path: string, mode: number, content: Buffer, mtime: number }[]} files  POSIX paths relative to the archive root
 * @param {{ uid: number, gid: number }} owner  the owner of every entry
 * @returns {Buffer}
 */
export function buildUstar(files, owner) {
  const parts = [];
  const dirs = new Set();
  for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    const segments = file.path.split("/");
    // Explicit directory entries: an extractor creates a missing parent as root, which the non-root test user could not write into.
    for (let depth = 1; depth < segments.length; depth++) {
      const dir = segments.slice(0, depth).join("/");
      if (dirs.has(dir)) continue;
      dirs.add(dir);
      parts.push(header({ path: `${dir}/`, mode: 0o755, ...owner, size: 0, mtime: file.mtime, type: "5" }));
    }
    parts.push(header({ path: file.path, mode: file.mode, ...owner, size: file.content.length, mtime: file.mtime, type: "0" }));
    parts.push(file.content);
    const pad = (BLOCK - (file.content.length % BLOCK)) % BLOCK;
    if (pad) parts.push(Buffer.alloc(pad));
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(parts);
}
