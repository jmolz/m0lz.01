---
name: blog-benchmark
description: Scaffold a test harness, run benchmarks, and collect primary-source data for a post. Requires a finalized research slug. Produces environment snapshots, structured results, METHODOLOGY.md, and a companion repo that downstream phases consume.
---

# /blog-benchmark

Benchmark phase skill: scaffold a companion repo with test harnesses, execute benchmark runs with environment capture, store results in `.blog-agent/benchmarks/`, and generate METHODOLOGY.md. Every benchmark claim in the final post will be backed by verifiable primary-source data.

## Pre-flight Checks

1. Confirm the research slug is finalized:

   ```bash
   blog research finalize <slug>
   ```

   Must exit 0. If it fails, fix the research doc first.

2. Check the content type requirement:
   - `technical-deep-dive`: benchmarks are **required** -- proceed normally.
   - `project-launch`: benchmarks are **optional** -- ask the author if they want to benchmark. If yes, proceed. If no, run `blog benchmark skip <slug>`.
   - `analysis-opinion`: benchmarks are **skip** -- run `blog benchmark skip <slug>` to advance directly to draft.

## Step 1: Initialize the Benchmark

```bash
blog benchmark init <slug>
```

This transitions the post from `research` to `benchmark` phase, creates `.blog-agent/benchmarks/<slug>/`, parses benchmark targets from the research document, captures the environment, and scaffolds the companion repo at `.blog-agent/repos/<slug>/`.

Review the parsed targets printed by the CLI. These are the claims or comparisons to test.

## Step 2: Capture Environment

If you need to re-capture (e.g., after upgrading a dependency):

```bash
blog benchmark env <slug>
```

This writes `environment.json` with OS, CPU, memory, Node.js version, npm version, and timestamp.

## Step 3: Scaffold the Test Harness

Write test code into `.blog-agent/repos/<slug>/src/` based on the benchmark targets from the research document. Choose the language and framework appropriate to the research topic:

- **Rust benchmarks** for Rust projects (use `criterion`)
- **Node.js benchmarks** for JS/TS projects (use `vitest bench` or raw `performance.now()`)
- **Python benchmarks** for Python projects (use `pytest-benchmark`)
- **Shell scripts** for infrastructure comparisons (e.g., `hyperfine`)

The test harness must:

- Be self-contained and reproducible
- Output structured results (JSON preferred)
- Include a `package.json` / `Cargo.toml` / `requirements.txt` as appropriate
- Document how to run in the companion repo README

## Step 4: Execute Tests

Run the test harness from `.blog-agent/repos/<slug>/`. Capture output and pipe results into a `results.json` file at `.blog-agent/benchmarks/<slug>/results.json`.

The results JSON should follow this structure:

```json
{
  "slug": "<slug>",
  "run_id": 1,
  "timestamp": "2026-04-14T12:00:00.000Z",
  "targets": ["target 1", "target 2"],
  "data": {
    "target_1": { "mean": 42.5, "unit": "ms" },
    "target_2": { "mean": 128.3, "unit": "ms" }
  }
}
```

## Step 5: Register Results

```bash
blog benchmark run <slug> --results-file .blog-agent/benchmarks/<slug>/results.json
```

This creates a run row in the `benchmarks` table, links the environment snapshot, and stores the results path.

## Step 6: Multiple Runs

Run the test harness `benchmark.multiple_runs` times (default 3 from `.blogrc.yaml`). Each run gets a separate row in the benchmarks table.

```bash
# Run tests again, overwrite results.json, then register:
blog benchmark run <slug> --results-file .blog-agent/benchmarks/<slug>/results.json
```

Repeat until you have the configured number of runs. Multiple runs provide statistical confidence and surface variance.

## Step 7: Contradictory Data Handling

If results contradict the thesis from the research document:

- **Do NOT hide or discard the data.** Store everything.
- Flag the contradiction explicitly in the results.
- The draft phase will address contradictory data honestly in the post.
- Raw data is sacred -- never alter results after collection.

## Step 8: Complete or Skip

When all runs are done and data looks reasonable:

```bash
blog benchmark complete <slug>
```

This sets has_benchmarks=TRUE and advances to the draft phase.

Or if benchmarks should be skipped (optional/skip content types):

```bash
blog benchmark skip <slug>
```

## Step 9: Verify State

```bash
blog benchmark show <slug>
```

Confirm: phase is `benchmark` (or `draft` if completed/skipped), run count matches expectations, environment is captured, results path points to valid data.

## Output Contract

Downstream phases consume these artifacts:

| Artifact | Consumer | Purpose |
|----------|----------|---------|
| `.blog-agent/benchmarks/<slug>/results.json` | Draft phase | Data tables and charts in the post |
| `.blog-agent/benchmarks/<slug>/environment.json` | Draft phase | "Tested on {env}" methodology reference |
| `.blog-agent/repos/<slug>/METHODOLOGY.md` | Companion repo | Reproduction instructions for readers |
| `.blog-agent/repos/<slug>/src/` | Companion repo | Test code readers can clone and run |
| Benchmark targets matched to results | Draft phase | Verify every target has corresponding data |

## CLI Reference

| Command | Description |
|---------|-------------|
| `blog benchmark init <slug>` | Transition research to benchmark, parse targets, scaffold |
| `blog benchmark env <slug>` | Capture environment snapshot |
| `blog benchmark run <slug> [--results-file <path>]` | Record a benchmark run |
| `blog benchmark show <slug>` | Display benchmark state |
| `blog benchmark skip <slug>` | Skip benchmarks, advance to draft |
| `blog benchmark complete <slug>` | Mark benchmarks done, advance to draft |
