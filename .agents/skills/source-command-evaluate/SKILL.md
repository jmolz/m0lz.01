---
name: "source-command-evaluate"
description: "Grade implementation against a plan's contract using an isolated adversarial evaluator"
---

# source-command-evaluate

Use this skill when the user asks to run the migrated source command `evaluate`. Original argument hint: `<path-to-plan.md>`.

## Command Template


# Evaluate: Contract-Based Adversarial Review

## Mission

Grade the implementation against the contract defined in the plan file. The evaluation is performed by a **fresh sub-agent** that sees ONLY the contract, the code diff, and AGENTS.md — never the planning conversation or implementation rationale. This separation eliminates self-evaluation bias.

**Core Principle**: The evaluator's job is to find failures, not confirm success. A passing score must be earned.

---

## Step 1: Load the Contract

Read the plan file at: `{user-provided arguments}`

Extract the `## Contract` section. If no contract exists, stop and tell the user:

```
No contract found in this plan. Run /plan-feature to create a plan with a contract,
or add a ## Contract section manually with JSON criteria.
```

Parse the contract JSON to get:

- **Tier** (1, 2, or 3) — determines number of evaluation passes
- **Criteria** — each with name, threshold, and validation method
- **Pass threshold** — default 8/10

---

## Step 2: Gather Evaluation Context

Collect ONLY what the evaluator needs — no implementation rationale:

```bash
# What changed since the plan was created
git diff HEAD~$(git log --oneline --since="$(stat -f %Sm -t '%Y-%m-%d' {user-provided arguments} 2>/dev/null || date -r $(stat -c %Y {user-provided arguments} 2>/dev/null || echo 0) '+%Y-%m-%d')" | wc -l | tr -d ' ')..HEAD --stat
git diff HEAD~$(git log --oneline --since="$(stat -f %Sm -t '%Y-%m-%d' {user-provided arguments} 2>/dev/null || date -r $(stat -c %Y {user-provided arguments} 2>/dev/null || echo 0) '+%Y-%m-%d')" | wc -l | tr -d ' ')..HEAD
```

If the diff approach doesn't work cleanly, fall back to:

```bash
git diff HEAD
git status
```

Also gather:

- The project's AGENTS.md (for convention checking)
- Any on-demand rules in `.codex/rules/` relevant to changed files

If `AGENTS.md` is missing from the current git toplevel and the toplevel path contains `/.worktrees/`, use the sibling main checkout `AGENTS.md` above the `.worktrees` directory instead. Report the resolved AGENTS path in the evaluation output so a worktree cannot silently evaluate without project conventions.

---

## Step 3: Run Evaluation Pass(es)

Evaluation uses a **dual-model adversarial** approach. The Claude evaluator grades contract criteria formally. For Tier 2+, a parallel GPT-5.5 adversarial review challenges the design approach itself.

### Step 3a: Launch Codex Adversarial Review (all tiers)

For every tier (1, 2, and 3), launch a Codex adversarial review in the background **before** running the Claude evaluator. This runs GPT-5.5 xhigh in parallel.

Run the following via `Bash` with `run_in_background: true` (so Claude evaluation can proceed in parallel).

**Sandbox note:** `codex-companion` starts `codex app-server`, which can fail inside restricted shell sandboxes with `Operation not permitted`. If the shell tool supports sandbox escalation, run every `codex-companion.mjs` invocation in this step with `sandbox_permissions: "require_escalated"` and the justification "Allow Codex app-server to start for the adversarial evaluator." A good persistent prefix rule is `["node", "/Users/jacobmolz/.codex/plugins/cache/openai-codex/codex/1.0.4/scripts/codex-companion.mjs"]`. If a non-escalated attempt fails with `codex app-server exited unexpectedly` or `Operation not permitted`, immediately rerun the same command with escalation before falling back.

**External-evaluation approval boundary:** This sends the contract, diffs/status, AGENTS.md, and relevant rules to the Codex GPT-5.5 evaluator. If the host approval layer rejects the command because private workspace content would leave the local machine, do not work around it. Tell the user exactly what would be sent and ask for explicit approval to run the external adversarial evaluator; continue only after that approval.

