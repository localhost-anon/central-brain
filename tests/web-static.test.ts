import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

describe('static UI', () => {
  it('ships index.html, styles.css and a syntactically valid app.js wired to the API', () => {
    const html = fs.readFileSync('web/index.html', 'utf8');
    expect(html).toContain('<title>Central Brain</title>');
    expect(html).toContain('app.js');
    expect(fs.existsSync('web/styles.css')).toBe(true);
    execFileSync(process.execPath, ['--check', 'web/app.js']);
    const js = fs.readFileSync('web/app.js', 'utf8');
    for (const route of ['/api/goals', '/api/needs-you', '/api/events', '/api/projects', '/api/questions/', '/api/approvals/']) {
      expect(js).toContain(route);
    }
    expect(js).toContain('function esc(');
  });

  it('brain ui is registered', () => {
    const help = execFileSync('npx', ['tsx', 'src/cli/index.ts', 'ui', '--help'], { encoding: 'utf8' });
    expect(help).toContain('--port');
    expect(help).toContain('--no-open');
  });
});
