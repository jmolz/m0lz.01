---
paths:
  - "src/core/draft/**"
  - "src/cli/draft.ts"
  - "templates/draft/**"
  - "skills/blog-draft.md"
  - "skills/blog-evaluate.md"
  - ".claude-plugin/skills/blog/**"
  - "src/core/evaluate/**"
---
# Voice

Rules the agent follows when drafting content for the operator's canonical
hub and cross-post venues. Covers body prose, frontmatter descriptions,
social variants, and reviewer prompts. Optimizes for two things at once:
**sounds like the operator** (direct, confident, unhedged) and **respects
the reader** (a smart person who is not already an expert in this topic).

If a draft fails these rules, the structural reviewer flags it. Voice drift
is an issue, not a taste difference.

## The promise to the reader

Every post delivers one thing. A smart non-expert leaves with a working
mental model of the topic and a concrete sense of why it matters.

If a reader has to already know the topic to follow the post, the post
failed. If a reader who knows the topic feels talked down to, the post
also failed. Both are voice failures, not structural ones.

## Hard rules: always wrong

These produce the "AI house style" that makes content feel synthetic.
Remove on sight. No exceptions.

### Hedges and filler

Delete:

- "I believe", "I think", "perhaps", "it seems", "arguably", "one could argue"
- "It's worth noting that", "it's important to understand", "notably"
- "In today's fast-paced world", "in the world of X", "at the end of the day"
- "Let's dive in", "let's explore", "without further ado", "buckle up"
- "Needless to say", "that said" (as a standalone opener), "interestingly"
- "This raises important questions about..." without naming the questions

State the claim. If it needs a qualifier, the qualifier is a specific
condition, not a vibe. *"On workloads above 10k requests/sec"* beats
*"under certain conditions."*

### Rhythmic AI cadence

Three patterns to kill:

1. **Tricolon stacks.** Three parallel phrases in a row, especially when
   the third is abstract. *"It's fast, it's reliable, and it's
   transformative."* This reads AI from space.
2. **Uniform sentence length.** Four medium sentences in a row is a
   signature. Break one. Make it short.
3. **Topic-restatement transitions.** *"Now that we've covered X, let's
   look at Y."* A reader who needs this sentence to follow the post was
   already lost. Cut it and move on.

### Punctuation: interruption patterns

Three marks stack clauses to fake rhythm. AI overuses all three.

**Em dash.** Each one earns its place. Before keeping it, try:

1. **Period.** Can the aside be its own sentence? If yes, make it one.
   This is the right fix most of the time.
2. **Comma.** Is the aside tightly bound to the subject? Use a comma.
3. **Parentheses.** Genuinely parenthetical? Use them. Don't make
   parentheses the new em dash.
4. **Cut.** Does the aside need to be there at all? Often not.

If none of those work, keep the em dash. Surviving em dashes should feel
intentional. Roughly one per 500 words is a smoke alarm, not a hard cap.

**Parenthetical asides.** Same test. If a parenthetical contains a full
claim, it's probably a sentence. If it contains a throwaway, cut it.

**Colon-before-clause.** *"The answer: X."* This is an em dash wearing a
disguise. One or two per post, not a default rhythm. Colons before lists
are fine; colons as punchline setups are not.

### Smarmy transitions

No "let's," no "together we'll," no "join me as we." The reader did not
agree to a journey. They opened a tab.

### Jargon without a handle

Technical terms are fine. **Undefined** technical terms are not. First
use gets a handle. A handle is the shortest possible gloss that makes
the term usable. Not a definition. A handle.

- Bad: *"The system uses a hash-bound payload for structural safety."*
- OK: *"We hash the plan after approval. Any edit afterward changes the
  hash, and `apply` refuses to run."*

You don't need to define "hash" or "payload." You need to show the
reader what those words *do* here.

### Emojis

Not in content, not in frontmatter, not in social text. Inherited
constraint from the canonical site.

## Cadence

- **Mix sentence lengths on purpose.** Short declaratives punctuate
  longer explanatory ones. Not every paragraph needs this; at least one
  per major section does.
- **Open with a declarative claim, not a setup sentence.** The first
  line of a section should land the thesis of that section. If the
  reader stops after one line, they should still have gotten the point.
- **Prefer active voice and concrete subjects.** *"The plan hash blocks
  post-approval edits"* beats *"Post-approval edits are blocked by a
  hash-based mechanism."*
- **One idea per sentence.** Compound sentences that chain two
  unrelated claims with "and" get split.
- **Contractions are fine.** *Don't, can't, won't, it's.* Formal
  non-contracted prose reads stiff, not authoritative.

## Accessibility: the reader-respect rule

Two tests, applied section by section:

1. **The newcomer test.** Could someone who has never used this tool or
   read about this topic follow this paragraph without opening another
   tab? If no, add a handle or cut the paragraph.
2. **The expert test.** Would someone who *does* know the topic feel
   insulted by the explanation? If yes, the explanation is over-stated.
   Trim it to a handle and move on.

How to hit both:

- **Ground abstractions in concrete examples before generalizing.**
  Show one case, then name the pattern. Not the other way around.
