/** Type surface of scripts/pr-gate.mjs for test/pr-gate-workflow.test.ts (tsc-only). */
export interface TitleCheck {
  ok: boolean;
  reason?: string;
}
export declare function checkTitle(title: string): TitleCheck;

export interface ChangedFile {
  filename: string;
  status: string;
  patch?: string;
  additions?: number;
  deletions?: number;
}
export interface RedFlag {
  id: string;
  detail: string;
}
export declare function detectRedFlags(input: {
  changedFiles: number;
  files: ChangedFile[];
  diff: string;
}): RedFlag[];

export declare const RUBRIC: string;
export declare const MAX_STRING: number;
export declare const MAX_ITEMS: number;
export declare const NET_SOURCE_LINE_LIMIT: number;
export declare const DOWNGRADE_FLAG_IDS: string[];

/** CONTRIBUTING.md #3745: human-written intent paragraph + screenshot of gbrain in use. */
export declare const CONTRIBUTING_URL: string;
export declare const INTENT_MIN_WORDS: number;
export declare const POLICY_FLAG_IDS: string[];
export declare const AI_INTENT_DOWNGRADE: string;
export declare function stripCodeFences(body: unknown): string;
export declare function hasScreenshot(body: unknown): boolean;
export declare function intentWordCount(body: unknown): number;
export declare function hasIntentParagraph(body: unknown): boolean;
export declare function detectPolicyMisses(body: unknown): RedFlag[];

export declare function sanitizeModelText(value: unknown, max?: number): string;
export declare function sanitizeList(value: unknown, maxItems?: number, maxString?: number): string[];

export declare function applyMechanicalDowngrades(
  lane: string,
  flags: RedFlag[],
  intentAuthenticity?: string,
): { lane: string; downgrades: string[] };

export interface GhComment {
  id?: number;
  body?: unknown;
  user?: { type?: string; login?: string };
}
export declare function isOwnComment(comment: GhComment | null | undefined): boolean;

export declare function hashInputs(pr: {
  title?: string;
  body?: string;
  head?: { sha?: string };
}): string;
export declare function parseState(body: unknown): { hash: string; lane?: string } | null;

export declare function renderComment(input: {
  lane?: string;
  verdict?: { confidence?: number; reasons?: unknown; reviewer_checklist?: unknown };
  titleCheck: TitleCheck;
  flags: RedFlag[];
  neutralReason?: string;
  downgrades?: string[];
  policyMisses?: RedFlag[];
  state?: { hash: string; lane: string };
}): string;

export declare function runGate(
  dir: string,
  env?: Record<string, string | undefined>,
  fetchImpl?: typeof fetch,
): Promise<number>;
