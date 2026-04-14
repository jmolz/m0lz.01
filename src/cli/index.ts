#!/usr/bin/env node

import 'dotenv/config';
import { Command } from 'commander';

import { registerInit } from './init.js';
import { registerStatus } from './status.js';
import { registerMetrics } from './metrics.js';
import { registerIdeas } from './ideas.js';
import { registerResearch } from './research.js';

const program = new Command();

program
  .name('blog')
  .description('m0lz.01 — idea-to-distribution pipeline for technical content')
  .version('0.1.0');

registerInit(program);
registerStatus(program);
registerMetrics(program);
registerIdeas(program);
registerResearch(program);

program.parse();
