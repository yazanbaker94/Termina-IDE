import { describe, it, expect, beforeEach } from 'vitest';
import { loadAppData, saveAppData, generateId, StoredProject, StoredSession } from '../src/data/store';

describe('store', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('returns empty defaults when storage is empty', () => {
    const data = loadAppData();
    expect(data.projects).toEqual([]);
    expect(data.activeProjectId).toBeNull();
  });

  it('persists and reloads app data', () => {
    const project: StoredProject = { id: 'p1', name: 'Test', rootPath: '/tmp/test', openedAt: 1 };
    saveAppData({ projects: [project], activeProjectId: 'p1' });
    const reloaded = loadAppData();
    expect(reloaded.projects).toEqual([project]);
    expect(reloaded.activeProjectId).toBe('p1');
  });

  it('handles corrupt localStorage gracefully', () => {
    localStorage.setItem('command-code-ide-data', 'not-json');
    const data = loadAppData();
    expect(data.projects).toEqual([]);
    expect(data.activeProjectId).toBeNull();
  });

  it('generateId returns unique strings', () => {
    const a = generateId();
    const b = generateId();
    expect(a).not.toBe(b);
    expect(typeof a).toBe('string');
    expect(a.length).toBeGreaterThan(0);
  });
});
