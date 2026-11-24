// Minimal ISO/IEC 18004 QR Code encoder (Byte mode, Error Correction Level L,
// Versions 1-10, up to 271 UTF-8 bytes) for rendering pairing URLs as SVG
// without pulling a third-party dependency into the Web bundle.

interface VersionSpec {
  readonly version: number;
  readonly totalCodewords: number;
  readonly ecPerBlock: number;
  readonly blocksGroup1: number;
  readonly dataPerBlock1: number;
  readonly blocksGroup2: number;
  readonly dataPerBlock2: number;
  readonly alignmentCenters: readonly number[];
}

// ISO/IEC 18004 Table 9 (Level L) & Annex E alignment pattern centers.
const VERSION_SPECS: readonly VersionSpec[] = [
  {
    version: 1,
    totalCodewords: 26,
    ecPerBlock: 7,
    blocksGroup1: 1,
    dataPerBlock1: 19,
    blocksGroup2: 0,
    dataPerBlock2: 0,
    alignmentCenters: [],
  },
  {
    version: 2,
    totalCodewords: 44,
    ecPerBlock: 10,
    blocksGroup1: 1,
    dataPerBlock1: 34,
    blocksGroup2: 0,
    dataPerBlock2: 0,
    alignmentCenters: [6, 18],
  },
  {
    version: 3,
    totalCodewords: 70,
    ecPerBlock: 15,
    blocksGroup1: 1,
    dataPerBlock1: 55,
    blocksGroup2: 0,
    dataPerBlock2: 0,
    alignmentCenters: [6, 22],
  },
  {
    version: 4,
    totalCodewords: 100,
    ecPerBlock: 20,
    blocksGroup1: 1,
    dataPerBlock1: 80,
    blocksGroup2: 0,
    dataPerBlock2: 0,
    alignmentCenters: [6, 26],
  },
  {
    version: 5,
    totalCodewords: 134,
    ecPerBlock: 26,
    blocksGroup1: 1,
    dataPerBlock1: 108,
    blocksGroup2: 0,
    dataPerBlock2: 0,
    alignmentCenters: [6, 30],
  },
  {
    version: 6,
    totalCodewords: 172,
    ecPerBlock: 18,
    blocksGroup1: 2,
    dataPerBlock1: 68,
    blocksGroup2: 0,
    dataPerBlock2: 0,
    alignmentCenters: [6, 34],
  },
  {
    version: 7,
    totalCodewords: 196,
    ecPerBlock: 20,
    blocksGroup1: 2,
    dataPerBlock1: 78,
    blocksGroup2: 0,
    dataPerBlock2: 0,
    alignmentCenters: [6, 22, 38],
  },
  {
    version: 8,
    totalCodewords: 242,
    ecPerBlock: 24,
    blocksGroup1: 2,
    dataPerBlock1: 97,
    blocksGroup2: 0,
    dataPerBlock2: 0,
    alignmentCenters: [6, 24, 42],
  },
  {
    version: 9,
    totalCodewords: 292,
    ecPerBlock: 30,
    blocksGroup1: 2,
    dataPerBlock1: 116,
    blocksGroup2: 0,
    dataPerBlock2: 0,
    alignmentCenters: [6, 26, 46],
  },
  {
    version: 10,
    totalCodewords: 346,
    ecPerBlock: 18,
    blocksGroup1: 2,
    dataPerBlock1: 68,
    blocksGroup2: 2,
    dataPerBlock2: 69,
    alignmentCenters: [6, 28, 50],
  },
];

// Precomputed GF(256) exp/log tables with primitive polynomial 0x11d.
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) {
    GF_EXP[i] = GF_EXP[i - 255]!;
  }
}

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a]! + GF_LOG[b]!]!;
}

function rsGenerator(degree: number): Uint8Array {
  let poly: Uint8Array = new Uint8Array([1]);
  for (let i = 0; i < degree; i += 1) {
    const next = new Uint8Array(poly.length + 1);
    const factor = GF_EXP[i]!;
    for (let j = 0; j < poly.length; j += 1) {
      next[j] = (next[j] ?? 0) ^ poly[j]!;
      next[j + 1] = (next[j + 1] ?? 0) ^ gfMul(poly[j]!, factor);
    }
    poly = next;
  }
  return poly;
}

