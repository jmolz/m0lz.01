import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';

import { validateSlug } from '../research/document.js';
import { TEMPLATES_ROOT } from '../paths.js';
import { EnvironmentSnapshot } from './environment.js';
import { formatEnvironmentMarkdown } from './environment.js';

export interface CompanionOptions {
  slug: string;
  topic: string;
  targets: string[];
  environment: EnvironmentSnapshot;
  methodology: string;
}

function getMethodologyTemplatePath(): string {
  return resolve(TEMPLATES_ROOT, 'benchmark/methodology.md');
}

export function scaffoldCompanion(
  reposDir: string,
  options: CompanionOptions,
): string {
  validateSlug(options.slug);

  const repoPath = join(reposDir, options.slug);
  mkdirSync(join(repoPath, 'src'), { recursive: true });
  mkdirSync(join(repoPath, 'results'), { recursive: true });

  writeMethodology(repoPath, options.environment, {
    runCount: 0,
    testSetup: options.methodology || 'To be documented after test harness creation.',
  });

  const targetsMarkdown = options.targets
    .map((t) => `- ${t}`)
    .join('\n');

  const readme = [
    `# ${options.slug}`,
    '',
    `Companion benchmark repo for: ${options.topic}`,
    '',
    '## Benchmark Targets',
    '',
    targetsMarkdown,
    '',
    '## Blog Post',
    '',
    `See the full write-up at: https://m0lz.dev/writing/${options.slug}`,
    '',
    '## Reproduce',
    '',
    'See `METHODOLOGY.md` for environment details and reproduction steps.',
    '',
    '## License',
    '',
    'MIT',
    '',
  ].join('\n');

  writeFileSync(join(repoPath, 'README.md'), readme, 'utf-8');
  writeFileSync(join(repoPath, 'LICENSE'), 'MIT License\n', 'utf-8');

  return repoPath;
}

export function writeMethodology(
  repoPath: string,
  env: EnvironmentSnapshot,
  options: { runCount: number; testSetup?: string; limitations?: string },
): string {
  const templatePath = getMethodologyTemplatePath();
  let template = readFileSync(templatePath, 'utf-8');

  const envMarkdown = formatEnvironmentMarkdown(env);

  template = template
    .replace('{{environment_details}}', envMarkdown)
    .replace('{{test_setup}}', options.testSetup ?? 'To be documented.')
    .replace('{{methodology_description}}', 'To be documented after test execution.')
    .replace('{{reproduction_steps}}', 'To be documented after test harness creation.')
    .replace('{{limitations}}', options.limitations ?? 'To be documented.')
    .replace('{{run_count}}', String(options.runCount));

  const methodologyPath = join(repoPath, 'METHODOLOGY.md');
  mkdirSync(dirname(methodologyPath), { recursive: true });
  writeFileSync(methodologyPath, template, 'utf-8');

  return methodologyPath;
}
