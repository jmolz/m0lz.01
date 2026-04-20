import { existsSync, readdirSync, readFileSync, readlinkSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..');
const PLUGIN_DIR = resolve(ROOT, '.claude-plugin');
const PLUGIN_JSON = resolve(PLUGIN_DIR, 'plugin.json');
const SKILL_DIR = resolve(PLUGIN_DIR, 'skills', 'blog');
const SKILL_MD = resolve(SKILL_DIR, 'SKILL.md');
const CONTRIBUTOR_SYMLINK = resolve(ROOT, '.claude', 'skills', 'blog');

interface PluginManifest {
  name: string;
  version: string;
  description?: string;
  skills: { name: string; path: string }[];
}

describe('plugin manifest', () => {
  it('.claude-plugin/plugin.json is valid JSON and declares the blog skill', () => {
    const raw = readFileSync(PLUGIN_JSON, 'utf8');
    const manifest = JSON.parse(raw) as PluginManifest;
    expect(manifest.name).toBe('m0lz');
    expect(typeof manifest.version).toBe('string');
    expect(manifest.skills).toBeInstanceOf(Array);
    const blog = manifest.skills.find((s) => s.name === 'blog');
    expect(blog).toBeDefined();
    expect(blog?.path).toBe('skills/blog');
  });
});

describe('SKILL.md structure', () => {
  const body = readFileSync(SKILL_MD, 'utf8');

  it('frontmatter parses as YAML and has required fields', () => {
    const match = body.match(/^---\r?\n([\s\S]+?)\r?\n---/);
    expect(match).not.toBeNull();
    const fm = yaml.load(match![1]) as Record<string, unknown>;
    expect(fm.name).toBe('blog');
    expect(typeof fm.description).toBe('string');
    expect(typeof fm['allowed-tools']).toBe('string');
    expect(fm['allowed-tools']).toContain('Bash(blog:*)');
  });

  it('allowed-tools does NOT grant Write, Edit, or Bash(gh:*) — the gate stays CLI-enforced', () => {
    // These scopes would let the skill mutate plan/receipt/workspace state
    // without routing through `blog agent apply`, defeating the hash gate.
    // Keep this assertion strict — adding any of them back requires first
    // moving that mutation into the `blog` binary.
    const match = body.match(/^---\r?\n([\s\S]+?)\r?\n---/);
    const fm = yaml.load(match![1]) as Record<string, unknown>;
    const tools = fm['allowed-tools'] as string;
    expect(tools).not.toMatch(/\bWrite\b/);
    expect(tools).not.toMatch(/\bEdit\b/);
    expect(tools).not.toMatch(/\bBash\(gh:/);
  });

  it('body is ≤ 200 lines after the closing frontmatter delimiter', () => {
    const afterFm = body.split(/^---\s*$/m).slice(2).join('---\n');
    const lineCount = afterFm.split('\n').length;
    expect(lineCount).toBeLessThanOrEqual(200);
  });

  it('contains no `node -e`, `cat `, or `head ` invocations', () => {
    expect(body).not.toMatch(/!\s*`\s*node\s+-e/);
    expect(body).not.toMatch(/!\s*`\s*cat\s+/);
    expect(body).not.toMatch(/!\s*`\s*head\s+/);
  });

  it('every read command uses --json', () => {
    // Match "blog status" or "blog <flow> show" inside backticks. For each
    // match, assert "--json" appears on the same line segment (between
    // opening and closing backticks).
    const backtickSegments = body.match(/`[^`]*`/g) ?? [];
    const readPattern = /\bblog\s+(status|publish\s+show|update\s+show|unpublish\s+show|evaluate\s+show|agent\s+preflight)\b/;
    for (const seg of backtickSegments) {
      if (readPattern.test(seg) && !seg.includes('--json')) {
        throw new Error(`read command without --json: ${seg}`);
      }
    }
  });

  it('destructive commands are only referenced inside blog agent apply handoffs', () => {
    // A "destructive reference" is a backtick segment containing one of these
    // command names. We allow them inside references to `blog agent apply`
    // handoff blocks (the skill explains what happens after apply runs) but
    // we require the top-level narrative commands to be `blog agent apply`,
    // not direct destructive calls.
    const destructivePattern = /\bblog\s+(publish\s+start|update\s+publish|update\s+start|update\s+benchmark|update\s+draft|update\s+evaluate|update\s+abort|unpublish\s+start|research\s+init|research\s+finalize|draft\s+init|draft\s+complete|evaluate\s+init|evaluate\s+complete|evaluate\s+reject|benchmark\s+init|benchmark\s+run|benchmark\s+complete)\b/;
    const inlineCodeSegments = body.match(/`[^`]*`/g) ?? [];
    // Any backtick segment mentioning a destructive command must also mention
    // "blog agent apply" — OR be inside a table/journey context that
    // describes what apply runs (REFERENCES.md + JOURNEYS.md links explain
    // those). We enforce the stricter rule: SKILL.md itself must not have a
    // bare `!`blog publish start …`` style exec. So we check only `!`…``
    // (executable) code fences, not descriptive ones.
    const execFences = body.match(/!\s*`[^`]*`/g) ?? [];
    for (const ex of execFences) {
      if (destructivePattern.test(ex) && !/blog\s+agent\s+apply/.test(ex)) {
        throw new Error(`bare destructive exec without blog agent apply: ${ex}`);
      }
    }
  });

  it('contains no hardcoded identity values', () => {
    expect(body).not.toMatch(/\bjmolz\b/);
    expect(body).not.toMatch(/\bm0lz\.dev\b/);
    expect(body).not.toMatch(/DEVTO_API_KEY\s*=\s*[^$]/);
  });
});

describe('sibling docs share the same discipline', () => {
  // Pre-Item 9 the smoke test only scanned SKILL.md. JOURNEYS.md ended up
  // documenting destructive commands as bare shell invocations and hardcoded
  // `jmolz` / `m0lz.dev`, contradicting the discipline SKILL.md enforced. This
  // block extends the same checks to JOURNEYS.md + CHECKPOINTS.md so any
  // future drift surfaces as a failing test, not as Codex/Claude review
  // feedback two rounds later.
  const siblings = ['JOURNEYS.md', 'CHECKPOINTS.md'];

  for (const sibling of siblings) {
    const body = readFileSync(resolve(SKILL_DIR, sibling), 'utf8');

    it(`${sibling} contains no bare destructive exec fences`, () => {
      // Same semantics as the SKILL.md check: only `!`…`` exec fences count.
      // Descriptive inline-code spans documenting plan-step payloads are
      // fine (the payload is DATA that only executes via `blog agent apply`).
      const destructivePattern = /\bblog\s+(publish\s+start|update\s+publish|update\s+start|update\s+benchmark|update\s+draft|update\s+evaluate|update\s+abort|unpublish\s+start|research\s+init|research\s+finalize|draft\s+init|draft\s+complete|evaluate\s+init|evaluate\s+complete|evaluate\s+reject|benchmark\s+init|benchmark\s+run|benchmark\s+complete)\b/;
      const execFences = body.match(/!\s*`[^`]*`/g) ?? [];
      for (const ex of execFences) {
        if (destructivePattern.test(ex) && !/blog\s+agent\s+apply/.test(ex)) {
          throw new Error(`${sibling}: bare destructive exec without blog agent apply: ${ex}`);
        }
      }
    });

    it(`${sibling} contains no hardcoded identity values`, () => {
      expect(body).not.toMatch(/\bjmolz\b/);
      expect(body).not.toMatch(/\bm0lz\.dev\b/);
      expect(body).not.toMatch(/DEVTO_API_KEY\s*=\s*[^$]/);
    });

    it(`${sibling} does not document Write/Edit/Bash(gh:*) scopes as skill-granted`, () => {
      // The skill's allowed-tools is `Bash(blog:*) Read Grep Glob`. Sibling
      // docs that tell operators "the skill uses Write/Edit" would contradict
      // the tightened scope and mislead about the trust boundary.
      expect(body).not.toMatch(/\ballowed-tools:[^\n]*\bWrite\b/);
      expect(body).not.toMatch(/\ballowed-tools:[^\n]*\bEdit\b/);
      expect(body).not.toMatch(/\ballowed-tools:[^\n]*\bBash\(gh:/);
    });
  }
});

describe('contributor symlink', () => {
  it('.claude/skills/blog resolves to the plugin skill directory', () => {
    expect(existsSync(CONTRIBUTOR_SYMLINK)).toBe(true);
    const target = readlinkSync(CONTRIBUTOR_SYMLINK);
    // Relative symlink — resolve against the symlink's dirname.
    const resolved = resolve(dirname(CONTRIBUTOR_SYMLINK), target);
    const expected = resolve(PLUGIN_DIR, 'skills', 'blog');
    expect(resolved).toBe(expected);
    expect(existsSync(resolve(CONTRIBUTOR_SYMLINK, 'SKILL.md'))).toBe(true);
  });
});

describe('packaging contract', () => {
  it('.claude-plugin/** is in package.json#files', () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as {
      files: string[];
    };
    expect(pkg.files).toContain('.claude-plugin/**');
  });

  it('REFERENCES.md, JOURNEYS.md, CHECKPOINTS.md exist alongside SKILL.md', () => {
    for (const f of ['REFERENCES.md', 'JOURNEYS.md', 'CHECKPOINTS.md']) {
      expect(statSync(resolve(SKILL_DIR, f)).isFile()).toBe(true);
    }
  });
});

describe('install-docs structural contract', () => {
  // docs/plugin-install.md makes three operational promises:
  //   (a) npm-bundled path: claude --plugin-dir $(npm root -g)/m0lz-01/.claude-plugin
  //   (b) repo-clone path:  claude --plugin-dir /abs/path/to/m0lz.01/.claude-plugin
  //   (c) contributor symlink: .claude/skills/blog -> ../../.claude-plugin/skills/blog
  //
  // A fresh Claude Code session following any of these must find:
  //   - <plugin-dir>/plugin.json with name + skills array (path "skills/blog")
  //   - <plugin-dir>/skills/blog/SKILL.md readable, frontmatter valid
  //   - every referenced sibling file present
  //
  // We can't spawn Claude Code itself from vitest, but we CAN verify every
  // structural precondition it would check. If this suite passes, the only
  // remaining failure modes are Claude-Code-runtime issues (outside our code)
  // or user path typos (outside our control).
  const INSTALL_DOCS = resolve(ROOT, 'docs/plugin-install.md');

  it('npm-bundled install path ships all required plugin files', () => {
    // The set of files the tarball will ship is determined by package.json#files
    // matched against paths on disk. Checking both directly is equivalent to
    // running `npm pack --dry-run` but without racing a parallel `npm run
    // build` in a sibling test suite (cli-templates-cwd-independence or
    // skill-fixture-integration rebuild dist in their beforeAll hooks; that
    // can make a concurrent `npm pack` non-deterministic).
    const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as {
      files: string[];
    };
    expect(pkg.files).toContain('.claude-plugin/**');

    const required = [
      '.claude-plugin/plugin.json',
      '.claude-plugin/skills/blog/SKILL.md',
      '.claude-plugin/skills/blog/REFERENCES.md',
      '.claude-plugin/skills/blog/JOURNEYS.md',
      '.claude-plugin/skills/blog/CHECKPOINTS.md',
    ];
    for (const f of required) {
      const onDisk = resolve(ROOT, f);
      expect(existsSync(onDisk), `required plugin file missing: ${f}`).toBe(true);
    }
  });

  it('plugin.json declares a readable SKILL.md at the documented path', () => {
    const manifest = JSON.parse(readFileSync(PLUGIN_JSON, 'utf8')) as PluginManifest;
    const blog = manifest.skills.find((s) => s.name === 'blog');
    expect(blog).toBeDefined();
    const skillRoot = resolve(PLUGIN_DIR, blog!.path);
    const skillMd = resolve(skillRoot, 'SKILL.md');
    expect(statSync(skillMd).isFile()).toBe(true);
    const body = readFileSync(skillMd, 'utf8');
    expect(body).toMatch(/^---\r?\n[\s\S]+?\r?\n---/);
  });

  it('install docs reference files that actually exist', () => {
    const docs = readFileSync(INSTALL_DOCS, 'utf8');
    const mentioned = [
      '.claude-plugin/',
      '.claude-plugin/plugin.json',
      '.claude-plugin/skills/blog',
      '.claude/skills/blog',
    ];
    for (const path of mentioned) {
      expect(docs, `install docs do not mention ${path}`).toContain(path);
    }
    expect(existsSync(CONTRIBUTOR_SYMLINK)).toBe(true);
  });
});

describe('skill-content identity hygiene', () => {
  // Recursive scan: every file under .claude-plugin/skills/ must be free of
  // hardcoded identity values. Content files flow straight into the operator's
  // Claude Code session, so baking author/site into them breaks the
  // "config-threaded identity" invariant the moment another author installs
  // the plugin.
  //
  // The plugin MANIFEST (.claude-plugin/plugin.json) is audited separately
  // below — it is the single file where author/homepage are legitimate,
  // non-threaded identity references (they describe the plugin itself, not
  // the operator's content).
  const IDENTITY_RE = /jmolz|m0lz\.dev|@molz|DEVTO_API_KEY\s*=\s*[^$]/i;

  function walk(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) out.push(...walk(full));
      else if (entry.isFile()) out.push(full);
    }
    return out;
  }

  it('no skill-content file hardcodes identity values', () => {
    const skillFiles = walk(SKILL_DIR);
    const violators: string[] = [];
    for (const f of skillFiles) {
      const body = readFileSync(f, 'utf8');
      if (IDENTITY_RE.test(body)) violators.push(f);
    }
    expect(violators).toEqual([]);
  });

  it('plugin.json only contains expected plugin-level identity (manifest, not content)', () => {
    // plugin.json is the legitimate carrier of author + homepage URLs —
    // these describe the plugin distribution itself, not any operator's
    // content. Whitelist exactly the fields where identity is allowed;
    // reject identity strings anywhere else (e.g., sneaked into description
    // or skills[].path).
    const manifest = JSON.parse(readFileSync(PLUGIN_JSON, 'utf8')) as Record<string, unknown>;
    const allowedIdentityFields = new Set(['author', 'homepage']);
    for (const [key, val] of Object.entries(manifest)) {
      if (allowedIdentityFields.has(key)) continue;
      const str = JSON.stringify(val);
      if (IDENTITY_RE.test(str)) {
        throw new Error(
          `plugin.json.${key} contains a hardcoded identity value: ${str}. ` +
            `Move to author/homepage, or remove.`,
        );
      }
    }
  });
});
