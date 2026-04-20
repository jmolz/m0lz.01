#!/usr/bin/env node

import { Command } from 'commander';
import { findWorkspaceRoot } from '../core/workspace/root.js';

// Commands that must work WITHOUT an initialized workspace. Everything else
// refuses to start when `findWorkspaceRoot` can't locate `.blog-agent/state.db`.
//
// `agent` used to be exempt wholesale, which let `agent plan/approve/verify/apply`
// run from any cwd (Codex adversarial review, High #3). The CLI now only exempts
// `agent preflight` — every other `agent` subcommand must resolve to a real
// workspace before chdir'ing. `plan` records `workspace_root` from cwd, so letting
// it run outside a workspace would stamp an arbitrary directory as the plan's
// trust root.
const WORKSPACE_FREE_COMMANDS = new Set(['init', 'help']);
const AGENT_WORKSPACE_FREE_SUBCOMMANDS = new Set(['preflight']);
const WORKSPACE_FREE_FLAGS = new Set(['--help', '-h', '--version', '-V']);

async function main(): Promise<void> {
  const originalCwd = process.cwd();
  const argv = process.argv.slice(2);

  // Parse --workspace early, before Commander runs, so the override can
  // influence chdir-before-imports. Accepts both forms:
  //   --workspace <path>       (split, consumes two argv slots)
  //   --workspace=<path>       (compact, one slot)
  // Without compact-form support, `blog --workspace=/abs/ws ...` silently
  // fell through to Commander, skipping the chdir-before-imports invariant
  // for workspace-free subcommands (Codex Pass-5 Medium).
  //
  // `skippedIndices` records argv slots that belong to --workspace (the flag
  // itself and, in split form, its operand). These are excluded from the
  // positional walk below so `firstPositional` is the actual subcommand —
  // not the workspace path, which previously misclassified
  // `blog --workspace /abs agent preflight` (Codex Pass-5 Medium secondary).
  let workspaceOverride: string | undefined;
  const skippedIndices = new Set<number>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--workspace') {
      skippedIndices.add(i);
      if (i + 1 < argv.length) {
        workspaceOverride = argv[i + 1];
        skippedIndices.add(i + 1);
      } else {
        // Trailing `--workspace` with no operand is a typo — reject
        // explicitly instead of silently falling back to env/ancestor,
        // which would run commands against an ambient workspace the
        // operator did not intend (Codex Pass-6 Medium).
        console.error("Error: --workspace requires a path argument");
        process.exit(1);
      }
    } else if (token.startsWith('--workspace=')) {
      skippedIndices.add(i);
      workspaceOverride = token.slice('--workspace='.length);
    }
  }
  // Empty or whitespace-only override (e.g. from `--workspace=` or
  // `--workspace ''` or an unexpanded shell variable) silently fell
  // through to BLOG_WORKSPACE / ancestor walk pre-Pass-6. Reject
  // explicitly so an empty value never reaches `findWorkspaceRoot`
  // as a "no override provided" signal (Codex Pass-6 Medium).
  if (workspaceOverride !== undefined && workspaceOverride.trim().length === 0) {
    console.error("Error: --workspace value is empty; provide a workspace path");
    process.exit(1);
  }

  const positionals = argv.filter((a, i) => !skippedIndices.has(i) && !a.startsWith('-'));
  const firstPositional = positionals[0] ?? '';
  const secondPositional = positionals[1] ?? '';
  const hasHelpOrVersionFlag = argv.some((a) => WORKSPACE_FREE_FLAGS.has(a));
  const isAgentWorkspaceFreeSub =
    firstPositional === 'agent' && AGENT_WORKSPACE_FREE_SUBCOMMANDS.has(secondPositional);
  const skipWorkspaceCheck =
    argv.length === 0 ||
    hasHelpOrVersionFlag ||
    WORKSPACE_FREE_COMMANDS.has(firstPositional) ||
    isAgentWorkspaceFreeSub;

  try {
    const root = findWorkspaceRoot(originalCwd, {
      override: workspaceOverride,
      envVar: process.env.BLOG_WORKSPACE,
    });
    process.chdir(root);
    process.env._BLOG_ORIGINAL_CWD = originalCwd;
  } catch (e) {
    if (!skipWorkspaceCheck) {
      console.error((e as Error).message);
      process.exit(1);
    }
    // Workspace-free command: preserve original cwd for init + agent preflight.
    process.env._BLOG_ORIGINAL_CWD = originalCwd;
  }

  // Dynamic-import after chdir so module-level `resolve('.blog-agent/...')`
  // constants evaluate against the workspace root, not the user's original cwd.
  await import('dotenv/config');
  const { registerInit } = await import('./init.js');
  const { registerStatus } = await import('./status.js');
  const { registerMetrics } = await import('./metrics.js');
  const { registerIdeas } = await import('./ideas.js');
  const { registerResearch } = await import('./research.js');
  const { registerBenchmark } = await import('./benchmark.js');
  const { registerDraft } = await import('./draft.js');
  const { registerEvaluate } = await import('./evaluate.js');
  const { registerPublish } = await import('./publish.js');
  const { registerUpdate } = await import('./update.js');
  const { registerUnpublish } = await import('./unpublish.js');
  const { registerAgent } = await import('./agent.js');

  const program = new Command();

  program
    .name('blog')
    .description('m0lz.01 — idea-to-distribution pipeline for technical content')
    .version('0.1.0')
    .option('--workspace <path>', 'Workspace root directory (overrides auto-detection)');

  registerInit(program);
  registerStatus(program);
  registerMetrics(program);
  registerIdeas(program);
  registerResearch(program);
  registerBenchmark(program);
  registerDraft(program);
  registerEvaluate(program);
  registerPublish(program);
  registerUpdate(program);
  registerUnpublish(program);
  registerAgent(program);

  program.parse();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
