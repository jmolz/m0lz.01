import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';

import { BlogConfig } from '../config/types.js';

// Append or replace an update-notice block in an MDX file.
//
// The marker is an HTML comment block so MDX parsers pass it through
// unchanged:
//
//   <!-- update-notice cycle=3 date=2026-04-17 -->
//   Updated 2026-04-17: Re-ran Q2 benchmarks on Node 24.
//   <!-- /update-notice -->
//
// Identity is keyed on **cycle**, not date. Re-running within the same
// open cycle replaces the body (even if the calendar date crosses
// midnight between runs); re-running across cycles appends a new block
// after the prior ones, preserving historical notices.
//
// Template comes from `config.updates.notice_template` with `{DATE}`
// and `{SUMMARY}` placeholders. Summary may be null; we render "(no
// summary)" as a sentinel so readers always see framing for the block.
//
// Write is atomic: temp file + rename. MDX is user-visible on the site,
// so a partially-written file on a process crash is a user-facing
// artifact.

const NOTICE_BLOCK_PATTERN =
  /<!-- update-notice cycle=(\d+) date=(\d{4}-\d{2}-\d{2}) -->\r?\n([\s\S]*?)\r?\n<!-- \/update-notice -->/g;

const ANY_NOTICE_BLOCK_PATTERN =
  /<!-- update-notice cycle=\d+ date=\d{4}-\d{2}-\d{2} -->\r?\n[\s\S]*?\r?\n<!-- \/update-notice -->/g;

function renderBody(
  cycleId: number,
  date: string,
  summary: string | null,
  template: string,
): string {
  const safeSummary = summary && summary.trim().length > 0 ? summary : '(no summary)';
  return template
    .replace(/\{DATE\}/g, date)
    .replace(/\{SUMMARY\}/g, safeSummary);
}

function buildBlock(
  cycleId: number,
  date: string,
  summary: string | null,
  template: string,
): string {
  const body = renderBody(cycleId, date, summary, template);
  return (
    `<!-- update-notice cycle=${cycleId} date=${date} -->\n` +
    `${body}\n` +
    `<!-- /update-notice -->`
  );
}

function atomicWrite(targetPath: string, content: string): void {
  const tmp = join(dirname(targetPath), `.${basename(targetPath)}.tmp`);
  writeFileSync(tmp, content, 'utf-8');
  renameSync(tmp, targetPath);
}

export interface AppendUpdateNoticeResult {
  action: 'replaced' | 'appended' | 'unchanged';
  blockCount: number; // Total notice blocks in the file after the write
}

export function appendUpdateNotice(
  mdxPath: string,
  cycleId: number,
  date: string,
  summary: string | null,
  config: BlogConfig,
): AppendUpdateNoticeResult {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(
      `appendUpdateNotice: date must be YYYY-MM-DD, got '${date}'`,
    );
  }
  if (!Number.isInteger(cycleId) || cycleId < 1) {
    throw new Error(
      `appendUpdateNotice: cycleId must be a positive integer, got ${cycleId}`,
    );
  }

  const original = readFileSync(mdxPath, 'utf-8');
  const template = config.updates.notice_template;
  const newBlock = buildBlock(cycleId, date, summary, template);

  // Look for an existing block for this cycle. `.matchAll` lets us find
  // all blocks in one pass; we filter for the one with matching cycleId.
  const existingBlocks = [...original.matchAll(NOTICE_BLOCK_PATTERN)];
  const sameCycleMatch = existingBlocks.find(
    (m) => parseInt(m[1], 10) === cycleId,
  );

  if (sameCycleMatch) {
    const start = sameCycleMatch.index ?? 0;
    const end = start + sameCycleMatch[0].length;
    const before = original.slice(0, start);
    const after = original.slice(end);
    const rebuilt = before + newBlock + after;
    if (rebuilt === original) {
      return { action: 'unchanged', blockCount: existingBlocks.length };
    }
    atomicWrite(mdxPath, rebuilt);
    return { action: 'replaced', blockCount: existingBlocks.length };
  }

  // No block for this cycle — append after any existing notice blocks so
  // the most recent update notice appears at the end of the prior chain.
  // If there are no prior blocks, append to the end of the file with one
  // blank line of separation.
  if (existingBlocks.length === 0) {
    const trimmed = original.replace(/\s+$/, '');
    const rebuilt = `${trimmed}\n\n${newBlock}\n`;
    atomicWrite(mdxPath, rebuilt);
    return { action: 'appended', blockCount: 1 };
  }

  // Find the position immediately after the last existing block and insert
  // the new block there, separated by a blank line.
  const last = existingBlocks[existingBlocks.length - 1];
  const insertAt = (last.index ?? 0) + last[0].length;
  const before = original.slice(0, insertAt);
  const after = original.slice(insertAt);
  const rebuilt = `${before}\n\n${newBlock}${after}`;
  atomicWrite(mdxPath, rebuilt);
  return { action: 'appended', blockCount: existingBlocks.length + 1 };
}

// Utility for tests and future use: count update-notice blocks in an MDX
// string. Exported so diagnostic commands can report the shape without
// re-deriving the regex.
export function countUpdateNotices(mdxContent: string): number {
  return [...mdxContent.matchAll(ANY_NOTICE_BLOCK_PATTERN)].length;
}
