# Installing the `/blog` Claude Code plugin

Three install paths, ordered from most common to least.

## (a) npm-bundled — recommended for end users

Install the CLI globally; the plugin ships inside the package tarball at
`.claude-plugin/`.

```bash
npm install -g m0lz-01
# or: pnpm add -g m0lz-01
# or: yarn global add m0lz-01

# Point Claude Code at the bundled plugin:
claude --plugin-dir "$(npm root -g)/m0lz-01/.claude-plugin"
# or with pnpm:
claude --plugin-dir "$(pnpm root -g)/m0lz-01/.claude-plugin"
```

Once loaded, `/blog <intent>` is available in any Claude Code session whose
cwd is inside a workspace (`.blog-agent/state.db` present) — or any cwd if
you pass `--workspace <path>` to the CLI.

## (b) Repo clone — for contributors not modifying the plugin

```bash
git clone https://github.com/jmolz/m0lz.01.git
cd m0lz.01
npm install
npm run build        # needed so `blog` resolves from dist/

# Optional: symlink or install globally
npm link

# Load the plugin from the clone:
claude --plugin-dir /absolute/path/to/m0lz.01/.claude-plugin
```

## (c) Contributor — working inside `m0lz.01` itself

The repo ships a relative symlink at `.claude/skills/blog` pointing at
`.claude-plugin/skills/blog`, so Claude Code sessions opened from inside
the repo auto-load `/blog` without `--plugin-dir`.

```bash
cd m0lz.01
claude .   # the symlink is auto-discovered
```

If the symlink is missing (some git clients drop symlinks), recreate it:

```bash
mkdir -p .claude/skills
ln -sf ../../.claude-plugin/skills/blog .claude/skills/blog
```

## Troubleshooting

### `/blog` doesn't appear in the skill list

- Verify the plugin directory is correct — the manifest at
  `.claude-plugin/plugin.json` (relative to the plugin dir, or
  `<plugin-dir>/plugin.json` with any absolute `<plugin-dir>`) must have
  `"name": "m0lz"` and a `skills` array containing
  `{"name": "blog", "path": "skills/blog"}`.
- Verify `SKILL.md` is readable: `cat <plugin-dir>/skills/blog/SKILL.md`.
- Restart Claude Code after changing plugin directories.

### "No m0lz.01 workspace detected"

The skill (and `blog agent preflight`) walks up from the current cwd to find
`.blog-agent/state.db`. Either:

- `cd` into a directory whose ancestor contains `.blog-agent/state.db`, or
- pass `blog --workspace /path/to/workspace ...` to the CLI, or
- set `BLOG_WORKSPACE=/path/to/workspace` in the environment before starting
  Claude Code.

If no workspace exists yet, run `blog init` in an empty directory first.

### Permission prompts on every `!`blog …`` call

The skill declares `allowed-tools: Bash(blog:*) Read Grep Glob` — deliberately
narrow. It has NO `Write`, `Edit`, or `Bash(gh:*)` scope, so every plan-file
mutation and every git/GitHub operation routes through the `blog` binary via
`blog agent apply`. That is the structural safety boundary; widening the
scope without also moving the mutation into the CLI would defeat the hash
gate. If Claude Code still prompts for approval on every `!`blog …`` call,
ensure your `settings.json` permissions aren't narrower than the declared
scope. See `/update-config` and `settings.json` docs.

### `[AGENT_ERROR] HASH_MISMATCH`

Your plan file was edited after approval. This is working as designed —
re-approve with:

```bash
blog agent approve /path/to/plan.json
```

If the edit was unintentional, revert the file first.

### `[AGENT_ERROR] WORKSPACE_MISMATCH`

The plan's `workspace_root` doesn't match where you're running. Either:

- `cd` into the workspace recorded in `plan.workspace_root`, or
- regenerate the plan from the correct workspace (plan files are workspace-scoped).

### `Shell command failed … parse error near \`>\``

Symptom: the skill tries to run a command like `!blog agent verify <plan-path>`
and bash rejects it. Cause: your Claude Code session loaded a stale version of
SKILL.md / JOURNEYS.md from before the `<placeholder>` → `"$VAR"` fix. Pull
the latest, rebuild if running from source, and restart Claude Code with the
current plugin dir. The regression is locked in `tests/skill-smoke.test.ts`
(three tests, one per skill doc), so any future recurrence fails CI before
reaching operators.
