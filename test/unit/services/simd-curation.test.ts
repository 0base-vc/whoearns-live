import { pino } from 'pino';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AnthropicClient } from '../../../src/clients/anthropic.js';
import {
  parseCurationOutput,
  SimdCurationService,
  SIMD_CURATION_SYSTEM_PROMPT,
} from '../../../src/services/simd-curation.service.js';
import type { SimdProposalsRepository } from '../../../src/storage/repositories/simd-proposals.repo.js';
import type { SimdProposal } from '../../../src/types/domain.js';

const silent = pino({ level: 'silent' });

const SAMPLE_PROPOSAL: SimdProposal = {
  simdNumber: 99,
  title: 'Test proposal',
  status: 'review',
  sourceUrl:
    'https://github.com/solana-foundation/solana-improvement-documents/blob/main/proposals/0099-test.md',
  bodySha256: 'abc',
  aiSummary: null,
  aiQuestions: null,
  aiGeneratedAt: null,
  reviewedAt: null,
  reviewedBy: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const WELL_FORMED_OUTPUT = `SUMMARY:
The SIMD bumps the per-block compute-unit limit from 60M to 100M.
Existing schedulers continue to apply. Validators that were already
running close to current 60M will see proportional pressure on
CPU and NVMe write paths.

QUESTIONS:
Q: How does this proposal change a validator's per-slot hardware load?
Q: What second-order effects on commission economics could land first?
Q: Which operator tiers (small vs large) take the asymmetric cost?`;

describe('parseCurationOutput', () => {
  it('parses a well-formed model response', () => {
    const out = parseCurationOutput(WELL_FORMED_OUTPUT);
    expect(out).not.toBeNull();
    expect(out!.summary).toMatch(/compute-unit limit from 60M to 100M/);
    expect(out!.questions.length).toBe(3);
    expect(out!.questions[0]).toMatch(/per-slot hardware load/);
  });

  it('rejects responses missing the SUMMARY header', () => {
    expect(parseCurationOutput('just questions\nQ: x\nQ: y\nQ: z')).toBeNull();
  });

  it('rejects responses with too few questions', () => {
    const bad = `SUMMARY:\nfoo\n\nQUESTIONS:\nQ: only one`;
    expect(parseCurationOutput(bad)).toBeNull();
  });

  it('rejects responses with too many questions', () => {
    const bad = `SUMMARY:\nfoo\n\nQUESTIONS:\nQ: a\nQ: b\nQ: c\nQ: d\nQ: e\nQ: f`;
    expect(parseCurationOutput(bad)).toBeNull();
  });

  it('tolerates CRLF + leading whitespace', () => {
    const crlf = `   \r\n${WELL_FORMED_OUTPUT.replace(/\n/g, '\r\n')}`;
    expect(parseCurationOutput(crlf)).not.toBeNull();
  });

  it('rejects an oversized summary (>600 chars)', () => {
    const longSummary = 'word '.repeat(200);
    const bad = `SUMMARY:\n${longSummary}\n\nQUESTIONS:\nQ: a\nQ: b\nQ: c`;
    expect(parseCurationOutput(bad)).toBeNull();
  });

  it('rejects a summary containing voting recommendations', () => {
    const partisan = `SUMMARY:\nValidators should vote yes on this important proposal.\n\nQUESTIONS:\nQ: a\nQ: b\nQ: c`;
    expect(parseCurationOutput(partisan)).toBeNull();
  });

  it('rejects HTML / code chars in summary', () => {
    const html = `SUMMARY:\n<script>x</script>\n\nQUESTIONS:\nQ: a\nQ: b\nQ: c`;
    expect(parseCurationOutput(html)).toBeNull();
  });

  it('rejects HTML chars in any question', () => {
    const html = `SUMMARY:\nfoo\n\nQUESTIONS:\nQ: how does <img onerror=x> work?\nQ: b\nQ: c`;
    expect(parseCurationOutput(html)).toBeNull();
  });

  it('rejects partisan phrasing in any question', () => {
    const partisan = `SUMMARY:\nfoo\n\nQUESTIONS:\nQ: This must pass — what risks?\nQ: b\nQ: c`;
    expect(parseCurationOutput(partisan)).toBeNull();
  });
});

describe('SIMD_CURATION_SYSTEM_PROMPT', () => {
  it('forbids vote framing', () => {
    expect(SIMD_CURATION_SYSTEM_PROMPT).toMatch(/NEVER tell operators how to vote/);
  });
  it('requires Q: prefix and 3-5 questions', () => {
    expect(SIMD_CURATION_SYSTEM_PROMPT).toMatch(/3 to 5 DISCUSSION QUESTIONS/);
    expect(SIMD_CURATION_SYSTEM_PROMPT).toMatch(/starting with "Q: "/);
  });
});

class FakeAnthropic {
  outputs: string[] = [];
  calls: Array<{ system: string | undefined; userContent: string }> = [];
  errOnNext: Error | null = null;
  async messages(req: {
    system?: string;
    messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  }) {
    this.calls.push({ system: req.system, userContent: req.messages[0]?.content ?? '' });
    if (this.errOnNext !== null) {
      const e = this.errOnNext;
      this.errOnNext = null;
      throw e;
    }
    const text = this.outputs.shift() ?? '';
    return { text, stopReason: 'end_turn', inputTokens: 100, outputTokens: 200 };
  }
}

class FakeRepo {
  pending: SimdProposal[] = [];
  curationsApplied: Array<{ simdNumber: number; aiSummary: string; aiQuestions: string[] }> = [];
  async listNeedingCuration(): Promise<SimdProposal[]> {
    return this.pending;
  }
  async setAiCuration(args: {
    simdNumber: number;
    aiSummary: string;
    aiQuestions: readonly string[];
  }): Promise<void> {
    this.curationsApplied.push({
      simdNumber: args.simdNumber,
      aiSummary: args.aiSummary,
      aiQuestions: [...args.aiQuestions],
    });
  }
}

describe('SimdCurationService.runOnce', () => {
  let anthropic: FakeAnthropic;
  let repo: FakeRepo;
  let svc: SimdCurationService;

  beforeEach(() => {
    anthropic = new FakeAnthropic();
    repo = new FakeRepo();
    svc = new SimdCurationService({
      anthropic: anthropic as unknown as AnthropicClient,
      repo: repo as unknown as SimdProposalsRepository,
      logger: silent,
    });
  });

  it('writes parsed curation for a well-formed model response', async () => {
    repo.pending = [SAMPLE_PROPOSAL];
    anthropic.outputs = [WELL_FORMED_OUTPUT];
    const result = await svc.runOnce(1);
    expect(result.curated).toBe(1);
    expect(repo.curationsApplied.length).toBe(1);
    expect(repo.curationsApplied[0]!.aiQuestions.length).toBe(3);
  });

  it('skips proposals whose model output is unparseable', async () => {
    repo.pending = [SAMPLE_PROPOSAL];
    anthropic.outputs = ['garbage with no SUMMARY: header'];
    const result = await svc.runOnce(1);
    expect(result.curated).toBe(0);
    expect(repo.curationsApplied.length).toBe(0);
  });

  it('swallows per-proposal anthropic errors and continues', async () => {
    repo.pending = [SAMPLE_PROPOSAL];
    anthropic.errOnNext = new Error('anthropic down');
    const result = await svc.runOnce(1);
    expect(result.curated).toBe(0);
  });
});