function rsRemainder(data: Uint8Array, ecCount: number): Uint8Array {
  const gen = rsGenerator(ecCount);
  const rem = new Uint8Array(ecCount);
  for (const byte of data) {
    const factor = byte ^ rem[0]!;
    rem.copyWithin(0, 1);
    rem[ecCount - 1] = 0;
    if (factor !== 0) {
      for (let j = 0; j < ecCount; j += 1) {
        rem[j] = rem[j]! ^ gfMul(gen[j + 1]!, factor);
      }
    }
  }
  return rem;
}

function pickSpec(byteLength: number): VersionSpec | undefined {
  for (const spec of VERSION_SPECS) {
    const dataCodewords =
      spec.blocksGroup1 * spec.dataPerBlock1 +
      spec.blocksGroup2 * spec.dataPerBlock2;
    const countBits = spec.version <= 9 ? 8 : 16;
    const neededBits = 4 + countBits + byteLength * 8;
    if (neededBits <= dataCodewords * 8) return spec;
  }
  return undefined;
}

function buildCodewords(bytes: Uint8Array, spec: VersionSpec): Uint8Array {
  const totalData =
    spec.blocksGroup1 * spec.dataPerBlock1 +
    spec.blocksGroup2 * spec.dataPerBlock2;
  const bits: number[] = [];
  const pushBits = (val: number, len: number) => {
    for (let i = len - 1; i >= 0; i -= 1) {
      bits.push((val >>> i) & 1);
    }
  };
  // Mode indicator 0100 = Byte mode.
  pushBits(0b0100, 4);
  pushBits(bytes.length, spec.version <= 9 ? 8 : 16);
  for (const b of bytes) pushBits(b, 8);
  const capacityBits = totalData * 8;
  const terminator = Math.min(4, capacityBits - bits.length);
  pushBits(0, terminator);
  while (bits.length % 8 !== 0) bits.push(0);

  const data = new Uint8Array(totalData);
  let byteIdx = 0;
  for (let i = 0; i < bits.length; i += 8) {
    let v = 0;
    for (let b = 0; b < 8; b += 1) v = (v << 1) | bits[i + b]!;
    data[byteIdx++] = v;
  }
  const padBytes = [0xec, 0x11];
  let padIdx = 0;
  while (byteIdx < totalData) {
    data[byteIdx++] = padBytes[padIdx % 2]!;
    padIdx += 1;
  }

  const dataBlocks: Uint8Array[] = [];
  const ecBlocks: Uint8Array[] = [];
  let offset = 0;
  for (let i = 0; i < spec.blocksGroup1; i += 1) {
    const block = data.slice(offset, offset + spec.dataPerBlock1);
    offset += spec.dataPerBlock1;
    dataBlocks.push(block);
    ecBlocks.push(rsRemainder(block, spec.ecPerBlock));
  }
  for (let i = 0; i < spec.blocksGroup2; i += 1) {
    const block = data.slice(offset, offset + spec.dataPerBlock2);
    offset += spec.dataPerBlock2;
    dataBlocks.push(block);
    ecBlocks.push(rsRemainder(block, spec.ecPerBlock));
  }

  const result = new Uint8Array(spec.totalCodewords);
  let out = 0;
  const maxDataLen = Math.max(spec.dataPerBlock1, spec.dataPerBlock2);
  for (let i = 0; i < maxDataLen; i += 1) {
    for (const block of dataBlocks) {
      if (i < block.length) result[out++] = block[i]!;
    }
  }
  for (let i = 0; i < spec.ecPerBlock; i += 1) {
    for (const block of ecBlocks) {
      result[out++] = block[i]!;
    }
  }
  return result;
}

function formatBits(mask: number): number {
  // Error correction level L = 01; 5-bit data = (01 << 3) | mask.
  const data = (0b01 << 3) | (mask & 0b111);
  let rem = data << 10;
  for (let i = 14; i >= 10; i -= 1) {
    if ((rem >>> i) & 1) rem ^= 0x537 << (i - 10);
  }
  return ((data << 10) | rem) ^ 0x5412;
}

function versionBits(version: number): number {
  let rem = version << 12;
  for (let i = 17; i >= 12; i -= 1) {
    if ((rem >>> i) & 1) rem ^= 0x1f25 << (i - 12);
  }
  return (version << 12) | rem;
}

export interface QrMatrix {
  readonly size: number;
  readonly modules: readonly boolean[];
}

