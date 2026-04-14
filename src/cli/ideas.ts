import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

import { Command } from 'commander';
import yaml from 'js-yaml';

import { getDatabase, closeDatabase } from '../core/db/database.js';
import { ContentType } from '../core/db/types.js';

const IDEAS_PATH = resolve('.blog-agent', 'ideas.yaml');
const DB_PATH = resolve('.blog-agent', 'state.db');

export interface IdeaEntry {
  topic: string;
  type: ContentType;
  priority: 'high' | 'medium' | 'low';
  notes: string;
  project?: string;
  added_at: string;
}

const PRIORITY_ORDER = { high: 0, medium: 1, low: 2 } as const;

export function registerIdeas(program: Command): void {
  const ideas = program
    .command('ideas')
    .description('Manage the editorial backlog')
    .action(() => {
      listIdeas();
    });

  ideas
    .command('add <topic>')
    .description('Add an idea to the backlog')
    .option('--type <type>', 'Content type', 'analysis-opinion')
    .option('--priority <priority>', 'Priority level', 'medium')
    .option('--notes <notes>', 'Additional notes', '')
    .option('--project <id>', 'Catalog project ID')
    .action((topic: string, opts: { type: string; priority: string; notes: string; project?: string }) => {
      addIdea(topic, opts.type as ContentType, opts.priority as IdeaEntry['priority'], opts.notes, opts.project);
    });

  ideas
    .command('start <index>')
    .description('Promote an idea to the research phase')
    .action((index: string) => {
      try {
        startIdea(parseInt(index, 10));
      } catch (e) {
        console.error((e as Error).message);
        process.exit(1);
      }
    });

  ideas
    .command('remove <index>')
    .description('Remove an idea from the backlog')
    .action((index: string) => {
      try {
        removeIdea(parseInt(index, 10));
      } catch (e) {
        console.error((e as Error).message);
        process.exit(1);
      }
    });
}

export function loadIdeas(yamlPath: string): IdeaEntry[] {
  if (!existsSync(yamlPath)) return [];
  const content = readFileSync(yamlPath, 'utf-8');
  const parsed = yaml.load(content);
  if (!Array.isArray(parsed)) return [];
  return parsed as IdeaEntry[];
}

export function saveIdeas(yamlPath: string, ideas: IdeaEntry[]): void {
  mkdirSync(dirname(yamlPath), { recursive: true });
  if (ideas.length === 0) {
    writeFileSync(yamlPath, '', 'utf-8');
    return;
  }
  writeFileSync(yamlPath, yaml.dump(ideas, { lineWidth: 120 }), 'utf-8');
}

function sortByPriority(ideas: IdeaEntry[]): IdeaEntry[] {
  return [...ideas].sort((a, b) => (PRIORITY_ORDER[a.priority] ?? 1) - (PRIORITY_ORDER[b.priority] ?? 1));
}

function listIdeas(): void {
  const ideas = sortByPriority(loadIdeas(IDEAS_PATH));

  if (ideas.length === 0) {
    console.log('No ideas in the backlog. Add one with: blog ideas add "topic"');
    return;
  }

  for (let i = 0; i < ideas.length; i++) {
    const idea = ideas[i];
    const project = idea.project ? ` [${idea.project}]` : '';
    const notes = idea.notes ? ` -- ${idea.notes}` : '';
    console.log(`  ${i + 1}. [${idea.priority}] ${idea.topic}${project} (${idea.type})${notes}`);
  }
}

function addIdea(topic: string, type: ContentType, priority: IdeaEntry['priority'], notes: string, project?: string): void {
  const ideas = loadIdeas(IDEAS_PATH);

  ideas.push({
    topic,
    type,
    priority,
    notes,
    project,
    added_at: new Date().toISOString(),
  });

  saveIdeas(IDEAS_PATH, ideas);
  console.log(`Added: "${topic}" [${priority}] (${type})`);
}

export function startIdea(index: number, ideasPath = IDEAS_PATH, dbPath = DB_PATH): void {
  const ideas = sortByPriority(loadIdeas(ideasPath));

  if (index < 1 || index > ideas.length) {
    throw new Error(`Invalid index: ${index}. Valid range: 1-${ideas.length}.`);
  }

  const idea = ideas[index - 1];

  if (!existsSync(dbPath)) {
    throw new Error("No state database found. Run 'blog init' first.");
  }

  const db = getDatabase(dbPath);
  try {
    // Create a slug from the topic
    const slug = idea.topic
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');

    db.prepare(`
      INSERT OR IGNORE INTO posts (slug, title, topic, content_type, phase, mode, project_id)
      VALUES (?, ?, ?, ?, 'research', 'exploratory', ?)
    `).run(slug, idea.topic, idea.topic, idea.type, idea.project || null);
  } finally {
    closeDatabase(db);
  }

  // Remove from ideas list
  ideas.splice(index - 1, 1);
  saveIdeas(ideasPath, ideas);

  console.log(`Started: "${idea.topic}" -- now in research phase`);
}

export function removeIdea(index: number, ideasPath = IDEAS_PATH): void {
  const ideas = sortByPriority(loadIdeas(ideasPath));

  if (index < 1 || index > ideas.length) {
    throw new Error(`Invalid index: ${index}. Valid range: 1-${ideas.length}.`);
  }

  const removed = ideas.splice(index - 1, 1)[0];
  saveIdeas(ideasPath, ideas);
  console.log(`Removed: "${removed.topic}"`);
}