```bash
node "$HOME/.codex/plugins/cache/openai-codex/codex/1.0.4/scripts/codex-companion.mjs" \
  task --background --json --model gpt-5.5 --effort xhigh \
  "Adversarially evaluate against this contract: {paste contract criteria names and thresholds}. Use only the contract JSON, git diff/status, AGENTS.md, and relevant .codex/rules. Challenge design assumptions, failure modes, and production risks; do not edit files." \
  > /tmp/codex-launch.json 2> /tmp/codex-launch-err.txt
```

All tiers use `task --model gpt-5.5 --effort xhigh` for maximum reasoning depth. Do not use `adversarial-review --effort`; the installed companion does not parse effort flags for that subcommand.

**Capture both stdout AND stderr AND the launch exit code**, then capture the background job result. The launch output is only a receipt and is expected to be short; do not classify the launch receipt itself as an empty Codex review. Prefer this shape:

```bash
node "$HOME/.codex/plugins/cache/openai-codex/codex/1.0.4/scripts/codex-companion.mjs" \
  task --background --json --model gpt-5.5 --effort xhigh \
  "..." > /tmp/codex-launch.json 2> /tmp/codex-launch-err.txt
CODEX_LAUNCH_EXIT=$?
echo "CODEX_LAUNCH_EXIT=$CODEX_LAUNCH_EXIT"
CODEX_JOB_ID=$(node -e 'const fs=require("fs"); const p=JSON.parse(fs.readFileSync("/tmp/codex-launch.json","utf8")); console.log(p.jobId || p.payload?.jobId || "");')
echo "CODEX_JOB_ID=$CODEX_JOB_ID"

node "$HOME/.codex/plugins/cache/openai-codex/codex/1.0.4/scripts/codex-companion.mjs" \
  status "$CODEX_JOB_ID" --wait --timeout-ms 300000 --json > /tmp/codex-status.json 2> /tmp/codex-status-err.txt
CODEX_STATUS_EXIT=$?
echo "CODEX_STATUS_EXIT=$CODEX_STATUS_EXIT"

node "$HOME/.codex/plugins/cache/openai-codex/codex/1.0.4/scripts/codex-companion.mjs" \
  result "$CODEX_JOB_ID" --json > /tmp/codex-result.json 2> /tmp/codex-result-err.txt
CODEX_RESULT_EXIT=$?
echo "CODEX_RESULT_EXIT=$CODEX_RESULT_EXIT"
```

Downstream (Step 4) uses `CODEX_LAUNCH_EXIT`, `CODEX_STATUS_EXIT`, `CODEX_RESULT_EXIT`, `/tmp/codex-status.json`, `/tmp/codex-result.json`, and the stderr files to decide between "use Codex output directly" and "fall back".

If Codex ultimately can't produce output (crashes, rate-limited, and no fallback key), note the error in the final report and continue with Claude-only evaluation — do not block the entire evaluation.

The Codex review challenges the *approach* — was this the right design? What assumptions does it depend on? Where could it fail under real-world conditions? This is complementary to the Claude evaluator's formal contract grading.

#### Fallback to OpenAI Responses API

The Codex CLI authenticates via the user's ChatGPT Team session by default. It can fail for multiple reasons:

- **Rate limited**: ChatGPT Team quota exhausted.
- **Auth missing**: no ChatGPT Team session configured.
- **Script crash**: Node-level error in the companion script (e.g., `EISDIR`, `ENOENT`, undefined internals).
- **Empty output**: script exits successfully but emits nothing useful.

In every case, fall back to a direct OpenAI Responses API call — do **not** run `codex login --api-key`, as that would overwrite the ChatGPT Team session (making recovery manual once upstream recovers).

**Fallback key location**: `~/.codex/.openai-fallback-key` — single line containing an OpenAI API key, `chmod 600`. If absent, skip fallback and report the Codex error verbatim.

**Fallback trigger** — use fallback if ANY of these hold:

1. `CODEX_LAUNCH_EXIT != 0`, `CODEX_STATUS_EXIT != 0`, or `CODEX_RESULT_EXIT != 0`, OR
2. `/tmp/codex-result.json` contains no useful final output (empty `finalMessage`, empty rendered result, or missing completed job result), OR
3. The output contains a known rate-limit marker (case-insensitive): `rate limit`, `rate_limit_exceeded`, `429`, `too many requests`, `usage cap`, `quota exceeded`, OR
4. The output/stderr contains a known crash marker: `EISDIR`, `ENOENT`, `ECONNREFUSED`, `Cannot find module`, `Error [ERR_`, `TypeError:`, `SyntaxError:`, `UnhandledPromiseRejection`.

