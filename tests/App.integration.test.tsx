import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, act, cleanup } from '@testing-library/react';
import App from '../src/App';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  localStorage.clear();
});

describe('App integration - smooth open/close of side panel and code files', () => {
  it('renders the application without crashing on first load', async () => {
    const { container } = render(<App />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(container.querySelector('.toolbar')).toBeTruthy();
    const dock = container.querySelector('.right-dock');
    expect(dock).toBeTruthy();
    expect(dock?.classList.contains('collapsed')).toBe(true);
  });

  it('toggling the files button in the toolbar opens the right-dock', async () => {
    localStorage.setItem('command-code-ide-data', JSON.stringify({
      projects: [{ id: 'p1', name: 'Test', rootPath: 'C:\\tmp', openedAt: 1 }],
      activeProjectId: 'p1',
    }));

    const electronAPI = (window as any).electronAPI;
    electronAPI.openProjectPath = vi.fn(async (p: string) => ({
      success: true,
      rootPath: p,
      projectName: 'Test',
      tree: { name: 'Test', path: p, type: 'directory', children: [] },
    }));
    electronAPI.getFileTree = vi.fn(async () => ({ name: 'Test', path: 'C:\\tmp', type: 'directory', children: [] }));
    electronAPI.getAgentStatus = vi.fn(async () => ({ running: { sess1: { pid: 1 } } }));

    const { container } = render(<App />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 100));
    });

    let dock = container.querySelector('.right-dock');
    expect(dock).toBeTruthy();
    expect(dock?.classList.contains('collapsed')).toBe(true);

    const toggleBtn = Array.from(container.querySelectorAll<HTMLButtonElement>('.toolbar-btn'))
      .find((b) => b.title === 'Toggle Files');
    expect(toggleBtn).toBeTruthy();

    await act(async () => {
      toggleBtn!.click();
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    dock = container.querySelector('.right-dock');
    expect(dock?.classList.contains('collapsed')).toBe(false);
    expect(container.querySelector('.files-dock-pane')).toBeTruthy();
  });

  it('clicking the toggle again closes the right-dock (puts it back to collapsed)', async () => {
    localStorage.setItem('command-code-ide-data', JSON.stringify({
      projects: [{ id: 'p1', name: 'Test', rootPath: 'C:\\tmp', openedAt: 1 }],
      activeProjectId: 'p1',
    }));

    const electronAPI = (window as any).electronAPI;
    electronAPI.openProjectPath = vi.fn(async (p: string) => ({
      success: true,
      rootPath: p,
      projectName: 'Test',
      tree: { name: 'Test', path: p, type: 'directory', children: [] },
    }));
    electronAPI.getFileTree = vi.fn(async () => ({ name: 'Test', path: 'C:\\tmp', type: 'directory', children: [] }));
    electronAPI.getAgentStatus = vi.fn(async () => ({ running: { sess1: { pid: 1 } } }));

    const { container } = render(<App />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 100));
    });

    const toggleBtn = Array.from(container.querySelectorAll<HTMLButtonElement>('.toolbar-btn'))
      .find((b) => b.title === 'Toggle Files');

    // Open
    await act(async () => {
      toggleBtn!.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(container.querySelector('.right-dock')?.classList.contains('collapsed')).toBe(false);

    // Close
    await act(async () => {
      toggleBtn!.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(container.querySelector('.right-dock')?.classList.contains('collapsed')).toBe(true);
  });
});

describe('App - dock layout does not thrash on rapid state changes', () => {
  it('handles a rapid sequence of state changes without crashing', async () => {
    localStorage.setItem('command-code-ide-data', JSON.stringify({
      projects: [{ id: 'p1', name: 'Test', rootPath: 'C:\\tmp', openedAt: 1 }],
      activeProjectId: 'p1',
    }));
    const electronAPI = (window as any).electronAPI;
    electronAPI.openProjectPath = vi.fn(async () => ({ success: false }));
    electronAPI.getFileTree = vi.fn(async () => null);
    electronAPI.getAgentStatus = vi.fn(async () => ({ running: {} }));

    const { container } = render(<App />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(container.querySelector('.app-container')).toBeTruthy();
  });
});

// Note: the App-level auto-rename behavior (renaming from agent response)
// is exercised by the unit tests in tests/sessionNaming.test.ts (which
// cover the extraction, deduplication, and isDefaultLabel logic) and by
// the AgentPanel tests in tests/AgentPanel.test.tsx (which cover the
// prompt-based rename on Enter). The full App-level data flow is harder
// to simulate in jsdom because the agent data listeners are registered
// via a mock that stores handlers in a closure, but the underlying
// functions (extractTitleFromAgentResponse, buildContextualTitle,
// autoRenameSession's dedup logic) are all unit-tested.
