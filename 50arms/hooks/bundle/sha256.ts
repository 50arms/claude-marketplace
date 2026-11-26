// SHA-256 in plain code: the plugin checks the file the MCP wrote for a reply against the hash the MCP named, and no engine call (`crypto.subtle`, a node module) is
// one this plugin already depends on, so none is used. Pure: the text in, 64 lowercase hex characters out. The hash is of the text's UTF-8 bytes, as the MCP hashes the body it writes.

const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]

// The UTF-8 bytes of a text; a lone surrogate is U+FFFD, as every UTF-8 encoder writes it.
function utf8(text: string): number[] {
  const bytes: number[] = []
  for (let i = 0; i < text.length; i++) {
    let c = text.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) {
      c = 0x10000 + ((c - 0xd800) << 10) + (text.charCodeAt(++i) - 0xdc00)
    } else if (c >= 0xd800 && c <= 0xdfff) {
      c = 0xfffd
    }
    if (c < 0x80) bytes.push(c)
    else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f))
    else if (c < 0x10000) bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f))
    else bytes.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f))
  }
  return bytes
}

const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n))

export function sha256Hex(text: string): string {
  const bytes = utf8(text)
  const bitLength = bytes.length * 8
  bytes.push(0x80)
  while (bytes.length % 64 !== 56) bytes.push(0)
  for (let shift = 56; shift >= 0; shift -= 8) bytes.push(Math.floor(bitLength / 2 ** shift) & 0xff)
  const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]
  const w = new Array<number>(64).fill(0)
  for (let offset = 0; offset < bytes.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = ((bytes[offset + 4 * i] as number) << 24) | ((bytes[offset + 4 * i + 1] as number) << 16) | ((bytes[offset + 4 * i + 2] as number) << 8) | (bytes[offset + 4 * i + 3] as number)
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15] as number, 7) ^ rotr(w[i - 15] as number, 18) ^ ((w[i - 15] as number) >>> 3)
      const s1 = rotr(w[i - 2] as number, 17) ^ rotr(w[i - 2] as number, 19) ^ ((w[i - 2] as number) >>> 10)
      w[i] = ((w[i - 16] as number) + s0 + (w[i - 7] as number) + s1) | 0
    }
    let [a, b, c, d, e, f, g, hh] = h as [number, number, number, number, number, number, number, number]
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + (K[i] as number) + (w[i] as number)) | 0
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0
      hh = g
      g = f
      f = e
      e = (d + t1) | 0
      d = c
      c = b
      b = a
      a = (t1 + t2) | 0
    }
    ;[a, b, c, d, e, f, g, hh].forEach((v, i) => void (h[i] = ((h[i] as number) + v) | 0))
  }
  return h.map(v => (v >>> 0).toString(16).padStart(8, '0')).join('')
}
