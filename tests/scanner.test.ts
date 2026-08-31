import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectProject, discoverProjects } from '../src/services/scanner.js';

let root: string;

function mk(rel: string, content = ''): void {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-scan-'));
  // TS/node app with git, npm lockfile, react
  mk('node-app/package.json', JSON.stringify({ name: 'node-app', dependencies: { react: '^18.0.0' } }));
  mk('node-app/tsconfig.json', '{}');
  mk('node-app/package-lock.json', '{}');
  fs.mkdirSync(path.join(root, 'node-app', '.git'), { recursive: true });
  // python app
  mk('py-app/pyproject.toml', '[project]\nname = "py-app"');
  // sub-workspace: no markers itself, contains a go project
  mk('workspace/sub-go/go.mod', 'module example.com/sub');
  // plain dir with no markers anywhere
  fs.mkdirSync(path.join(root, 'plain-dir', 'stuff'), { recursive: true });
  // noise dirs get real markers so a broken skip-list would surface them
  mk('node_modules/x/package.json', '{}');
  mk('.hidden/package.json', '{}');
});

describe('scanner detection', () => {
  it('detects a node project with metadata', () => {
    const info = detectProject(path.join(root, 'node-app'))!;
    expect(info.hasGit).toBe(true);
    expect(info.language).toBe('typescript');
    expect(info.framework).toBe('react');
    expect(info.packageManager).toBe('npm');
    expect(info.markers).toContain('package.json');
  });

  it('detects python and returns null for marker-less dirs', () => {
    expect(detectProject(path.join(root, 'py-app'))!.language).toBe('python');
    expect(detectProject(path.join(root, 'plain-dir'))).toBeNull();
    expect(detectProject(path.join(root, 'does-not-exist'))).toBeNull();
  });

  it('discovers top-level and sub-workspace projects, skipping noise', () => {
    const names = discoverProjects(root).map(p => p.name).sort();
    expect(names).toEqual(['node-app', 'py-app', 'workspace/sub-go']);
    const go = discoverProjects(root).find(p => p.name === 'workspace/sub-go')!;
    expect(go.language).toBe('go');
  });
});
