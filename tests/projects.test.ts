import { describe, it, expect } from 'vitest';
import { createTestDb } from './helpers.js';
import { addProject, getProject, listProjects, addRepo, listRepos } from '../src/services/projects.js';

describe('projects & repos', () => {
  it('adds and resolves projects by id or name', () => {
    const db = createTestDb();
    const p = addProject(db, { name: 'Central Brain', rootPath: '$HOME/Projects/central-brain' });
    expect(p.id).toBe('central-brain');
    expect(getProject(db, 'central-brain').name).toBe('Central Brain');
    expect(getProject(db, 'Central Brain').id).toBe('central-brain');
    expect(listProjects(db)).toHaveLength(1);
    expect(() => addProject(db, { name: 'Central Brain' })).toThrow(/exists/i);
  });

  it('adds repos linked to projects', () => {
    const db = createTestDb();
    const p = addProject(db, { name: 'Prospera' });
    const r = addRepo(db, { name: 'prospera-api', projectId: p.id, language: 'typescript' });
    expect(r.id).toBe('prospera-api');
    expect(listRepos(db, p.id)).toHaveLength(1);
    expect(() => addRepo(db, { name: 'x', projectId: 'nope' })).toThrow(/not found/i);
  });
});
