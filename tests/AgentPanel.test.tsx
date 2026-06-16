import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, act, cleanup } from '@testing-library/react';
import AgentPanel from '../src/components/AgentPanel';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  // Clear the mock state arrays so tests don't see terminals/fits from previous tests
  const w = window as any;
  if (w.__mockState) {
    w.__mockState.terminals.length = 0;
    w.__mockState.fits.length = 0;
  }
});

const baseProps = (overrides: any = {}) => ({
  sessionId: 'sess1',
  status: 'running' as const,
  exitCode: null,
  error: '',
  changedFiles: [],
  terminalBuffer: '',
  restartCount: 0,
  resizeSignal: 0,
  hasProject: true,
  sessionLabel: 'Chat 1',
  onRenameSession: vi.fn(),
  onWrite: vi.fn(),
  onChangedFileClick: vi.fn(),
  onXtermWriteReady: vi.fn(),
  ...overrides,
});

// Access the global mock state installed by setup.ts
const getMockState = () => {
  const w = window as any;
  return w.__mockState || (w.__mockState = { terminals: [], fits: [] });
};

describe('AgentPanel - terminal smoothing (no twitch)', () => {
  it('does NOT recreate the terminal when terminalBuffer updates (no flicker)', async () => {
    const props = baseProps({ terminalBuffer: 'line1\n' });
    const { rerender } = render(<AgentPanel {...props} />);

    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    // Grab all terminal instances created so far
    const state = getMockState();
    const terminalsAfterFirst = state.terminals.length;
    expect(terminalsAfterFirst).toBeGreaterThan(0);

    // Now update terminalBuffer MANY times (simulating incoming data)
    for (let i = 0; i < 20; i++) {
      const props2 = baseProps({ terminalBuffer: `line1\nline${i}\n` });
      rerender(<AgentPanel {...props2} />);
    }

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    // No new terminals should have been created
    const terminalsAfterUpdate = state.terminals.length;
    expect(terminalsAfterUpdate).toBe(terminalsAfterFirst);
  });

  it('coalesces resize calls via requestAnimationFrame (no storm)', async () => {
    const props = baseProps();
    render(<AgentPanel {...props} />);

    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    const state = getMockState();
    const lastTerminal = state.terminals[state.terminals.length - 1];
    const resizeCallsBefore = lastTerminal.resize.mock.calls.length;

    // Simulate a burst of resize events
    for (let i = 0; i < 10; i++) {
      window.dispatchEvent(new Event('resize'));
    }

    // After RAF flush...
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });

    const lastTerminalAfter = state.terminals[state.terminals.length - 1];
    const newCalls = lastTerminalAfter.resize.mock.calls.length - resizeCallsBefore;
    // With the same dimensions, resize should not be called (since proposeDimensions returns the same cols/rows as the terminal already has)
    // If a different terminal got created, the original was disposed — but that shouldn't happen here.
    expect(newCalls).toBe(0);
  });

  it('passes latest terminalBuffer to terminal on init (no stale buffer)', async () => {
    const props = baseProps({ terminalBuffer: 'hello world\nsecond line' });
    render(<AgentPanel {...props} />);

    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    const state = getMockState();
    // Find the most recent terminal
    const allWrites = state.terminals
      .flatMap((t: any) => t.write.mock.calls.map((c: any[]) => c[0]))
      .join('');
    expect(allWrites).toContain('hello world');
    expect(allWrites).toContain('second line');
  });

  it('recreates terminal only when sessionId changes', async () => {
    const props = baseProps();
    const { rerender } = render(<AgentPanel {...props} />);

    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    const state = getMockState();
    const terminalsBeforeChange = state.terminals.length;
    const lastTerminalBefore = state.terminals[state.terminals.length - 1];
    const disposeCallsBefore = lastTerminalBefore.dispose.mock.calls.length;

    // Change sessionId
    const props2 = baseProps({ sessionId: 'sess2' });
    rerender(<AgentPanel {...props2} />);

    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    // A new terminal should have been created AND the old one disposed
    expect(state.terminals.length).toBeGreaterThan(terminalsBeforeChange);
    const lastTerminalAfter = state.terminals[state.terminals.length - 1];
    const oldTerminalDisposed = lastTerminalBefore.dispose.mock.calls.length > disposeCallsBefore;
    expect(oldTerminalDisposed).toBe(true);
    // The new terminal should be a different object
    expect(lastTerminalAfter).not.toBe(lastTerminalBefore);
  });

  it('does not call term.resize when proposed dimensions match current (no-op)', async () => {
    const props = baseProps();
    render(<AgentPanel {...props} />);

    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    const state = getMockState();
    const lastTerminal = state.terminals[state.terminals.length - 1];
    const initialResizeCount = lastTerminal.resize.mock.calls.length;

    // Trigger many resize events with the same dimensions
    for (let i = 0; i < 5; i++) {
      window.dispatchEvent(new Event('resize'));
    }

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    // No new resize should have been called (mock returns same cols/rows)
    const lastTerminalAfter = state.terminals[state.terminals.length - 1];
    const finalResizeCount = lastTerminalAfter.resize.mock.calls.length;
    expect(finalResizeCount).toBe(initialResizeCount);
  });

  it('cleans up resize timer and RAF on unmount', async () => {
    const props = baseProps();
    const { unmount } = render(<AgentPanel {...props} />);

    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    // Schedule a resize
    window.dispatchEvent(new Event('resize'));

    // Unmount immediately - should not throw
    expect(() => unmount()).not.toThrow();
  });

  it('skips term.resize while dockTransitioningRef.current is true (no mid-transition rewrap)', async () => {
    // Simulate the right-dock CSS transition by having the ref set to true
    const dockTransitioningRef = { current: true };
    const props = baseProps({ dockTransitioningRef });
    render(<AgentPanel {...props} />);

    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    const state = getMockState();
    const lastTerminal = state.terminals[state.terminals.length - 1];
    const resizeCallsBefore = lastTerminal.resize.mock.calls.length;

    // Make the proposed dimensions DIFFERENT from current so a refit would actually fire
    // (otherwise syncResize short-circuits on the "dimensions match" check).
    const fitInstance = state.fits[state.fits.length - 1];
    fitInstance.proposeDimensions = vi.fn(() => ({ cols: 100, rows: 40 }));

    // Burst of resize events that would normally trigger refits
    for (let i = 0; i < 10; i++) {
      window.dispatchEvent(new Event('resize'));
    }

    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });

    // No new resize should have been called because the dock is transitioning
    const lastTerminalAfter = state.terminals[state.terminals.length - 1];
    const newCalls = lastTerminalAfter.resize.mock.calls.length - resizeCallsBefore;
    expect(newCalls).toBe(0);
  });

  it('resumes term.resize once dockTransitioningRef flips back to false', async () => {
    const dockTransitioningRef = { current: true };
    const props = baseProps({ dockTransitioningRef });
    render(<AgentPanel {...props} />);

    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    const state = getMockState();
    const fitInstance = state.fits[state.fits.length - 1];
    const lastTerminal = state.terminals[state.terminals.length - 1];
    // Replace proposeDimensions so a refit is actually needed
    fitInstance.proposeDimensions = vi.fn(() => ({ cols: 100, rows: 40 }));

    // While transitioning, no refits
    for (let i = 0; i < 5; i++) {
      window.dispatchEvent(new Event('resize'));
    }
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    const resizeDuringTransition = lastTerminal.resize.mock.calls.length;
    expect(resizeDuringTransition).toBe(0);

    // Transition ends
    dockTransitioningRef.current = false;
    window.dispatchEvent(new Event('resize'));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    const lastTerminalAfter = state.terminals[state.terminals.length - 1];
    const resizeAfterTransition = lastTerminalAfter.resize.mock.calls.length;
    expect(resizeAfterTransition).toBeGreaterThan(0);
  });
});

