/**
 * Domain-types barrel.
 *
 * Split (TS-M1) from a single 750-line `domain.ts` into concern-grouped
 * sub-modules — `validators` carries the base scalar aliases every other
 * module depends on, the rest sit downstream of it (one-directional
 * `import type`, no runtime cycle). `src/types/domain.ts` re-exports
 * this barrel so the 50 existing `../types/domain.js` imports keep
 * working unchanged.
 */

export * from './validators.js';
export * from './claim.js';
export * from './simd.js';
export * from './wallet.js';
export * from './epoch.js';
export * from './oai.js';