- **Name the thing before explaining the thing.** Readers can park a
  term mentally. They can't park a three-sentence explanation waiting
  for its subject.
- **Skip lineage nobody needs.** *"Since the early 2010s, distributed
  systems have..."* Cut. The reader is here for what you're saying now.
- **If a concept takes more than two sentences to handle, it's its own
  post.** Link out instead of expanding inline.

## Structure

- **Paragraphs are short.** Three to five sentences is the working
  range. Single-sentence paragraphs are legal and useful for landing
  a claim.
- **Headings are declarative, not categorical.** *"Why the hash gate
  can't be bypassed"* beats *"Security considerations."*
- **Lists earn their existence.** Three parallel items makes a list.
  Two items makes a sentence with "and." Five items where three are
  filler should become three items, or a paragraph.
- **Code and data pull their weight.** Every code block has a reason
  to exist that a sentence couldn't carry. Don't paste code to show
  you did the work. Paste code when the reader needs to see the shape.

## Positive voice signals: lean in

These patterns read as the operator's own voice, not as AI trying to
sound human. Use them on purpose, not randomly.

- **Blunt corrections of a common misread.** *"This is usually described
  as X. It isn't. It's Y."* Clean, direct, no "actually."
- **Specific numbers and specific nouns.** *"874 tests across 65
  suites"* beats *"a comprehensive test suite."* The specificity is
  the voice.
- **Name the tradeoff, don't hide it.** *"This costs one extra round
  trip. In exchange, you get a receipt bound to the approved plan.
  Worth it for anything destructive, overkill for a status query."*
- **Admit the boring parts.** *"Most of this is plumbing."* Readers
  trust writers who do this because they don't trust writers who
  pretend everything is revelatory.
- **Stop when you're done.** No summary paragraph that restates the
  post. The reader has the post. They don't need the post-about-the-
  post. End on the last real sentence.

## Frontmatter description

Special case. One sentence, ≤160 chars, must survive on its own as the
SEO snippet and the social preview.

- Declarative. No "A guide to...", no "Exploring...".
- Concrete subject and concrete verb.
- Hits the thesis, not the topic.

Bad: *"A look at how we built hash-bound plan files for safer agent
execution."*

Good: *"Every destructive blog command runs through a SHA256-bound plan
file. Tampering after approval is rejected structurally, not by
convention."*

## Social variants

- **LinkedIn.** First line is the hook. It carries standalone without
  the rest. Two to four short paragraphs. Ends with a question only if
  the question is real.
- **Hacker News title.** "Show HN:" prefix only for project launches
  with a working artifact. No editorializing in the title. HN will
  punish it.
- **Dev.to.** Re-use the hub post verbatim. Canonical URL set. No
  voice variants.

## Before / after

Calibration pairs. Each "after" is what the rules produce on the same
subject.

**Topic intros**

Before: *"In today's rapidly evolving landscape of AI-assisted
development, it's becoming increasingly clear that safety and autonomy
sit in tension. In this post, we'll explore a new approach that aims
to reconcile these concerns."*

After: *"An AI agent that can ship code autonomously is either safe or
it's useful — rarely both. The plan file gate is one way to buy both
at once."*

The em dash in the "after" earned its place: *rarely both* is a
genuine reveal after the either/or setup, and a period would flatten
the rug-pull. This is the ~one-per-500-words density the rules allow.

**Explaining a mechanism**

Before: *"The system utilizes a cryptographic hashing algorithm to
ensure the integrity of the plan file. Once approved, any subsequent
modifications will be detected by the verification process, thereby
preventing unauthorized changes from being applied."*

After: *"Approval hashes the plan. Any edit after that changes the
hash, and `apply` refuses to run a plan whose hash doesn't match the
one approved. You can't sneak a step in after the human signs off.
The CLI catches it structurally."*

**Naming a tradeoff**

Before: *"While this approach has many benefits, it's important to
note that there are some tradeoffs to consider. Users should
carefully evaluate their specific requirements."*

After: *"This costs one extra step between 'I want to ship this' and
the ship happening. In exchange, the shipped thing is exactly what
you approved. For a blog post that's overkill. For anything that
writes to a repo or an API, it's the whole point."*

**Ending a section**

Before: *"In conclusion, the plan-file architecture provides a robust
mechanism for balancing safety and autonomy in AI-assisted workflows."*

After: *(the previous paragraph's last sentence)*. Cut the summary.

## Load points

- `skills/blog-draft.md` references this file in its prerequisites.
  The draft skill gets a compressed version in its prompt.
- `skills/blog-evaluate.md` loads the hard-rules section verbatim so
  the structural reviewer flags voice drift.
- `.claude-plugin/skills/blog/SKILL.md` references this rule when
  proposing `blog research set-section` content, so the plan-step
  prose is already voice-compliant before it enters the hash gate.
- `templates/draft/template.mdx` comment block points the author here.

## What this rule is not

- Not a ban on formal writing when the subject is formal.
- Not a prescription that every post sound identical. A project
  launch can be punchier than a methodology deep-dive.
- Not a substitute for having something to say. Voice rules don't
  rescue a post that lacks a thesis. They just keep a real thesis
  from getting buried under filler.