/** Encodes a UTF-8 string into a square QR boolean matrix, or undefined if too long (>271 bytes). */
export function encodeQrMatrix(text: string): QrMatrix | undefined {
  const bytes = new TextEncoder().encode(text);
  const spec = pickSpec(bytes.length);
  if (!spec) return undefined;

  const size = spec.version * 4 + 17;
  const modules = new Array<boolean>(size * size).fill(false);
  const isFunction = new Array<boolean>(size * size).fill(false);
  const setFunc = (r: number, c: number, dark: boolean) => {
    if (r < 0 || r >= size || c < 0 || c >= size) return;
    modules[r * size + c] = dark;
    isFunction[r * size + c] = true;
  };

  // Finder patterns + separators.
  const drawFinder = (top: number, left: number) => {
    for (let dy = -1; dy <= 7; dy += 1) {
      for (let dx = -1; dx <= 7; dx += 1) {
        const dist = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
        setFunc(top + dy, left + dx, dist !== 2 && dist !== 4);
      }
    }
  };
  drawFinder(0, 0);
  drawFinder(0, size - 7);
  drawFinder(size - 7, 0);

  // Timing patterns.
  for (let i = 8; i < size - 8; i += 1) {
    setFunc(6, i, i % 2 === 0);
    setFunc(i, 6, i % 2 === 0);
  }

  // Alignment patterns.
  const centers = spec.alignmentCenters;
  for (const r of centers) {
    for (const c of centers) {
      if (
        (r === 6 && c === 6) ||
        (r === 6 && c === size - 7) ||
        (r === size - 7 && c === 6)
      ) {
        continue;
      }
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) {
          const dist = Math.max(Math.abs(dx), Math.abs(dy));
          setFunc(r + dy, c + dx, dist !== 1);
        }
      }
    }
  }

  // Reserve format info & dark module.
  for (let i = 0; i <= 8; i += 1) {
    if (i !== 6) {
      setFunc(8, i, false);
      setFunc(i, 8, false);
    }
  }
  for (let i = size - 8; i < size; i += 1) {
    setFunc(8, i, false);
    setFunc(i, 8, false);
  }
  setFunc(size - 8, 8, true);

  // Version info for Version >= 7.
  if (spec.version >= 7) {
    const vBits = versionBits(spec.version);
    for (let i = 0; i < 18; i += 1) {
      const bit = ((vBits >>> i) & 1) === 1;
      const a = Math.floor(i / 3);
      const b = size - 11 + (i % 3);
      setFunc(a, b, bit);
      setFunc(b, a, bit);
    }
  }

  // Place data bits in upward/downward zigzag columns.
  const codewords = buildCodewords(bytes, spec);
  let bitIndex = 0;
  const totalBits = codewords.length * 8;
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let step = 0; step < size; step += 1) {
      const r = upward ? size - 1 - step : step;
      for (let dx = 0; dx < 2; dx += 1) {
        const c = right - dx;
        if (isFunction[r * size + c]) continue;
        let dark = false;
        if (bitIndex < totalBits) {
          dark =
            ((codewords[bitIndex >>> 3]! >>> (7 - (bitIndex & 7))) & 1) === 1;
          bitIndex += 1;
        }
        // Apply Mask 0: (r + c) % 2 === 0.
        modules[r * size + c] = (r + c) % 2 === 0 ? !dark : dark;
      }
    }
    upward = !upward;
  }

  // Write format info for Mask 0, Level L.
  const fBits = formatBits(0);
  for (let i = 0; i <= 5; i += 1)
    setFunc(8, i, ((fBits >>> (14 - i)) & 1) === 1);
  setFunc(8, 7, ((fBits >>> 8) & 1) === 1);
  setFunc(8, 8, ((fBits >>> 7) & 1) === 1);
  setFunc(7, 8, ((fBits >>> 6) & 1) === 1);
  for (let i = 9; i < 15; i += 1) {
    setFunc(14 - i, 8, ((fBits >>> (14 - i)) & 1) === 1);
  }
  for (let i = 0; i < 8; i += 1) {
    setFunc(8, size - 1 - i, ((fBits >>> i) & 1) === 1);
  }
  for (let i = 8; i < 15; i += 1) {
    setFunc(size - 15 + i, 8, ((fBits >>> i) & 1) === 1);
  }

  return { size, modules };
}
