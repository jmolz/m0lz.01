import { ContentType } from '../db/types.js';
import { PostFrontmatter, serializeFrontmatter } from './frontmatter.js';

// Guidance comment injected between frontmatter and the first section. MDX
// strips JSX comments at compile time so this is invisible in the published
// output; it survives as context for the author/agent editing the draft.
// Full rules live at .claude/rules/voice.md (dev) and
// .claude-plugin/skills/blog/VOICE.md (plugin, shipped with the tarball).
const VOICE_COMMENT = `{/*
  Voice rules: .claude/rules/voice.md (dev), .claude-plugin/skills/blog/VOICE.md (plugin).
  Quick gist: direct declaratives, no hedges, no tricolon stacks, no topic-restatement
  transitions, no smarmy openers, no undefined jargon, ~1 em dash per 500 words max
  (substitute period / comma / parens / cut first), no emojis. Structural reviewer
  flags voice drift with category='voice' at evaluation time.
*/}`;

export interface DraftContext {
  contentType: ContentType;
  benchmarkTable?: string;
  methodologyRef?: string;
  researchThesis?: string;
  researchFindings?: string;
  existingTags: string[];
}

export function renderDraftTemplate(frontmatter: PostFrontmatter, context: DraftContext): string {
  const sections: string[] = [];

  sections.push(serializeFrontmatter(frontmatter));
  sections.push('');
  sections.push(VOICE_COMMENT);
  sections.push('');

  // Introduction (all content types)
  sections.push('## Introduction');
  sections.push('');
  if (context.researchThesis) {
    sections.push(context.researchThesis);
  } else {
    sections.push('{/* TODO: Fill this section */}');
  }
  sections.push('');

  // Content-type-specific sections
  switch (context.contentType) {
    case 'technical-deep-dive':
      sections.push('## Architecture');
      sections.push('');
      sections.push('{/* TODO: Fill this section */}');
      sections.push('');
      sections.push('## Benchmark Results');
      sections.push('');
      if (context.benchmarkTable) {
        sections.push(context.benchmarkTable);
      } else {
        sections.push('{/* TODO: Fill this section */}');
      }
      sections.push('');
      sections.push('## Methodology');
      sections.push('');
      if (context.methodologyRef) {
        sections.push(context.methodologyRef);
      } else {
        sections.push('{/* TODO: Fill this section */}');
      }
      sections.push('');
      break;

    case 'project-launch':
      sections.push('## What It Does');
      sections.push('');
      sections.push('{/* TODO: Fill this section */}');
      sections.push('');
      sections.push('## How It Works');
      sections.push('');
      sections.push('{/* TODO: Fill this section */}');
      sections.push('');
      sections.push('## Architecture');
      sections.push('');
      sections.push('{/* TODO: Fill this section */}');
      sections.push('');
      if (context.benchmarkTable) {
        sections.push('## Benchmark Results');
        sections.push('');
        sections.push(context.benchmarkTable);
        sections.push('');
        if (context.methodologyRef) {
          sections.push('## Methodology');
          sections.push('');
          sections.push(context.methodologyRef);
          sections.push('');
        }
      }
      break;

    case 'analysis-opinion':
      sections.push('## Analysis');
      sections.push('');
      sections.push('{/* TODO: Fill this section */}');
      sections.push('');
      sections.push('## Key Takeaways');
      sections.push('');
      sections.push('{/* TODO: Fill this section */}');
      sections.push('');
      break;
  }

  // Conclusion (all content types)
  sections.push('## Conclusion');
  sections.push('');
  sections.push('{/* TODO: Fill this section */}');
  sections.push('');

  return sections.join('\n');
}
