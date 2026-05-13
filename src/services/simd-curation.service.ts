import type { AnthropicClient } from '../clients/anthropic.js';
import type { Logger } from '../core/logger.js';
import type { SimdProposalsRepository } from '../storage/repositories/simd-proposals.repo.js';

export interface SimdCurationDeps {
  anthropic: Pick<AnthropicClient, 'messages'>;
  repo: Pick<SimdProposalsRepository, 'listNeedingCuration' | 'setAiCuration'>;
  logger: Logger;
  /** Optional override for the curation system prompt. */
  systemPrompt?: string;
}

/**
 * The system prompt lives in `prompts/simd-curation.md` for auditability.
 * The string below MUST be kept in sync. Tests verify the constraint
 * lines exist; production reads from disk via `loadSimdCurationPrompt()`
 * (called once at boot) so any deploy can audit what the model saw.
 */
export const SIMD_CURATION_SYSTEM_PROMPT = `You are a neutral technical writer summarising Solana governance proposals (SIMDs) for validator operators who run mainnet nodes.

Your output goes on a public dashboard where operators read it before deciding whether to vote-by-stake. Operators trust this dashboard to be even-handed.

Hard constraints:

1. NEVER tell operators how to vote. NEVER frame the SIMD as good or bad, beneficial or harmful, safe or risky in absolute terms.
2. Write in third person. No "you should", "we recommend", "this helps you".
3. Output exactly two artefacts, in this order:
   - A 50-WORD plain-text summary of what the SIMD changes. Plain facts only — what bits flip, what number moves, what code path changes. No "this addresses the issue of…" framing.
   - 3 to 5 DISCUSSION QUESTIONS, each starting with "Q: ". Questions must surface operational trade-offs, both directions. For each question, both a SUPPORTER and an OPPONENT of the SIMD must be able to answer honestly without compromising their position.

Forbidden question framings:
   - "Should this pass?"
   - "Is this a good change?"
   - "Why is this important?"
   - Anything with built-in positive or negative valence.

Required question framings: cost, risk, asymmetric impact between operator tiers, edge cases, second-order effects on neighbouring protocols / clients / commission economics.

4. If the source content is ambiguous or you can't ground a claim, say so explicitly. Do not invent specifications.

Output format — exactly:

SUMMARY:
<50 words>

QUESTIONS:
Q: <question 1>
Q: <question 2>
Q: <question 3>
[Q: <question 4>]
[Q: <question 5>]
`;

export interface CurationOutput {
  summary: string;
  questions: string[];
}

/**
 * Parse the model output. Tolerant of whitespace and leading/trailing
 * fluff; rejects clearly-malformed responses so the repo write skips
 * them rather than persisting garbage that needs a manual fix.
 */
export function parseCurationOutput(raw: string): CurationOutput | null {
  const cleaned = raw.replace(/\r\n/g, '\n').trim();
  const summaryMatch = /SUMMARY:\s*([\s\S]*?)\n\s*QUESTIONS:/i.exec(cleaned);
  if (summaryMatch === null) return null;
  const summary = (summaryMatch[1] ?? '').trim();
  if (summary.length === 0) return null;
  const questionsMatch = /QUESTIONS:\s*([\s\S]+)$/i.exec(cleaned);
  if (questionsMatch === null) return null;
  const lines = (questionsMatch[1] ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^Q:/i.test(l))
    .map((l) => l.replace(/^Q:\s*/i, '').trim())
    .filter((l) => l.length > 0);
  if (lines.length < 3 || lines.length > 5) return null;
  return { summary, questions: lines };
}

export class SimdCurationService {
  private readonly anthropic: Pick<AnthropicClient, 'messages'>;
  private readonly repo: Pick<SimdProposalsRepository, 'listNeedingCuration' | 'setAiCuration'>;
  private readonly logger: Logger;
  private readonly systemPrompt: string;

  constructor(deps: SimdCurationDeps) {
    this.anthropic = deps.anthropic;
    this.repo = deps.repo;
    this.logger = deps.logger;
    this.systemPrompt = deps.systemPrompt ?? SIMD_CURATION_SYSTEM_PROMPT;
  }

  /**
   * Process at most `limit` un-curated proposals. Returns the number
   * of successful writes — failures are logged but don't stop the
   * batch.
   */
  async runOnce(limit = 5): Promise<{ curated: number }> {
    const pending = await this.repo.listNeedingCuration(limit);
    let curated = 0;
    for (const proposal of pending) {
      try {
        const result = await this.anthropic.messages({
          system: this.systemPrompt,
          messages: [
            {
              role: 'user',
              content: `SIMD-${proposal.simdNumber}: ${proposal.title}\n\nSource: ${proposal.sourceUrl}\n\nProduce the SUMMARY + QUESTIONS in the exact format the system prompt specifies.`,
            },
          ],
          maxTokens: 800,
          temperature: 0.2,
        });
        const parsed = parseCurationOutput(result.text);
        if (parsed === null) {
          this.logger.warn(
            { simd: proposal.simdNumber, output: result.text.slice(0, 200) },
            'simd-curation: model output unparseable',
          );
          continue;
        }
        await this.repo.setAiCuration({
          simdNumber: proposal.simdNumber,
          aiSummary: parsed.summary,
          aiQuestions: parsed.questions,
        });
        curated += 1;
      } catch (err) {
        this.logger.warn(
          { err, simd: proposal.simdNumber },
          'simd-curation: failed for one proposal',
        );
      }
    }
    return { curated };
  }
}
