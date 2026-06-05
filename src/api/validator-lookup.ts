import type { ValidatorsRepository } from '../storage/repositories/validators.repo.js';
import type { Validator, VotePubkey } from '../types/domain.js';

/**
 * Resolve a validator from a vote-OR-identity pubkey: try the vote
 * index first, fall back to the identity index. Shared by every
 * `:idOrVote` route here AND by `/scoring` (scoring.route.ts) so the
 * "vote first, then identity" lookup lives in exactly one place.
 */
export async function findValidatorByVoteOrIdentity(
  validatorsRepo: Pick<ValidatorsRepository, 'findByVote' | 'findByIdentity'>,
  idOrVote: VotePubkey,
): Promise<Validator | null> {
  const byVote = await validatorsRepo.findByVote(idOrVote);
  if (byVote !== null) return byVote;
  return validatorsRepo.findByIdentity(idOrVote);
}