Label the fallback output in the final report according to the reason:

- Rate-limit: `Codex GPT-5.5 (OpenAI API fallback — ChatGPT Team rate-limited)`
- Crash / auth / empty: `Codex GPT-5.5 (OpenAI API fallback — companion script failed: <reason>)`

**Fallback invocation** (only on trigger, only if the key file exists):

```bash
OPENAI_FALLBACK_KEY=$(cat "$HOME/.codex/.openai-fallback-key")
EFFORT="xhigh"   # All tiers (Responses API supports xhigh for gpt-5.5)
cat > /tmp/codex-fallback-request.json <<'JSON'
{
  "model": "gpt-5.5",
  "reasoning": { "effort": "__EFFORT__" },
  "input": "__PROMPT__"
}
JSON
# Replace __EFFORT__ and __PROMPT__ with the actual values (jq or sed; escape JSON properly).
curl -sS https://api.openai.com/v1/responses \
  -H "Authorization: Bearer $OPENAI_FALLBACK_KEY" \
  -H "Content-Type: application/json" \
  --data-binary @/tmp/codex-fallback-request.json
```

Reserve sufficient output budget (OpenAI recommends ≥25k tokens for reasoning + output on gpt-5.5 at `xhigh`). Optionally pass `"max_output_tokens": 32000` and handle `status: "incomplete"` with `incomplete_details.reason === "max_output_tokens"` by retrying with a larger budget. Extract the visible answer from `response.output[].content[].text` (or `response.output_text`).

The `__PROMPT__` must include: the same focus text passed to `codex-companion task`, the contract criteria JSON, the full diff, and AGENTS.md — i.e., the same context Codex would have received. Construct the prompt string explicitly rather than relying on Codex's internal prompt templates (which are not accessible outside the CLI).

Treat the extracted text as the adversarial review output. Label it clearly in the final report per the "Fallback trigger" table above.

Once the upstream issue resolves (rate limit lifts, companion script is fixed, etc.), no action is required: the primary Codex path resumes on the next invocation, and the fallback triggers only on failure.

### Step 3b: Run Claude Evaluator Pass(es)

For each Claude evaluation pass (1 for Tier 1, 1 for Tier 2, 3 for Tier 3 agent team), spawn a **fresh Claude opus 4.7 adaptive sub-agent** (`model: "opus"`) with the following prompt.

### Evaluator Sub-Agent Prompt

```
You are an ADVERSARIAL EVALUATOR. Your job is to find failures, not confirm success.

## Calibration — READ THIS FIRST

Do NOT be generous. Your natural inclination will be to praise the work. Resist this.
When in doubt, score LOWER, not higher. An 8 means "meets the bar" — not "pretty good."
A 7 means "functional but not production-ready — missing edge cases or robustness."
A 6 means "almost there but not reliable enough to ship." Do not round up.

You are NOT the implementer. You did NOT write this code. You have no stake in it passing.
Your reputation depends on catching problems, not on approving work.

## What You Are Grading

Contract:
{paste the full contract JSON here}

## What Changed

{paste the full git diff here}

## Project Conventions

{paste AGENTS.md contents here}

## Your Task

For EACH criterion in the contract:

1. **Read the relevant code** — find the files that implement this criterion
2. **Run the validation** — execute the validation command or check the observable behavior
3. **Try to break it** — think of edge cases, malformed inputs, missing auth, concurrent access
4. **Score it 1-10** with specific evidence:
   - 1-3: Fundamentally broken or missing
   - 4-5: Partially works but has significant gaps
   - 6-7: Functional but insufficient — missing edge cases, weak validation, or convention drift
   - 8: Meets the bar — correct, robust, follows conventions, handles edge cases
   - 9: Exceeds expectations — well-tested, defensive, production-hardened
   - 10: Exceptional — comprehensive error handling, security-aware, zero gaps found

## Output Format

For each criterion, output:

### {Criterion Name}
- **Score**: {N}/10 (threshold: {T})
- **Pass**: YES / NO
- **Evidence**: {What you found — specific file:line references}
- **Issues**: {What's wrong or missing — be specific}
- **Validation Result**: {Output of running the validation command}

Then output a summary:

### Summary
- **Overall**: PASS / FAIL
- **Passed**: {N}/{total} criteria met threshold
- **Lowest Score**: {criterion name} at {score}/10
- **Critical Issues**: {List any criterion that scored below threshold}

If ANY criterion scores below its threshold, the overall result is FAIL.
```

