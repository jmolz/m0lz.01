import { platform, release, arch, cpus, totalmem } from 'node:os';
import { execSync } from 'node:child_process';

export interface EnvironmentSnapshot {
  os: string;
  os_release: string;
  arch: string;
  cpus: string;
  total_memory_gb: number;
  node_version: string;
  npm_version: string;
  captured_at: string;
}

function safeExec(command: string): string {
  try {
    return execSync(command, { encoding: 'utf-8' }).trim();
  } catch {
    return 'unknown';
  }
}

export function captureEnvironment(): EnvironmentSnapshot {
  const cpuInfo = cpus();
  const cpuModel = cpuInfo.length > 0 ? cpuInfo[0].model : 'unknown';

  return {
    os: platform(),
    os_release: release(),
    arch: arch(),
    cpus: `${cpuModel} x ${cpuInfo.length}`,
    total_memory_gb: Math.round(totalmem() / (1024 ** 3)),
    node_version: safeExec('node --version'),
    npm_version: safeExec('npm --version'),
    captured_at: new Date().toISOString(),
  };
}

export function formatEnvironmentMarkdown(env: EnvironmentSnapshot): string {
  return [
    `- **OS:** ${env.os} ${env.os_release}`,
    `- **Architecture:** ${env.arch}`,
    `- **CPUs:** ${env.cpus}`,
    `- **Memory:** ${env.total_memory_gb} GB`,
    `- **Node.js:** ${env.node_version}`,
    `- **npm:** ${env.npm_version}`,
    `- **Captured:** ${env.captured_at}`,
  ].join('\n');
}
