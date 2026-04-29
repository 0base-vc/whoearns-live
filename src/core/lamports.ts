export const LAMPORTS_PER_SOL = 1_000_000_000n;

/**
 * Parse a bigint-like input to bigint.
 * Accepts bigint, integer number, or a decimal string of integer lamports.
 */
export function toLamports(input: bigint | number | string): bigint {
  if (typeof input === 'bigint') return input;
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || !Number.isInteger(input)) {
      throw new RangeError(`Invalid lamports number: ${input}`);
    }
    return BigInt(input);
  }
  const trimmed = input.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    throw new RangeError(`Invalid lamports string: "${input}"`);
  }
  return BigInt(trimmed);
}

/**
 * Format lamports as a decimal SOL string with up to 9 fractional digits, trimmed.
 */
export function lamportsToSol(lamports: bigint | number | string): string {
  const lam = toLamports(lamports);
  const negative = lam < 0n;
  const abs = negative ? -lam : lam;
  const whole = abs / LAMPORTS_PER_SOL;
  const frac = abs % LAMPORTS_PER_SOL;
  if (frac === 0n) {
    return `${negative ? '-' : ''}${whole.toString()}`;
  }
  const fracStr = frac.toString().padStart(9, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole.toString()}.${fracStr}`;
}

export function lamportsToString(lamports: bigint | number | string | null): string | null {
  if (lamports === null) return null;
  return toLamports(lamports).toString();
}

export function solToLamports(sol: string): bigint {
  const trimmed = sol.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
    throw new RangeError(`Invalid SOL string: "${sol}"`);
  }
  const negative = trimmed.startsWith('-');
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const [whole, frac = ''] = unsigned.split('.');
  if (frac.length > 9) {
    throw new RangeError(`SOL has more than 9 fractional digits: "${sol}"`);
  }
  const fracPadded = frac.padEnd(9, '0');
  const lamports = BigInt(whole ?? '0') * LAMPORTS_PER_SOL + BigInt(fracPadded || '0');
  return negative ? -lamports : lamports;
}
