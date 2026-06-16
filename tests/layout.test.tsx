import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('Layout CSS - no twitch on dock open', () => {
  let css: string;

  beforeEach(() => {
    css = readFileSync(join(__dirname, '..', 'src', 'index.css'), 'utf-8');
  });

  it('has contain:layout on agent-region to isolate layout shifts', () => {
    expect(css).toMatch(/\.agent-region\s*\{[^}]*contain:\s*layout/);
  });

  it('has contain:layout on right-dock to isolate internal layout', () => {
    expect(css).toMatch(/\.right-dock\s*\{[^}]*contain:\s*layout/);
  });

  it('has min-width: 0 on agent-region to prevent flex overflow', () => {
    expect(css).toMatch(/\.agent-region\s*\{[^}]*min-width:\s*0/);
  });

  it('has fixed width on code-dock-pane to keep layout stable', () => {
    expect(css).toMatch(/\.code-dock-pane\s*\{[^}]*width:\s*520px/);
  });

  it('has overflow: hidden on dock-pane to prevent internal scroll flicker', () => {
    expect(css).toMatch(/\.dock-pane\s*\{[^}]*overflow:\s*hidden/);
  });

  it('has min-height: 0 on dock-pane for flex stability', () => {
    expect(css).toMatch(/\.dock-pane\s*\{[^}]*min-height:\s*0/);
  });

  it('app-main uses CSS grid for smooth column transitions', () => {
    expect(css).toMatch(/\.app-main\s*\{[^}]*display:\s*grid/);
  });

  it('app-main transitions grid-template-columns for smooth dock open/close', () => {
    expect(css).toMatch(/\.app-main\s*\{[^}]*transition:[\s\S]{0,100}grid-template-columns/);
  });

  it('dock transition CSS uses a short duration (0.15s) and a smooth easing curve', () => {
    // The transition should be short enough to feel snappy but long enough to be visible
    expect(css).toMatch(/grid-template-columns\s+0\.15s\s+cubic-bezier/);
  });

  it('collapsed right-dock hides inner dock-panes (visibility: hidden) so they dont intercept clicks', () => {
    expect(css).toMatch(/\.right-dock\.collapsed\s+\.dock-pane\s*\{[^}]*visibility:\s*hidden/);
  });
});

describe('App.tsx - dock resize timing', () => {
  it('waits for CSS transition to finish before triggering dock resize signal (avoids mid-transition rewrap)', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'App.tsx'), 'utf-8');
    // The effect that handles rightDockOpen should listen to transitionend
    expect(src).toMatch(/transitionend/);
    // It should specifically check for the grid-template-columns transition
    expect(src).toMatch(/grid-template-columns/);
    // It should have a safety timeout in case the transition doesn't fire
    expect(src).toMatch(/setTimeout\([\s\S]{0,500}setDockResizeTick/);
  });

  it('applies --right-dock-width as a CSS variable on app-main to drive the grid transition', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'App.tsx'), 'utf-8');
    expect(src).toMatch(/--right-dock-width/);
    expect(src).toMatch(/setProperty\('--right-dock-width'/);
  });

  it('right-dock is always rendered (with .collapsed class when closed) for smooth transition', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'App.tsx'), 'utf-8');
    // The right-dock div should NOT be wrapped in a conditional render
    // (it should be in the JSX unconditionally, with a class toggle)
    expect(src).toMatch(/right-dock\$?\{rightDockOpen[\s\S]{0,200}collapsed/);
  });

  it('handleFileSelect does not set isLoading before clearing activeDiff (avoids layout shift)', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'App.tsx'), 'utf-8');
    // The order in handleFileSelect should be: setActiveDiff(null) THEN setIsLoading(true) THEN await readFile
    const handleFileSelectMatch = src.match(/handleFileSelect[\s\S]{0,1500}/);
    expect(handleFileSelectMatch).toBeTruthy();
    const body = handleFileSelectMatch![0];
    const setActiveDiffPos = body.indexOf('setActiveDiff(null)');
    const setIsLoadingPos = body.indexOf('setIsLoading(true)');
    const readFilePos = body.indexOf('window.electronAPI.readFile');
    expect(setActiveDiffPos).toBeGreaterThanOrEqual(0);
    expect(readFilePos).toBeGreaterThan(setActiveDiffPos);
  });
});

describe('AgentPanel.tsx - xterm stability', () => {
  it('initTerminal does not depend on terminalBuffer (avoids re-create on data)', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'components', 'AgentPanel.tsx'), 'utf-8');
    // Find initTerminal and check its useCallback deps
    const match = src.match(/const initTerminal = useCallback\(\(\) => \{[\s\S]+?\},\s*\[([^\]]+)\]\);/);
    expect(match).toBeTruthy();
    const deps = match![1];
    expect(deps).not.toMatch(/terminalBuffer/);
  });

  it('uses terminalBufferRef so initTerminal can read latest buffer', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'components', 'AgentPanel.tsx'), 'utf-8');
    expect(src).toMatch(/terminalBufferRef\.current/);
    expect(src).toMatch(/const terminalBufferRef = useRef\(terminalBuffer\)/);
  });

  it('syncResize is wrapped in requestAnimationFrame (coalesces resize storm)', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'components', 'AgentPanel.tsx'), 'utf-8');
    expect(src).toMatch(/syncResize[\s\S]{0,400}requestAnimationFrame/);
  });

  it('does not re-create ResizeObserver on every render', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'components', 'AgentPanel.tsx'), 'utf-8');
    // The ResizeObserver should be inside a useEffect with stable deps ([syncResize])
    const roEffect = src.match(/new ResizeObserver\([\s\S]+?\}\);?\s*\}/);
    expect(roEffect).toBeTruthy();
  });

  it('cancels pending resize RAF on unmount', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'components', 'AgentPanel.tsx'), 'utf-8');
    expect(src).toMatch(/cancelAnimationFrame\(resizeRafRef\.current\)/);
  });
});

describe('Editor.tsx - no parent loading prop dependency', () => {
  it('renders Monaco even when not loading (uses Monaco own loading state)', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'components', 'Editor.tsx'), 'utf-8');
    // Editor should NOT conditionally skip rendering Monaco based on isLoading
    // The pattern to look for: isLoading ? <div> : <Editor />
    expect(src).not.toMatch(/isLoading\s*\?\s*\([\s\S]{0,200}<div/);
  });
});