describe('AgentPanel - session auto-naming from first prompt', () => {
  // The agent writes the user's input back to the terminal (echo).
  // recordTerminalInputForTitle observes this stream and extracts a title
  // when the user presses Enter.

  it('renames the session on Enter when the prompt is meaningful', async () => {
    const onRenameSession = vi.fn();
    const props = baseProps({ sessionLabel: 'Chat 1', onRenameSession });
    const term = render(<AgentPanel {...props} />);

    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });

    // Get the terminal's onData handler (called on every keypress)
    const state = getMockState();
    const lastTerminal = state.terminals[state.terminals.length - 1];
    const onDataCalls = lastTerminal.onData.mock.calls;
    expect(onDataCalls.length).toBeGreaterThan(0);
    const onData = onDataCalls[0][0] as (data: string) => void;

    // Simulate user typing and pressing Enter
    await act(async () => {
      onData('Fix the login bug on the homepage\r');
    });

    expect(onRenameSession).toHaveBeenCalled();
    const [sid, label] = onRenameSession.mock.calls[onRenameSession.mock.calls.length - 1];
    expect(sid).toBe('sess1');
    expect(typeof label).toBe('string');
    expect((label as string).length).toBeGreaterThan(0);
    // Should be derived from the prompt, not "Chat"
    expect((label as string).toLowerCase()).toContain('fix');

    term.unmount();
  });

  it('does not rename when the prompt is just a noise command', async () => {
    const onRenameSession = vi.fn();
    const props = baseProps({ sessionLabel: 'Chat 1', onRenameSession });
    const term = render(<AgentPanel {...props} />);

    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });

    const state = getMockState();
    const lastTerminal = state.terminals[state.terminals.length - 1];
    const onData = lastTerminal.onData.mock.calls[0][0] as (data: string) => void;

    await act(async () => {
      onData('/help\r');
    });

    expect(onRenameSession).not.toHaveBeenCalled();

    term.unmount();
  });

  it('does not rename when the current label is a custom (manually-set) name', async () => {
    const onRenameSession = vi.fn();
    const props = baseProps({ sessionLabel: 'My custom chat', onRenameSession });
    const term = render(<AgentPanel {...props} />);

    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });

    const state = getMockState();
    const lastTerminal = state.terminals[state.terminals.length - 1];
    const onData = lastTerminal.onData.mock.calls[0][0] as (data: string) => void;

    await act(async () => {
      onData('Fix the login bug on the homepage\r');
    });

    expect(onRenameSession).not.toHaveBeenCalled();

    term.unmount();
  });

  it('renames at most once per session (first meaningful prompt only)', async () => {
    const onRenameSession = vi.fn();
    const props = baseProps({ sessionLabel: 'Chat 1', onRenameSession });
    const term = render(<AgentPanel {...props} />);

    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });

    const state = getMockState();
    const lastTerminal = state.terminals[state.terminals.length - 1];
    const onData = lastTerminal.onData.mock.calls[0][0] as (data: string) => void;

    await act(async () => {
      onData('Fix the login bug\r');
    });
    const callsAfterFirst = onRenameSession.mock.calls.length;

    await act(async () => {
      onData('Now do something completely different\r');
    });
    const callsAfterSecond = onRenameSession.mock.calls.length;

    expect(callsAfterSecond).toBe(callsAfterFirst);

    term.unmount();
  });
});
