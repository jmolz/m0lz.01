import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..');
const RULE_PATH = resolve(ROOT, '.claude/rules/voice.md');
const PLUGIN_PATH = resolve(ROOT, '.claude-plugin/skills/blog/VOICE.md');

// Strip the YAML frontmatter block from the top of a markdown file. The dev
// rule file has frontmatter (`paths:` for auto-loading); the plugin file
// doesn't (plugin skills don't use path scoping). Body content must match
// byte-for-byte so the two files never drift.
function stripFrontmatter(md: string): string {
  const match = md.match(/^---\r?\n[\s\S]+?\r?\n---\r?\n([\s\S]*)$/);
  return match ? match[1] : md;
}

describe('voice.md parity', () => {
  it('dev rule body byte-equals plugin VOICE.md', () => {
    const ruleBody = stripFrontmatter(readFileSync(RULE_PATH, 'utf8'));
    const pluginBody = readFileSync(PLUGIN_PATH, 'utf8');
    expect(pluginBody).toBe(ruleBody);
  });

  it('dev rule has path-scoped frontmatter', () => {
    const raw = readFileSync(RULE_PATH, 'utf8');
    expect(raw).toMatch(/^---\r?\n/);
    expect(raw).toMatch(/paths:\s*\n(\s+- "[^"]+"\r?\n)+---/);
  });

  it('plugin file has no frontmatter (plugin skills do not path-scope)', () => {
    const raw = readFileSync(PLUGIN_PATH, 'utf8');
    expect(raw.startsWith('---')).toBe(false);
    expect(raw.startsWith('# Voice')).toBe(true);
  });

  it('plugin VOICE.md is free of identity strings (skill-content hygiene)', () => {
    // Duplicate of the skill-smoke identity scan, scoped to VOICE.md specifically
    // so a failure points at the right file. Keeping this redundant assertion
    // because VOICE.md is the prose-richest plugin file and most likely to
    // acquire an identity leak in a future edit.
    const body = readFileSync(PLUGIN_PATH, 'utf8');
    expect(body).not.toMatch(/jmolz|m0lz\.dev|@molz|DEVTO_API_KEY\s*=/i);
  });
});
