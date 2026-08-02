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

export declare function sanitizeModelText(value: unknown, max?: number): string;
export declare function sanitizeList(value: unknown, maxItems?: number, maxString?: number): string[];

export declare function applyMechanicalDowngrades(
  lane: string,
  flags: RedFlag[],
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
  state?: { hash: string; lane: string };
}): string;

export declare function runGate(
  dir: string,
  env?: Record<string, string | undefined>,
  fetchImpl?: typeof fetch,
): Promise<number>;
