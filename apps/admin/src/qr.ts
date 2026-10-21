// Small, dependency-free QR encoder for local staging links.
// Version 5-L is enough for the short referral URLs used by this app.
const SIZE = 37;
const DATA_CODEWORDS = 108;
const ECC_CODEWORDS = 26;

function multiply(a: number, b: number, exp: number[], log: number[]) {
  if (!a || !b) return 0;
  return exp[log[a] + log[b]];
}

function fieldTables() {
  const exp = new Array<number>(512).fill(0);
  const log = new Array<number>(256).fill(0);
  let value = 1;
  for (let i = 0; i < 255; i++) { exp[i] = value; log[value] = i; value <<= 1; if (value & 0x100) value ^= 0x11d; }
  for (let i = 255; i < 512; i++) exp[i] = exp[i - 255];
  return { exp, log };
}

function reedSolomon(data: number[], count: number) {
  const { exp, log } = fieldTables();
  let generator = [1];
  for (let i = 0; i < count; i++) {
    const next = new Array<number>(generator.length + 1).fill(0);
    for (let j = 0; j < generator.length; j++) {
      next[j] ^= generator[j];
      next[j + 1] ^= multiply(generator[j], exp[i], exp, log);
    }
    generator = next;
  }
  const remainder = new Array<number>(count).fill(0);
  for (const byte of data) {
    const factor = byte ^ remainder[0];
    remainder.shift(); remainder.push(0);
    for (let i = 0; i < count; i++) remainder[i] ^= multiply(generator[i + 1], factor, exp, log);
  }
  return remainder;
}

function formatBits() {
  let value = 0b01000 << 10;
  let remainder = value;
  for (let i = 14; i >= 10; i--) if ((remainder >>> i) & 1) remainder ^= 0x537 << (i - 10);
  return ((value | remainder) ^ 0x5412) & 0x7fff;
}

function makeMatrix(payload: string) {
  const bytes = Array.from(new TextEncoder().encode(payload));
  if (bytes.length > 106) throw new Error('referral URL is too long for the local QR encoder');
  const bits: number[] = [0, 1, 0, 0];
  for (let i = 7; i >= 0; i--) bits.push((bytes.length >>> i) & 1);
  for (const byte of bytes) for (let i = 7; i >= 0; i--) bits.push((byte >>> i) & 1);
  while (bits.length < DATA_CODEWORDS * 8) bits.push(0);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  const pads = [0xec, 0x11];
  for (let i = bytes.length + 2; i < DATA_CODEWORDS; i++) data[i] = pads[(i - bytes.length - 2) % 2];
  const codewords = data.concat(reedSolomon(data, ECC_CODEWORDS));
  const matrix: Array<Array<boolean | null>> = Array.from({ length: SIZE }, () => Array<boolean | null>(SIZE).fill(null));
  const set = (x: number, y: number, value: boolean) => { if (x >= 0 && y >= 0 && x < SIZE && y < SIZE) matrix[y][x] = value; };
  const finder = (left: number, top: number) => {
    for (let dy = -1; dy <= 7; dy++) for (let dx = -1; dx <= 7; dx++) {
      const inside = dx >= 0 && dx < 7 && dy >= 0 && dy < 7;
      set(left + dx, top + dy, inside && (dx === 0 || dx === 6 || dy === 0 || dy === 6 || (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4)));
    }
  };
  finder(0, 0); finder(SIZE - 7, 0); finder(0, SIZE - 7);
  for (let i = 8; i < SIZE - 8; i++) { set(i, 6, i % 2 === 0); set(6, i, i % 2 === 0); }
  for (const [cx, cy] of [[6, 30], [30, 6], [30, 30]]) for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  set(SIZE - 8, 8, true);
  const format = formatBits();
  for (let i = 0; i < 15; i++) {
    const bit = ((format >>> i) & 1) !== 0;
    if (i < 6) set(i, 8, bit); else if (i < 8) set(i + 1, 8, bit); else set(SIZE - 15 + i, 8, bit);
    if (i < 8) set(8, SIZE - i - 1, bit); else if (i < 9) set(8, 15 - i, bit); else set(8, 15 - i - 1, bit);
  }
  let bitIndex = 0; let upward = true;
  for (let right = SIZE - 1; right >= 1; right -= 2) {
    if (right === 6) right--;
    for (let offset = 0; offset < SIZE; offset++) {
      const y = upward ? SIZE - 1 - offset : offset;
      for (let dx = 0; dx < 2; dx++) {
        const x = right - dx;
        if (matrix[y][x] !== null) continue;
        const value = bitIndex < codewords.length * 8 ? ((codewords[Math.floor(bitIndex / 8)] >>> (7 - (bitIndex % 8))) & 1) !== 0 : false;
        matrix[y][x] = value !== ((x + y) % 2 === 0); bitIndex++;
      }
    }
    upward = !upward;
  }
  return matrix.map(row => row.map(value => Boolean(value)));
}

export function referralQrSvg(payload: string) {
  const matrix = makeMatrix(payload); const quiet = 4;
  const modules = matrix.flatMap((row, y) => row.map((on, x) => on ? `<rect x="${x + quiet}" y="${y + quiet}" width="1" height="1"/>` : '')).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE + quiet * 2} ${SIZE + quiet * 2}" role="img" aria-label="Offline QR code"><rect width="100%" height="100%" fill="white"/>${modules}</svg>`;
}
