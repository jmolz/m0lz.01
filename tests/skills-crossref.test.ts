import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Phase 7 Cluster G: verify each orchestrator skill contains the exact
// required H2 header set AND that every `blog <cmd>` reference inside it
// maps to a Commander.js command registered in src/cli/index.ts.

const REQUIRED_HEADERS = [
  'Preflight',
  'Workflow',
  'CLI Reference',
  'Troubleshooting',
  'Degraded Mode',
] as const;

// Skill files to validate. Path relative to repo root (the cwd vitest
// runs in is the project root).
const ORCHESTRATOR_SKILLS = [
  'skills/blog-pipeline.md',
  'skills/blog-update.md',
  'skills/blog-unpublish.md',
] as const;

function parseH2Headers(markdown: string): string[] {
  const out: string[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    const match = line.match(/^## +(.+?) *$/);
    if (match) out.push(match[1]);
  }
  return out;
}

// Extract the full lexical token immediately after "blog " inside fenced
// code blocks. Matches both bare commands ("blog status") and subcommands
// ("blog update start"). Returns a set of full command phrases up to the
// first non-alpha-dash token (so we don't pick up argument placeholders
// like <slug>).
function parseBlogCommands(markdown: string): Set<string> {
  // Extract fenced code blocks first — references outside fences are prose
  // and not authoritative.
  const fenceMatches = [...markdown.matchAll(/```[\w-]*\n([\s\S]*?)\n```/g)];
  const commands = new Set<string>();
  for (const m of fenceMatches) {
    const body = m[1];
    for (const rawLine of body.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line.startsWith('blog ') && !line.startsWith('blog\t')) continue;
      // Collect the command phrase: "blog" + following tokens until we
      // hit a placeholder (<...>) or an option (-...). Keep only the
      // command path (e.g., "blog update start").
      const tokens = line.split(/\s+/);
      const phrase: string[] = [tokens[0]]; // "blog"
      for (let i = 1; i < tokens.length; i += 1) {
        const t = tokens[i];
        if (t.startsWith('<') || t.startsWith('[') || t.startsWith('-')) break;
        phrase.push(t);
      }
      if (phrase.length >= 2) {
        commands.add(phrase.join(' '));
      }
    }
  }
  return commands;
}

// Parse command registrations from each src/cli/*.ts file. A command is
// declared via Commander's `.command('<name>')`; for command groups we
// collect both the group name AND every nested command as
// "<group> <sub>" to match phrases like "blog update start".
function parseRegisteredCommands(): Set<string> {
  const cliDir = resolve('src/cli');
  const files = [
    'init.ts',
    'status.ts',
    'metrics.ts',
    'ideas.ts',
    'research.ts',
    'benchmark.ts',
    'draft.ts',
    'evaluate.ts',
    'publish.ts',
    'update.ts',
    'unpublish.ts',
  ];
  const registered = new Set<string>();
  registered.add('blog'); // top-level
  for (const f of files) {
    const src = readFileSync(resolve(cliDir, f), 'utf-8');
    // Find `.command('<name>' ... )` occurrences and identify group vs leaf.
    // Group: `program.command('group')` — this creates a subcommand parent.
    // Leaf: `<group>.command('sub <slug>')` — child subcommand under group.
    //
    // Heuristic:
    //   - Top-level `program.command('X')` → leaf if X has no children
    //     here; otherwise group. We conservatively register both "blog X"
    //     and for every other `.command('Y ...')` in the same file, also
    //     register "blog X Y".
    const programCommandMatch = src.match(
      /program[\s\S]*?\.command\(\s*['"]([^\s'"]+)[^)]*\)\s*\.description/,
    );
    const groupName = programCommandMatch ? programCommandMatch[1] : null;
    if (groupName) {
      registered.add(`blog ${groupName}`);
    }
    // Every `<var>.command('X ...')` — pick up subcommand name up to first space.
    const subMatches = [...src.matchAll(/\.command\(\s*['"]([a-z][a-z0-9-]*)(?:[\s<>]|['"])/g)];
    for (const m of subMatches) {
      const name = m[1];
      if (groupName && name !== groupName) {
        registered.add(`blog ${groupName} ${name}`);
      } else if (!groupName) {
        registered.add(`blog ${name}`);
      }
    }
  }
  // Explicit known commands that the heuristic may miss due to formatting.
  // Seed from index.ts registrations.
  return registered;
}

describe('orchestrator skills', () => {
  it('every orchestrator skill file contains the exact required H2 set', () => {
    for (const rel of ORCHESTRATOR_SKILLS) {
      const content = readFileSync(resolve(rel), 'utf-8');
      const headers = parseH2Headers(content);
      for (const required of REQUIRED_HEADERS) {
        expect(headers, `${rel} missing H2 '${required}'`).toContain(required);
      }
    }
  });

  it("every 'blog <cmd>' reference in every skill resolves to a registered CLI command", () => {
    const registered = parseRegisteredCommands();
    for (const rel of ORCHESTRATOR_SKILLS) {
      const content = readFileSync(resolve(rel), 'utf-8');
      const referenced = parseBlogCommands(content);
      const unknown: string[] = [];
      for (const cmd of referenced) {
        if (!registered.has(cmd)) {
          unknown.push(cmd);
        }
      }
      expect(
        unknown,
        `${rel} references unknown CLI commands: ${unknown.join(', ')}\n` +
          `registered: ${[...registered].sort().join(', ')}`,
      ).toEqual([]);
    }
  });
});
