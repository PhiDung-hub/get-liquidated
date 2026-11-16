import { z } from 'zod';

export const INTERVALS = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '8h', '12h', '1d', '3d', '1w', '1M'] as const;
export type Interval = (typeof INTERVALS)[number];
// The shape only: Hyperliquid decides which intervals exist, so a pinned companion never refuses a newer one.
export const interval = z.string().regex(/^[1-9]\d{0,2}[mhdwM]$/);

export type Side = 'buy' | 'sell';
export type Status = 'open' | 'used' | 'dismissed' | 'later' | 'expired' | 'withdrawn';
export type Action = 'used' | 'dismissed' | 'later';
export type Suggestion = {
  id: string; coin: string; side: Side; kind: 'market' | 'limit'; px: number | null; size: number; unit: 'coin' | 'usd';
  tp: number | null; sl: number | null; reason: string; confidence: number; created: number; expires: number; status: Status; acted: number | null;
};
export type Mark = { id: string; coin: string; type: 'level' | 'zone' | 'bias'; a: number | null; b: number | null; label: string; tone?: 'neutral' | 'support' | 'resistance' | 'invalidation'; author?: 'user' | 'ai' | null; interval?: string | null; t0?: number | null; t1?: number | null; created: number; expires: number };
/** A file the user attached to a question, as the browser and the AI see it; the bytes stay in the database and are read with the attachment tool. */
export type Attachment = { id: string; name: string; type: 'image/jpeg' | 'image/png' | 'text/plain'; size: number };
export const ATTACHMENT_EXPIRED = 'attachment expired; attach again';
const attachments = z.array(z.string().uuid()).min(1).max(4).optional();
export type AnnotationChat = { mark: Mark; messages: { id: string; role: 'user' | 'assistant'; text: string; created: number; replyTo?: string; attachments?: Attachment[] }[]; updated: number };

export const stage = z.enum(['unconscious-incompetence', 'conscious-incompetence', 'conscious-competence', 'unconscious-competence']);
const annotationMessage = z.object({ markId: z.string().uuid(), message: z.string().trim().min(1).max(1000) }).strict();
export const annotationQuestion = annotationMessage.extend({ attachments });
export const annotationReply = annotationMessage.extend({ questionId: z.string().uuid() });
export type AnnotationQuestion = z.infer<typeof annotationQuestion>;
export type AnnotationReply = z.infer<typeof annotationReply>;
const YEAR = 365 * 86_400_000;
const num = z.number().finite();
const px = num.positive();
const ms = z.number().int().nonnegative();
const side = z.enum(['buy', 'sell']);
const text = (max: number) => z.string().max(max).regex(/^[^\u0000-\u001f]*$/);
/** What the browser drew inside the user's point or zone, kept with the mark for the local AI. Untrusted: it is what the page saw, never proof, and it must hold no keys. */
export const selectionContext = z.object({
  candles: z.array(z.tuple([ms, px, px, px, px, num.nonnegative()])).max(200),
  omitted: z.number().int().min(1).max(100_000).optional(),
  indicators: z.array(z.object({ name: text(20).min(1), values: z.array(num.nullable()).max(200) }).strict()).max(12),
  orders: z.array(z.object({ side, type: text(30), px, trigger: px.optional(), size: num.nonnegative(), reduceOnly: z.boolean() }).strict()).max(50),
  position: z.object({ side: z.enum(['long', 'short']), size: px, entry: px, liq: px.nullable(), mfe: px.optional(), mae: px.optional() }).strict().optional(),
  fills: z.array(z.object({ t: ms, side, px, size: px, dir: text(40), closedPnl: num }).strict()).max(50),
  drawings: z.array(z.object({ kind: z.enum(['h', 'v', 'trend', 'fib']), pts: z.array(z.object({ t: ms, p: px }).strict()).min(1).max(2) }).strict()).max(20),
  aiMarks: z.array(z.object({ type: z.enum(['level', 'zone']), a: px, b: px.nullable(), label: text(60) }).strict()).max(20)
}).strict()
  .refine((c) => c.indicators.every((i) => i.values.length === c.candles.length), 'indicator values must align with the candles')
  .refine((c) => !/[0-9a-fA-F]{64}/.test(JSON.stringify(c)), 'context must not contain keys');
export type SelectionContext = z.infer<typeof selectionContext>;
export const userMarkInput = z.object({
  coin: z.string().trim().min(1).max(40),
  interval,
  type: z.enum(['level', 'zone']),
  a: z.number().positive().finite(),
  b: z.number().positive().finite().optional(),
  t0: z.number().int(),
  t1: z.number().int(),
  message: z.string().trim().min(1).max(1000),
  context: selectionContext.optional(),
  attachments
}).strict()
  .refine((m) => (m.type === 'zone') === (m.b !== undefined), 'a zone needs b; a level must not have it')
  .refine((m) => m.t0 <= m.t1 && m.t0 > Date.now() - YEAR && m.t1 < Date.now() + 86_400_000, 't0..t1 must be a range within the last year');
