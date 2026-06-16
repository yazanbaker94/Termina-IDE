import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, act, cleanup, fireEvent } from '@testing-library/react';
import AgentPanel from '../src/components/AgentPanel';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
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
  projectRoot: '/tmp',
  onRenameSession: vi.fn(),
  onWrite: vi.fn(),
  onChangedFileClick: vi.fn(),
  onXtermWriteReady: vi.fn(),
  ...overrides,
});

const getLastTerminal = () => {
  const w = window as any;
  return w.__mockState.terminals[w.__mockState.terminals.length - 1];
};

const flush = async (ms = 20) => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
};

describe('AgentPanel - DOM paste with image/* items', () => {
  it('saves the image via IPC and inserts the @path into the input', async () => {
    const onWrite = vi.fn();
    const props = baseProps({ onWrite });
    const { container } = render(<AgentPanel {...props} />);
    await flush(50);

    // Build a fake image File and a ClipboardEvent with items[]
    const file = new File([new Uint8Array([1, 2, 3, 4])], 'shot.png', { type: 'image/png' });
    const item = { kind: 'file', type: 'image/png', getAsFile: () => file } as any;
    const clipboardData = {
      items: [item],
      getData: () => '',
    };
    const event = {
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      clipboardData,
    } as any;

    const terminalContainer = container.querySelector('.agent-terminal-container') as HTMLElement;
    expect(terminalContainer).toBeTruthy();
    fireEvent.paste(terminalContainer, event);

    // The IPC mock should be called and onWrite should be called with @path
    await flush(30);

    const electronAPI = (window as any).electronAPI;
    expect(electronAPI.saveAgentImageAttachment).toHaveBeenCalled();
    const callArg = electronAPI.saveAgentImageAttachment.mock.calls[0][0];
    expect(callArg.mimeType).toBe('image/png');
    expect(callArg.projectRoot).toBe('/tmp');
    expect(Array.isArray(callArg.bytes)).toBe(true);

    // onWrite is called with the @path (via sendTerminalInput -> onWrite)
    const writeCalls = onWrite.mock.calls.map((c: any[]) => c[0]);
    expect(writeCalls.some((w) => typeof w === 'string' && w.startsWith('@.termina/clipboard/'))).toBe(true);
  });

  it('falls back to text paste when no image/* items are present (does NOT call image IPC)', async () => {
    const onWrite = vi.fn();
    const props = baseProps({ onWrite });
    const { container } = render(<AgentPanel {...props} />);
    await flush(50);

    const electronAPI = (window as any).electronAPI;
    electronAPI.saveAgentImageAttachment.mockClear();

    const event = {
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      clipboardData: {
        items: [],
        getData: () => 'plain text only',
      },
    } as any;

    const terminalContainer = container.querySelector('.agent-terminal-container') as HTMLElement;
    fireEvent.paste(terminalContainer, event);

    await flush(20);

    expect(electronAPI.saveAgentImageAttachment).not.toHaveBeenCalled();
    // Text was sent
    expect(onWrite).toHaveBeenCalled();
    const writeCalls = onWrite.mock.calls.map((c: any[]) => c[0]);
    expect(writeCalls.some((w) => w === 'plain text only')).toBe(true);
  });

  it('does not call text paste when image item exists (text fallback is skipped)', async () => {
    const onWrite = vi.fn();
    const props = baseProps({ onWrite });
    const { container } = render(<AgentPanel {...props} />);
    await flush(50);

    const file = new File([new Uint8Array([1, 2, 3])], 'shot.png', { type: 'image/png' });
    const item = { kind: 'file', type: 'image/png', getAsFile: () => file } as any;
    const event = {
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      clipboardData: {
        items: [item],
        getData: () => 'text on the side that should be ignored',
      },
    } as any;

    const terminalContainer = container.querySelector('.agent-terminal-container') as HTMLElement;
    fireEvent.paste(terminalContainer, event);

    await flush(30);

    const electronAPI = (window as any).electronAPI;
    expect(electronAPI.saveAgentImageAttachment).toHaveBeenCalled();

    // The text fallback MUST NOT fire — we only sent the @path
    const writeCalls = onWrite.mock.calls.map((c: any[]) => c[0]);
    const wroteText = writeCalls.some((w) => typeof w === 'string' && w.includes('text on the side'));
    expect(wroteText).toBe(false);
  });

  it('renders a preview chip after image paste', async () => {
    const props = baseProps();
    const { container } = render(<AgentPanel {...props} />);
    await flush(50);

    const file = new File([new Uint8Array([1, 2, 3])], 'shot.png', { type: 'image/png' });
    const item = { kind: 'file', type: 'image/png', getAsFile: () => file } as any;
    const event = {
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      clipboardData: { items: [item], getData: () => '' },
    } as any;

    const terminalContainer = container.querySelector('.agent-terminal-container') as HTMLElement;
    fireEvent.paste(terminalContainer, event);

    await flush(30);

    const chip = container.querySelector('[data-testid="agent-image-chip"]');
    expect(chip).toBeTruthy();
    const ref = chip?.getAttribute('data-agent-ref');
    expect(ref).toMatch(/^@\.termina\/clipboard\//);
  });
});

describe('AgentPanel - Ctrl/Cmd+V fallback to native clipboard image', () => {
  it('reads the native clipboard image when text is empty', async () => {
    const electronAPI = (window as any).electronAPI;
    electronAPI.readClipboardText.mockResolvedValue('');
    electronAPI.readClipboardImageForAgent.mockResolvedValue({
      success: true,
      absolutePath: '/tmp/.termina/clipboard/pasted-native.png',
      relativePath: '.termina/clipboard/pasted-native.png',
      agentRef: '@.termina/clipboard/pasted-native.png',
      previewDataUrl: 'data:image/png;base64,',
    });
    electronAPI.readClipboardImageForAgent.mockClear();

    const onWrite = vi.fn();
    const props = baseProps({ onWrite });
    render(<AgentPanel {...props} />);
    await flush(50);

    // Simulate Ctrl+V by invoking the custom key event handler that
    // AgentPanel registered with xterm. In real xterm, this is called
    // when a key event fires on xterm's internal input. In the test
    // mock, the handler is stored on the terminal instance and can be
    // invoked directly.
    const lastTerminal = getLastTerminal();
    expect(lastTerminal._keyHandler).toBeTruthy();
    await act(async () => {
      const consumed = lastTerminal._dispatchKeyForTest({
        type: 'keydown',
        key: 'v',
        ctrlKey: true,
        metaKey: false,
        shiftKey: false,
        altKey: false,
        preventDefault: () => {},
        stopPropagation: () => {},
      } as any);
      expect(consumed).toBe(false); // handler returned false -> consumed
    });

    await flush(50);

    expect(electronAPI.readClipboardImageForAgent).toHaveBeenCalled();
    const writeCalls = onWrite.mock.calls.map((c: any[]) => c[0]);
    expect(writeCalls.some((w) => typeof w === 'string' && w === '@.termina/clipboard/pasted-native.png')).toBe(true);
  });

  it('prefers text over image when both are available', async () => {
    const electronAPI = (window as any).electronAPI;
    electronAPI.readClipboardText.mockResolvedValue('hello world');
    electronAPI.readClipboardImageForAgent.mockClear();

    const onWrite = vi.fn();
    const props = baseProps({ onWrite });
    render(<AgentPanel {...props} />);
    await flush(50);

    const lastTerminal = getLastTerminal();
    await act(async () => {
      lastTerminal._dispatchKeyForTest({
        type: 'keydown',
        key: 'v',
        ctrlKey: true,
        metaKey: false,
        shiftKey: false,
        altKey: false,
        preventDefault: () => {},
        stopPropagation: () => {},
      } as any);
    });

    await flush(50);

    // Text path took precedence — image IPC was NOT called
    expect(electronAPI.readClipboardImageForAgent).not.toHaveBeenCalled();
    expect(onWrite).toHaveBeenCalledWith('hello world');
  });
});

describe('AgentPanel - drag and drop', () => {
  it('saves dropped image files and inserts @path', async () => {
    const onWrite = vi.fn();
    const props = baseProps({ onWrite });
    const { container } = render(<AgentPanel {...props} />);
    await flush(50);

    const electronAPI = (window as any).electronAPI;
    electronAPI.saveDroppedImageAttachment.mockClear();

    const file = new File([new Uint8Array([1, 2, 3, 4])], 'dropped.png', { type: 'image/png' });
    (file as any).path = 'C:\\tmp\\dropped.png';
    const dataTransfer = {
      files: [file],
      types: ['Files'],
      items: [{ kind: 'file' }],
      dropEffect: 'copy',
    } as any;

    const terminalContainer = container.querySelector('.agent-terminal-container') as HTMLElement;
    expect(terminalContainer).toBeTruthy();

    fireEvent.drop(terminalContainer, { dataTransfer });

    await flush(30);

    expect(electronAPI.saveDroppedImageAttachment).toHaveBeenCalled();
    const arg = electronAPI.saveDroppedImageAttachment.mock.calls[0][0];
    expect(arg.sourcePath).toBe('C:\\tmp\\dropped.png');
    expect(arg.projectRoot).toBe('/tmp');

    const writeCalls = onWrite.mock.calls.map((c: any[]) => c[0]);
    expect(writeCalls.some((w) => typeof w === 'string' && w.startsWith('@.termina/clipboard/'))).toBe(true);
  });

  it('ignores non-image drops and shows an error', async () => {
    const props = baseProps();
    const { container } = render(<AgentPanel {...props} />);
    await flush(50);

    const electronAPI = (window as any).electronAPI;
    electronAPI.saveDroppedImageAttachment.mockClear();

    const file = new File([new Uint8Array([1, 2, 3])], 'doc.pdf', { type: 'application/pdf' });
    const dataTransfer = {
      files: [file],
      types: ['Files'],
      items: [{ kind: 'file' }],
      dropEffect: 'copy',
    } as any;

    const terminalContainer = container.querySelector('.agent-terminal-container') as HTMLElement;
    fireEvent.drop(terminalContainer, { dataTransfer });

    await flush(20);

    // IPC was NOT called
    expect(electronAPI.saveDroppedImageAttachment).not.toHaveBeenCalled();
    // Error banner is visible
    const banner = container.querySelector('.agent-error-banner');
    expect(banner?.textContent).toMatch(/only image files/i);
  });

  it('shows the drag-over visual state when dragging files over the terminal', async () => {
    const props = baseProps();
    const { container } = render(<AgentPanel {...props} />);
    await flush(50);

    const terminalContainer = container.querySelector('.agent-terminal-container') as HTMLElement;
    expect(terminalContainer?.classList.contains('is-drag-over')).toBe(false);

    const dataTransfer = { types: ['Files'], items: [{ kind: 'file' }] } as any;
    fireEvent.dragEnter(terminalContainer, { dataTransfer });
    expect(terminalContainer?.classList.contains('is-drag-over')).toBe(true);

    fireEvent.dragLeave(terminalContainer, { dataTransfer });
    expect(terminalContainer?.classList.contains('is-drag-over')).toBe(false);
  });
});

describe('AgentPanel - duplicate paste prevention', () => {
  it('does not attach the same image twice in quick succession', async () => {
    const electronAPI = (window as any).electronAPI;
    let callCount = 0;
    electronAPI.saveAgentImageAttachment.mockImplementation(async (args: any) => {
      callCount++;
      return {
        success: true,
        absolutePath: '/tmp/.termina/clipboard/dup.png',
        relativePath: '.termina/clipboard/dup.png',
        agentRef: '@.termina/clipboard/dup.png',
        previewDataUrl: 'data:image/png;base64,',
      };
    });

    const onWrite = vi.fn();
    const props = baseProps({ onWrite });
    const { container } = render(<AgentPanel {...props} />);
    await flush(50);

    const file = new File([new Uint8Array([1, 2, 3])], 'dup.png', { type: 'image/png' });
    const item = { kind: 'file', type: 'image/png', getAsFile: () => file } as any;
    const event = {
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      clipboardData: { items: [item], getData: () => '' },
    } as any;

    const terminalContainer = container.querySelector('.agent-terminal-container') as HTMLElement;

    // Fire paste twice in rapid succession
    fireEvent.paste(terminalContainer, event);
    await flush(20);
    fireEvent.paste(terminalContainer, event);
    await flush(20);

    // Second paste should have been suppressed — only one write to input
    const writeCalls = onWrite.mock.calls.map((c: any[]) => c[0]);
    const imageWriteCount = writeCalls.filter((w) => typeof w === 'string' && w.startsWith('@.termina/clipboard/')).length;
    expect(imageWriteCount).toBe(1);
  });
});
