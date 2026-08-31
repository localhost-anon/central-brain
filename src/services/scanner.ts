import fs from 'node:fs';
import path from 'node:path';

export interface ProjectInfo {
  name: string;
  path: string;
  markers: string[];
  hasGit: boolean;
  language?: string;
  framework?: string;
  packageManager?: string;
}

const MARKERS = ['.git', 'package.json', 'pyproject.toml', 'requirements.txt',
  'go.mod', 'Cargo.toml', 'docker-compose.yml', 'Dockerfile'];
const SKIP = new Set(['node_modules', 'dist', 'build', '.venv', 'venv', '__pycache__']);
const FRAMEWORK_DEPS = ['next', '@nestjs/core', 'react', 'vue', 'express', 'fastify', 'commander'];

export function detectProject(dir: string): Omit<ProjectInfo, 'name'> | null {
  let entries: string[];
  try { entries = fs.readdirSync(dir); } catch { return null; }
  const markers = MARKERS.filter(m => entries.includes(m));
  if (markers.length === 0) return null;
  const info: Omit<ProjectInfo, 'name'> = { path: dir, markers, hasGit: markers.includes('.git') };
  if (entries.includes('package.json')) {
    info.language = entries.includes('tsconfig.json') ? 'typescript' : 'javascript';
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      const deps: Record<string, string> = { ...pkg.dependencies, ...pkg.devDependencies };
      const fw = FRAMEWORK_DEPS.find(f => f in deps);
      info.framework = fw === '@nestjs/core' ? 'nestjs' : fw;
    } catch { /* unreadable manifest: metadata stays unset */ }
    info.packageManager = entries.includes('pnpm-lock.yaml') ? 'pnpm'
      : entries.includes('yarn.lock') ? 'yarn'
      : entries.includes('package-lock.json') ? 'npm' : undefined;
  } else if (entries.includes('pyproject.toml') || entries.includes('requirements.txt')) {
    info.language = 'python';
  } else if (entries.includes('go.mod')) {
    info.language = 'go';
  } else if (entries.includes('Cargo.toml')) {
    info.language = 'rust';
  }
  return info;
}

function childDirs(dir: string): string[] {
  return fs.readdirSync(dir).filter(e => {
    if (SKIP.has(e) || e.startsWith('.')) return false;
    try { return fs.statSync(path.join(dir, e)).isDirectory(); } catch { return false; }
  });
}

export function discoverProjects(rootDir: string): ProjectInfo[] {
  const found: ProjectInfo[] = [];
  for (const entry of childDirs(rootDir)) {
    const dir = path.join(rootDir, entry);
    const info = detectProject(dir);
    if (info) {
      found.push({ name: entry, ...info });
      continue;
    }
    // marker-less dir: treat as sub-workspace, descend exactly one more level
    for (const child of childDirs(dir)) {
      const cinfo = detectProject(path.join(dir, child));
      if (cinfo) found.push({ name: `${entry}/${child}`, ...cinfo });
    }
  }
  return found;
}