export type UserMarkInput = z.input<typeof userMarkInput>;
export const clientSession = z.object({
  client: z.enum(['codex', 'claude-code', 'other']),
  sessionId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/).optional(),
  status: z.enum(['active', 'idle', 'ended']),
  terminal: z.boolean().optional().describe('Allow this paired browser to send prompts to this session through Agent OS. Requires a resumable session ID and Agent OS running locally; false disables it.'),
  localUrl: z.string().max(200).refine((value) => {
    try {
      const url = new URL(value);
      return ['http:', 'https:'].includes(url.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
        && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash;
    } catch { return false; }
  }).optional()
}).strict();
export type ClientSessionInput = z.infer<typeof clientSession>;
export type ClientSession = ClientSessionInput & { at: number };
export const terminalInput = z.object({
  id: z.string().uuid(), client: z.enum(['codex', 'claude-code']), sessionId: z.string().regex(/^[a-zA-Z0-9-]{1,100}$/),
  message: z.string().trim().min(1).max(2000).regex(/^[^\u0000-\u0008\u000b-\u001f\u007f]*$/),
  attachments
}).strict();
export type TerminalInput = z.infer<typeof terminalInput>;
export type TerminalCommand = Omit<TerminalInput, 'attachments'> & { attachments?: Attachment[]; created: number; updated: number; status: 'sending' | 'sent' | 'received' | 'replied' | 'failed'; reply?: string; error?: string };
export const chartContext = z.object({
  coin: z.string().trim().min(1).max(40),
  account: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  interval,
  timezone: z.string().max(80).refine((value) => {
    try { new Intl.DateTimeFormat('en', { timeZone: value }).format(0); return true; }
    catch { return false; }
  }).optional(),
  indicators: z.array(z.string().max(40)).max(20),
  aiMarks: z.boolean(),
  adviceNotifications: z.boolean(),
  hotkeys: z.array(z.object({ id: z.string().max(40), label: z.string().max(100), keys: z.array(z.string().max(40)).max(8), gate: z.enum(['A', 'R', 'X']) }).strict()).max(100)
}).strict();

export const observationInput = z.object({
  kind: z.enum(['advice', 'reflection', 'practice']),
  coin: z.string().trim().min(1).max(40).optional(),
  skill: z.string().trim().min(1).max(80),
  stage: stage.optional().describe('Evidence-based hypothesis for this skill, not a global rating'),
  evidence: z.string().trim().min(1).max(1500).describe('Observed facts with timestamps or fill references; distinguish user reports and hypotheses'),
  advice: z.string().trim().min(1).max(1500),
  nextStep: z.string().trim().min(1).max(500),
  expiresMin: z.number().int().min(1).max(1440).default(60)
}).strict();
export type ChartContext = z.infer<typeof chartContext>;
export type ObservationInput = z.infer<typeof observationInput>;
export type Observation = Omit<ObservationInput, 'expiresMin'> & { id: string; created: number; expires: number };

export const coin = z.string().trim().min(1).max(40).describe('HL perp name: BTC, kPEPE, or dex:COIN for HIP-3 (xyz:NVDA)');
const price = z.number().positive();
const expiresMin = z.number().int().min(1).max(1440).default(60).describe('Minutes until it leaves the screen');

export const suggestInput = z.object({
  coin,
  side: z.enum(['buy', 'sell']),
  kind: z.enum(['market', 'limit']),
  px: price.optional().describe('Limit price; required for limit, ignored for market'),
  size: z.number().positive(),
  unit: z.enum(['coin', 'usd']).describe('Size in coins or in USD notional'),
  tp: price.optional().describe('Take profit; beyond px (or the mark for market) in the trade direction'),
  sl: price.optional().describe('Stop loss; on the other side of px (or the mark for market)'),
  reason: z.string().trim().min(1).max(1000),
  confidence: z.number().min(0).max(1),
  expiresMin
});

export const markInput = z.object({
  coin,
  type: z.enum(['level', 'zone', 'bias']).describe('level: a line at a; zone: a band from a to b; bias: a label only'),
  a: price.optional(),
  b: price.optional(),
  label: z.string().trim().min(1).max(60),
  tone: z.enum(['neutral', 'support', 'resistance', 'invalidation']).default('neutral'),
  expiresMin
});
export type SuggestInput = z.infer<typeof suggestInput>;
export type MarkInput = z.infer<typeof markInput>;
