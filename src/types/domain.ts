/**
 * Domain types for the Solana validator indexer.
 *
 * Lamports are represented as bigint in-memory and as decimal string at
 * API boundaries.
 *
 * This file is a thin barrel (TS-M1): the actual interface definitions
 * live in concern-grouped sub-modules under `src/types/domain/`. It
 * re-exports `domain/index.js` so every existing `../types/domain.js`
 * import keeps resolving the same names — add new types to the relevant
 * `domain/` sub-module, not here.
 */

export * from './domain/index.js';
