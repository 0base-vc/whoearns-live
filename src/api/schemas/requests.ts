import { z } from 'zod';
import { PubkeySchema } from './pubkey.js';

/**
 * Max number of votes accepted by the `POST /v1/validators/current-epoch/batch`
 * endpoint. Sized to comfortably fit the 100–200 validators a typical watcher
 * tracks in a single request while keeping pg IN(...) clauses bounded.
 */
export const BATCH_MAX_VOTES = 200;

export const VoteParamSchema = z.object({
  vote: PubkeySchema,
});

export const EpochNumberSchema = z.coerce
  .number()
  .int('epoch must be an integer')
  .nonnegative('epoch must be non-negative');

export const VoteAndEpochParamSchema = z.object({
  vote: PubkeySchema,
  epoch: EpochNumberSchema,
});

export const VoteOrIdentityAndEpochParamSchema = z.object({
  idOrVote: PubkeySchema,
  epoch: EpochNumberSchema,
});

export const BatchBodySchema = z.object({
  votes: z
    .array(PubkeySchema)
    .min(1, 'votes must contain at least 1 entry')
    .max(BATCH_MAX_VOTES, `votes must contain at most ${BATCH_MAX_VOTES} entries`),
});

export type BatchBody = z.infer<typeof BatchBodySchema>;

/**
 * Accepts either a vote pubkey or an identity pubkey — they share the
 * same base58/length shape. The route handler disambiguates by trying
 * the vote lookup first, then identity.
 */
export const VoteOrIdentityParamSchema = z.object({
  idOrVote: PubkeySchema,
});

export const HistoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
