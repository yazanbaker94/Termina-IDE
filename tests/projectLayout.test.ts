import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

describe('project layout', () => {
  it('.gitignore exists', () => {
    const path = join(__dirname, '..', '.gitignore');
    expect(existsSync(path)).toBe(true);
  });

  it('.gitignore excludes .termina/clipboard (per-project agent image storage)', () => {
    const gitignore = readFileSync(join(__dirname, '..', '.gitignore'), 'utf-8');
    // Match the .termina entry broadly — it covers .termina/clipboard/ and any
    // future per-project scratch folders.
    expect(gitignore).toMatch(/^\.termina\//m);
  });

  it('.gitignore excludes node_modules, dist, dist-electron, release, coverage', () => {
    const gitignore = readFileSync(join(__dirname, '..', '.gitignore'), 'utf-8');
    for (const entry of ['node_modules/', 'dist/', 'dist-electron/', 'release/', 'coverage/']) {
      expect(gitignore).toContain(entry);
    }
  });
});

describe('agent image attachment - source wiring', () => {
  it('main.ts registers agent:saveImageAttachment IPC handler', () => {
    const src = readFileSync(join(__dirname, '..', 'electron', 'main.ts'), 'utf-8');
    expect(src).toMatch(/ipcMain\.handle\(['"]agent:saveImageAttachment['"]/);
  });

  it('main.ts registers agent:saveDroppedImageAttachment IPC handler', () => {
    const src = readFileSync(join(__dirname, '..', 'electron', 'main.ts'), 'utf-8');
    expect(src).toMatch(/ipcMain\.handle\(['"]agent:saveDroppedImageAttachment['"]/);
  });

  it('main.ts registers agent:readClipboardImageAttachment IPC handler', () => {
    const src = readFileSync(join(__dirname, '..', 'electron', 'main.ts'), 'utf-8');
    expect(src).toMatch(/ipcMain\.handle\(['"]agent:readClipboardImageAttachment['"]/);
  });

  it('preload.ts exposes saveAgentImageAttachment, saveDroppedImageAttachment, readClipboardImageForAgent', () => {
    const src = readFileSync(join(__dirname, '..', 'electron', 'preload.ts'), 'utf-8');
    expect(src).toMatch(/saveAgentImageAttachment:/);
    expect(src).toMatch(/saveDroppedImageAttachment:/);
    expect(src).toMatch(/readClipboardImageForAgent:/);
  });

  it('types declare the new agent image attachment methods on ElectronAPI', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'types', 'index.ts'), 'utf-8');
    expect(src).toMatch(/saveAgentImageAttachment:/);
    expect(src).toMatch(/saveDroppedImageAttachment:/);
    expect(src).toMatch(/readClipboardImageForAgent:/);
    expect(src).toMatch(/AgentImageAttachmentResult/);
  });

  it('AgentPanel checks for image/* items in the DOM paste handler', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'components', 'AgentPanel.tsx'), 'utf-8');
    expect(src).toMatch(/clipboardData\?\.items/);
    expect(src).toMatch(/image\//);
  });

  it('AgentPanel has drag-and-drop handlers on the terminal container', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'components', 'AgentPanel.tsx'), 'utf-8');
    expect(src).toMatch(/onDragEnter=/);
    expect(src).toMatch(/onDragOver=/);
    expect(src).toMatch(/onDrop=/);
  });

  it('AgentPanel never embeds base64 into the terminal input (only @path)', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'components', 'AgentPanel.tsx'), 'utf-8');
    // The attachPastedImageFile handler must call sendTerminalInput with
    // result.agentRef, not any data: URL.
    const insertPattern = /sendTerminalInput\(result\.agentRef/;
    expect(src).toMatch(insertPattern);
    // The string 'data:' should not appear in the context of sending input
    // to xterm.
    const dataUrlInTerminalInput = /sendTerminalInput\([^)]*data:/;
    expect(src).not.toMatch(dataUrlInTerminalInput);
  });
});
