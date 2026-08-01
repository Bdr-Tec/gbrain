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
export declare function renderComment(input: {
  lane?: string;
  verdict?: { confidence: number; reasons: string[]; reviewer_checklist: string[] };
  titleCheck: TitleCheck;
  flags: RedFlag[];
  neutralReason?: string;
}): string;