### Between Passes (Tier 2-3 only)

If Pass 1 fails, present the evaluator's feedback to the user:

```
## Evaluation Pass {N} — {PASS/FAIL}

{evaluator's full output}

Options:
1. Fix the issues and re-evaluate (remaining passes: {N})
2. Accept the current state and skip remaining passes
3. Adjust the contract (lower thresholds or remove criteria)
```

If the user chooses to fix:

- Fix the issues identified by the evaluator
- Run the next evaluation pass with a NEW sub-agent that sees:
  - The original contract
  - The NEW diff (including fixes)
  - The PREVIOUS evaluator's feedback (so it can verify fixes addressed the issues)
  - AGENTS.md

The new evaluator does NOT see the implementation conversation — only prior evaluation feedback.

---

## Step 4: Collect Codex Findings (all tiers)

A Codex adversarial review was launched in Step 3a regardless of tier; collect its results now. The background Bash task should have completed (or will complete shortly) — wait for the completion notification if it hasn't arrived yet, then read the full output.

If the background task is still running after all Claude evaluation passes are complete, wait up to 5 minutes. If it times out or errored, note this in the final report and proceed with Claude-only results.

**Decision tree** (apply in order — first match wins):

1. **Launch/status/result exits are 0, job status is completed, useful final output is present, and no rate-limit/crash markers are present** → Use Codex output directly from `/tmp/codex-result.json`. Skip fallback.
2. **Any failure mode from the Step 3a trigger table** (non-zero exit, failed job, missing final output, rate-limit marker, crash marker) → Attempt fallback:
   - If `~/.codex/.openai-fallback-key` exists → run the fallback curl invocation from Step 3a. Substitute the fallback text for the Codex output. Label it per the trigger reason.
   - If the key file is missing → report to the user:
     ```
     Codex adversarial review unavailable: <reason> (launch=<CODEX_LAUNCH_EXIT>, status=<CODEX_STATUS_EXIT>, result=<CODEX_RESULT_EXIT>, markers=<detected>).
     To enable fallback: create ~/.codex/.openai-fallback-key (chmod 600) containing an
     OpenAI API key, then re-run /evaluate. Proceeding with Claude-only evaluation for now.
     ```
3. **Fallback curl itself fails** (HTTP 5xx, invalid JSON, missing API key, `response.output` empty) → report the failure verbatim and proceed Claude-only. Do not swallow the error silently.

The Codex review output challenges design decisions and assumptions — it does NOT score against the contract. Treat its findings as a separate evaluation dimension.

---

## Step 5: Final Report

After all passes complete (or the user stops early), output:

```markdown
## Evaluation Report: {Feature Name}

### Contract

- Tier: {N}
- Claude passes completed: {N}/{max}
- Codex adversarial review: YES (all tiers — GPT-5.5 xhigh)

### Results by Criterion (Claude Evaluator)

| Criterion | Threshold | Score  | Pass   |
| --------- | --------- | ------ | ------ |
| {name}    | {T}/10    | {S}/10 | YES/NO |
| ...       | ...       | ...    | ...    |

### Design Challenge Findings (Codex GPT-5.5 xhigh — all tiers)

{Paste Codex adversarial review findings verbatim. These challenge the approach
itself — design tradeoffs, assumptions, and alternative approaches. Categorize as:}

- **Critical** — design issues that could cause real-world failures
- **Consider** — valid alternative approaches worth acknowledging
- **Acknowledged** — tradeoffs the team accepts knowingly

### Overall: {PASS / FAIL}

A FAIL from the Claude evaluator (any criterion below threshold) = overall FAIL.
Critical design challenges from Codex that the team cannot justify = overall FAIL.

### Issues to Address (if FAIL)

1. {criterion}: {specific issue and suggested fix}
2. ...

### What Passed Well

- {criterion}: {why it scored well}
```

---

## Rules

- **Never evaluate your own work in the same context** — always use a fresh sub-agent
- **The evaluator never sees implementation rationale** — only contract, diff, and conventions
- **Do not weaken criteria to make things pass** — if the implementation doesn't meet the bar, it fails
- **Run validation commands for real** — don't just read the code and guess
- **Between passes, the user decides** — fix, accept, or adjust. Never auto-retry without user input
- **Kill background processes** before outputting results to prevent session hangs
