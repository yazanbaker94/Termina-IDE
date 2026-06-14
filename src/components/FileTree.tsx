import React, { useState, useCallback, useRef, useEffect } from 'react';
import { ChevronRight, File, Folder, FolderOpen, FilePlus, FolderPlus, Trash2, PenLine, ExternalLink, ClipboardPaste, Copy } from 'lucide-react';
import { FileNode } from '../types';

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'webp', 'svg']);

interface FileTreeProps {
  tree: FileNode | null;
  activeFilePath: string;
  onFileSelect: (node: FileNode) => void;
  onRefreshTree: () => Promise<void> | void;
  onCloseActiveFile?: () => void;
  onPaste?: (targetDir: string) => Promise<void>;
}

interface ContextMenuData {
  x: number; y: number;
  kind: 'root' | 'folder' | 'file';
  path: string;
  name: string;
}

interface EditingState {
  type: 'rename' | 'createFile' | 'createFolder';
  path?: string;
  originalName?: string;
  parentDir?: string;
  tempId?: string;
}

const ContextMenu: React.FC<{
  data: ContextMenuData;
  onClose: () => void;
  onAction: (action: string, data: ContextMenuData) => Promise<void>;
}> = ({ data, onClose, onAction }) => {
  const doAction = async (action: string) => {
    await onAction(action, data);
    onClose();
  };

  return (
    <div className="file-context-menu" style={{ position: 'fixed', left: data.x, top: data.y, zIndex: 100 }}
      onClick={(e) => e.stopPropagation()} onContextMenu={(e) => e.preventDefault()}>
      {(data.kind === 'root' || data.kind === 'folder') && (
        <>
          <button className="file-context-item" onClick={() => doAction('newFile')}><FilePlus size={11} /><span>New File</span></button>
          <button className="file-context-item" onClick={() => doAction('newFolder')}><FolderPlus size={11} /><span>New Folder</span></button>
          <button className="file-context-item" onClick={() => doAction('paste')}>
            <ClipboardPaste size={11} /><span>Paste</span>
            <span className="file-context-item-hint">screenshots &amp; clipboard data</span>
          </button>
          <div className="file-context-separator" />
        </>
      )}
      {(data.kind === 'folder' || data.kind === 'file') && (
        <button className="file-context-item" onClick={() => doAction('rename')}><PenLine size={11} /><span>Rename</span></button>
      )}
      <button className="file-context-item" onClick={() => doAction('delete')}><Trash2 size={11} /><span>Delete</span></button>
      <div className="file-context-separator" />
      <button className="file-context-item" onClick={() => doAction('copyRelativePath')}><Copy size={11} /><span>Copy Relative Path</span></button>
      <button className="file-context-item" onClick={() => doAction('reveal')}><ExternalLink size={11} /><span>Reveal in Explorer</span></button>
    </div>
  );
};

function getFileIcon(name: string, iconCache: Record<string, React.ReactNode>) {
  const ext = name.split('.').pop()?.toLowerCase();
  const key = ext || 'file';
  if (!iconCache[key]) {
    iconCache[key] = <File size={14} />;
  }
  return iconCache[key];
}

interface TreeNodeRowProps {
  node: FileNode;
  depth: number;
  activeFilePath: string;
  selectedPath: string | null;
  onSelect: (node: FileNode) => void;
  onFileSelect: (node: FileNode) => void;
  onOpenContextMenu: (kind: 'file' | 'folder', node: FileNode, x: number, y: number) => void;
}

const TreeNodeRow: React.FC<TreeNodeRowProps> = React.memo(({ node, depth, activeFilePath, selectedPath, onSelect, onFileSelect, onOpenContextMenu }) => {
  const [expanded, setExpanded] = useState(depth < 1);
  const isDir = node.type === 'directory';
  const hasChildren = !!node.children?.length;
  const isActive = activeFilePath === node.path;
  const isSelected = selectedPath === node.path;

  const handleClick = (e: React.MouseEvent) => {
    onSelect(node);
    if (!isDir) { onFileSelect(node); }
    else if (hasChildren) { setExpanded(!expanded); }
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onSelect(node);
    onOpenContextMenu(isDir ? 'folder' : 'file', node, e.clientX, e.clientY);
  };

  const cls = [
    isDir ? 'tree-folder' : 'file-item',
    isActive ? 'active' : '',
    isSelected ? 'selected' : '',
  ].filter(Boolean).join(' ');

  if (!isDir) {
    return (
      <button
        data-tree-row="true"
        data-path={node.path}
        data-kind="file"
        className={cls}
        style={{ paddingLeft: 8 + depth * 16 }}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
      >
        <span className="file-icon">{getFileIcon(node.name, {})}</span>
        <span className="file-name">{node.name}</span>
      </button>
    );
  }

  return (
    <div>
      <button
        data-tree-row="true"
        data-path={node.path}
        data-kind="folder"
        className={cls}
        style={{ paddingLeft: 8 + depth * 16 }}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
      >
        <span className="tree-chevron" style={{ transform: expanded ? 'rotate(90deg)' : undefined }}>
          <ChevronRight size={12} />
        </span>
        <span className="file-icon">
          {expanded ? <FolderOpen size={14} /> : <Folder size={14} />}
        </span>
        <span className="file-name">{node.name}</span>
      </button>
      {expanded && hasChildren && (
        <div>
          {node.children!.map((child) => (
            <TreeNodeRow
              key={child.path}
              node={child}
              depth={depth + 1}
              activeFilePath={activeFilePath}
              selectedPath={selectedPath}
              onSelect={onSelect}
              onFileSelect={onFileSelect}
              onOpenContextMenu={onOpenContextMenu}
            />
          ))}
        </div>
      )}
    </div>
  );
});

interface EditingRowProps {
  type: 'rename' | 'createFile' | 'createFolder';
  depth: number;
  defaultValue?: string;
  placeholder?: string;
  onConfirm: (value: string) => Promise<void>;
  onCancel: () => void;
}

const EditingRow: React.FC<EditingRowProps> = ({ type, depth, defaultValue, placeholder, onConfirm, onCancel }) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const t = setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 50);
    return () => clearTimeout(t);
  }, []);

  const confirm = async () => {
    const val = inputRef.current?.value.trim() ?? '';
    if (!val) { setError('Name cannot be empty'); return; }
    if (val.includes('/') || val.includes('\\')) { setError('Name cannot contain / or \\'); return; }
    try { await onConfirm(val); } catch (err: any) { setError(err?.message ?? 'Operation failed'); }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); confirm(); }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancel(); }
    e.stopPropagation();
  };

  const icon = type === 'createFolder' ? <Folder size={14} /> : <File size={14} />;

  return (
    <div className="file-item editing" style={{ paddingLeft: 8 + depth * 16 }}>
      <span className="file-icon">{icon}</span>
      <div className="file-edit-inline">
        <input ref={inputRef} className={`file-edit-input ${error ? 'file-edit-input-error' : ''}`}
          defaultValue={defaultValue} placeholder={placeholder}
          onKeyDown={handleKeyDown} onBlur={() => onCancel()} />
        {error && <span className="file-edit-error">{error}</span>}
      </div>
    </div>
  );
};

const FileTree: React.FC<FileTreeProps> = ({ tree, activeFilePath, onFileSelect, onRefreshTree, onCloseActiveFile, onPaste }) => {
  const [menu, setMenu] = useState<ContextMenuData | null>(null);
  const [editing, setEditing] = useState<EditingState | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [selectedKind, setSelectedKind] = useState<'file' | 'folder' | null>(null);
  const [pasting, setPasting] = useState(false);
  const closeMenu = useCallback(() => setMenu(null), []);
  const rootPath = tree?.path ?? '';
  const fileTreeRef = useRef<HTMLDivElement>(null);

  // Selection tracking
  const handleSelect = useCallback((node: FileNode) => {
    setSelectedPath(node.path);
    setSelectedKind(node.type === 'directory' ? 'folder' : 'file');
  }, []);

  // Escape key — close menu or clear selection
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    const tag = (e.target as HTMLElement).tagName;
    const isInput = tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement).isContentEditable;

    // Delete key
    if (e.key === 'Delete' && !isInput && selectedPath && selectedKind) {
      e.preventDefault();
      const name = selectedPath.split(/[\\/]/).pop() || selectedPath;
      const msg = selectedKind === 'folder'
        ? `Delete folder "${name}" and all its contents? This cannot be undone.`
        : `Delete "${name}"?`;
      if (!window.confirm(msg)) return;
      if (activeFilePath && (activeFilePath === selectedPath || activeFilePath.startsWith(selectedPath + '/'))) {
        onCloseActiveFile?.();
      }
      window.electronAPI.deletePath(selectedPath).then((r) => {
        if (!r.success) alert(r.error);
        setSelectedPath(null); setSelectedKind(null);
        onRefreshTree();
      }).catch((err) => { alert('Delete failed: ' + err); });
      return;
    }

    // Ctrl+V paste via selection
    if ((e.ctrlKey || e.metaKey) && e.key === 'v' && !isInput) {
      e.preventDefault();
      let targetDir = rootPath;
      if (selectedKind === 'folder' && selectedPath) { targetDir = selectedPath; }
      else if (selectedKind === 'file' && selectedPath) { targetDir = selectedPath.replace(/[\\/][^\\/]*$/, ''); }
      if (!targetDir || !onPaste || pasting) return;
      setPasting(true);
      onPaste(targetDir).finally(() => setPasting(false));
    }
  }, [selectedPath, selectedKind, rootPath, onPaste, pasting, activeFilePath, onCloseActiveFile, onRefreshTree]);

  const getPasteTargetDir = useCallback((): string | null => {
    if (menu && (menu.kind === 'folder' || menu.kind === 'root')) return menu.path;
    if (selectedKind === 'folder' && selectedPath) return selectedPath;
    if (selectedKind === 'file' && selectedPath) return selectedPath.replace(/[\\/][^\\/]*$/, '');
    return rootPath || null;
  }, [menu, selectedKind, selectedPath, rootPath]);

  const pasteBlobToDir = useCallback(async (targetDir: string, blob: Blob, filename?: string) => {
    const arrBuf = await blob.arrayBuffer();
    const bytes = Array.from(new Uint8Array(arrBuf));
    const r = await window.electronAPI.writePastedBuffer({ targetDir, filename, mimeType: blob.type, bytes });
    if (!r.success) { alert(r.error); return; }
    await onRefreshTree();
    if (r.path) { onFileSelect({ name: r.path.split(/[\\/]/).pop() ?? 'pasted', path: r.path, type: 'file' }); }
  }, [onRefreshTree, onFileSelect]);

  // Ctrl+V onPaste DOM handler — fires naturally
  const handlePasteEvent = useCallback(async (e: React.ClipboardEvent) => {
    const tag = (e.target as HTMLElement).tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement).isContentEditable) return;
    e.preventDefault();
    const targetDir = getPasteTargetDir();
    if (!targetDir || pasting) return;
    setPasting(true);

    try {
      const items = Array.from(e.clipboardData?.items ?? []);
      const files = Array.from(e.clipboardData?.files ?? []);

      for (const item of items) {
        if (item.kind === 'file' && item.type.match(/^image\//)) {
          const blob = item.getAsFile();
          if (blob) { await pasteBlobToDir(targetDir, blob, blob.name); setPasting(false); return; }
        }
      }

      if (files.length > 0) {
        const sourcePaths: string[] = [];
        for (const f of files) {
          const anyFile = f as any;
          if (anyFile.path) sourcePaths.push(anyFile.path);
        }
        if (sourcePaths.length > 0) {
          const r = await window.electronAPI.copyExternalFiles(targetDir, sourcePaths);
          if (!r.success) alert(r.error);
          else { await onRefreshTree(); }
          setPasting(false); return;
        }
        for (const f of files) {
          if (f.type.match(/^image\//)) {
            await pasteBlobToDir(targetDir, f, f.name);
            setPasting(false); return;
          }
        }
      }

      if (onPaste) await onPaste(targetDir);
    } finally { setPasting(false); }
  }, [onPaste, getPasteTargetDir, pasteBlobToDir, onRefreshTree, pasting]);

  // Context-menu Paste
  const contextMenuPaste = useCallback(async (targetDir: string) => {
    console.log('=== [cm-paste:start] targetDir:', targetDir);
    try {
      const debug = await window.electronAPI.getClipboardDebug();
      console.log('[cm-paste:debug]', { platform: debug.platform, formats: debug.formats, imageIsEmpty: debug.imageIsEmpty, textLength: debug.textLength, htmlLength: debug.htmlLength, bufferLengths: debug.bufferLengths, navClipboard: typeof navigator?.clipboard?.read === 'function' });
    } catch {}
    try {
      if (typeof navigator?.clipboard?.read === 'function') {
        const items = await navigator.clipboard.read();
        for (const item of items) {
          for (const type of item.types) {
            if (type.startsWith('image/')) { const blob = await item.getType(type); await pasteBlobToDir(targetDir, blob); return; }
            if (type === 'text/html') {
              const text = await (await item.getType(type)).text();
              const match = text.match(/<img[^>]+src=["']([^"']+)["']/i);
              if (match) {
                const src = match[1];
                if (src.startsWith('data:image/')) {
                  const parts = src.split(',');
                  if (parts[1]) {
                    const ext = src.includes('image/png') ? '.png' : src.includes('image/jpeg') ? '.jpg' : '.png';
                    const bytes = Array.from(new Uint8Array(atob(parts[1]).split('').map(c => c.charCodeAt(0))));
                    const r = await window.electronAPI.writePastedBuffer({ targetDir, mimeType: `image/${ext.slice(1)}`, bytes });
                    if (r.success) { await onRefreshTree(); if (r.path) onFileSelect({ name: r.path.split(/[\\/]/).pop() ?? 'pasted', path: r.path, type: 'file' }); return; }
                  }
                }
                if (src.startsWith('blob:')) { alert('This app cannot paste private browser blob URLs. Use Ctrl+V after copying the image itself, or drag/download the image file.'); return; }
              }
            }
          }
        }
      }
    } catch (e: any) { console.log('[cm-paste:nav:error]', e.name, e.message); }
    if (onPaste) await onPaste(targetDir);
  }, [onPaste, pasteBlobToDir, onRefreshTree, onFileSelect]);

  // Close menu on Escape, scroll, outside click
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const handleEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    const handleClick = (e: MouseEvent) => {
      const menuEl = document.querySelector('.file-context-menu');
      if (menuEl && !menuEl.contains(e.target as Node)) close();
    };
    document.addEventListener('keydown', handleEsc);
    document.addEventListener('click', handleClick, true);
    return () => {
      document.removeEventListener('keydown', handleEsc);
      document.removeEventListener('click', handleClick, true);
    };
  }, [menu]);

  const openMenu = useCallback((kind: ContextMenuData['kind'], nodeOrPath: FileNode | string, x: number, y: number) => {
    const p = typeof nodeOrPath === 'string' ? nodeOrPath : nodeOrPath.path;
    const n = typeof nodeOrPath === 'string' ? p.split(/[\\/]/).pop() || p : nodeOrPath.name;
    setMenu({ x: Math.min(x, window.innerWidth - 180), y: Math.min(y, window.innerHeight - 200), kind, path: p, name: n });
  }, []);

  const handleAction = useCallback(async (action: string, data: ContextMenuData) => {
    console.log('[file-action]', action, data.kind, data.path);
    const targetDir = data.kind === 'folder' ? data.path : rootPath;

    try {
      switch (action) {
        case 'newFile': {
          const dir = targetDir;
          if (!dir) return;
          setEditing({ type: 'createFile', parentDir: dir, tempId: Math.random().toString(36) });
          break;
        }
        case 'newFolder': {
          const dir = targetDir;
          if (!dir) return;
          setEditing({ type: 'createFolder', parentDir: dir, tempId: Math.random().toString(36) });
          break;
        }
        case 'rename': {
          setEditing({ type: 'rename', path: data.path, originalName: data.name });
          break;
        }
        case 'paste': {
          const dir = targetDir || data.path;
          if (!dir || pasting) return;
          setPasting(true);
          try { await contextMenuPaste(dir); } finally { setPasting(false); }
          break;
        }
        case 'delete': {
          const isDir = data.kind === 'folder' || data.kind === 'root';
          const msg = isDir
            ? `Delete folder "${data.name}" and all its contents? This cannot be undone.`
            : `Delete "${data.name}"?`;
          if (!window.confirm(msg)) return;
          if (activeFilePath && (activeFilePath === data.path || activeFilePath.startsWith(data.path + '/'))) {
            onCloseActiveFile?.();
          }
          const r = await window.electronAPI.deletePath(data.path);
          if (!r.success) alert(r.error);
          if (selectedPath === data.path) { setSelectedPath(null); setSelectedKind(null); }
          await onRefreshTree();
          break;
        }
        case 'copyRelativePath': {
          try { await navigator.clipboard.writeText(data.path); } catch {}
          break;
        }
        case 'reveal': {
          const r = await window.electronAPI.revealInExplorer(data.path);
          if (!r.success) alert(r.error);
          break;
        }
      }
    } catch (err) {
      console.error('[file-action] error:', action, err);
      alert(`Operation failed: ${err}`);
    }
  }, [rootPath, onRefreshTree, activeFilePath, onCloseActiveFile, onFileSelect, contextMenuPaste, pasting, selectedPath]);

  const confirmRename = useCallback(async (value: string) => {
    if (!editing?.path || !editing?.originalName) return;
    if (value === editing.originalName) { setEditing(null); return; }
    const r = await window.electronAPI.renamePath(editing.path, value);
    if (!r.success) throw new Error(r.error);
    setEditing(null);
    await onRefreshTree();
  }, [editing, onRefreshTree]);

  const confirmCreate = useCallback(async (value: string) => {
    if (!editing?.parentDir) return;
    if (editing.type === 'createFile') {
      const r = await window.electronAPI.createFile(editing.parentDir, value);
      if (!r.success) throw new Error(r.error);
      setEditing(null);
      await onRefreshTree();
      if (r.path) onFileSelect({ name: value, path: r.path, type: 'file' });
    } else if (editing.type === 'createFolder') {
      const r = await window.electronAPI.createFolder(editing.parentDir, value);
      if (!r.success) throw new Error(r.error);
      setEditing(null);
      await onRefreshTree();
    }
  }, [editing, onRefreshTree, onFileSelect]);

  const handleRootContext = (e: React.MouseEvent) => {
    e.preventDefault();
    const row = (e.target as HTMLElement).closest('[data-tree-row="true"]');
    if (row) return;
    if (!rootPath) return;
    setSelectedPath(null); setSelectedKind(null);
    openMenu('root', rootPath, e.clientX, e.clientY);
  };

  const handleNodeContext = useCallback((kind: 'file' | 'folder', node: FileNode, x: number, y: number) => {
    openMenu(kind, node, x, y);
  }, [openMenu]);

  const onDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    const sourcePaths: string[] = [];
    for (let i = 0; i < e.dataTransfer.files.length; i++) {
      const f = e.dataTransfer.files[i] as any;
      if (f.path) sourcePaths.push(f.path);
    }
    if (sourcePaths.length === 0) return;
    let target = rootPath;
    const row = (e.target as HTMLElement).closest('[data-tree-row="true"][data-kind="folder"]');
    if (row) target = row.getAttribute('data-path') || rootPath;
    if (!target) return;
    const r = await window.electronAPI.copyExternalFiles(target, sourcePaths);
    if (!r.success) alert(r.error);
    else { await onRefreshTree(); }
  }, [rootPath, onRefreshTree]);

  if (!tree || !tree.children) {
    return (
      <div ref={fileTreeRef} className="tree-empty" tabIndex={0} onKeyDown={handleKeyDown}
        onContextMenu={handleRootContext} onPaste={handlePasteEvent}
        onDrop={onDrop} onDragOver={(e) => e.preventDefault()}>
        <span className="tree-empty-text">Empty folder</span>
        {pasting && <span className="file-status-text">Pasting...</span>}
        {menu && <ContextMenu data={menu} onClose={closeMenu} onAction={handleAction} />}
      </div>
    );
  }

  return (
    <div ref={fileTreeRef} className="file-list" tabIndex={0} onKeyDown={handleKeyDown} onPaste={handlePasteEvent}
      onContextMenu={handleRootContext} onDrop={onDrop} onDragOver={(e) => e.preventDefault()}>
      {pasting && <div className="file-status-bar">Pasting...</div>}
      {editing?.type === 'createFile' || editing?.type === 'createFolder' ? (
        <EditingRow
          type={editing.type} depth={0}
          placeholder={editing.type === 'createFile' ? 'filename.ext' : 'folder-name'}
          onConfirm={confirmCreate} onCancel={() => setEditing(null)}
        />
      ) : null}
      {tree.children.map((child) => {
        if (editing?.type === 'rename' && child.path === editing.path) {
          return (
            <EditingRow key={child.path} type="rename" depth={0}
              defaultValue={editing.originalName} placeholder="new name"
              onConfirm={confirmRename} onCancel={() => setEditing(null)}
            />
          );
        }
        return (
          <TreeNodeRow
            key={child.path} node={child} depth={0}
            activeFilePath={activeFilePath} selectedPath={selectedPath}
            onSelect={handleSelect}
            onFileSelect={onFileSelect}
            onOpenContextMenu={handleNodeContext}
          />
        );
      })}
      {menu && <ContextMenu data={menu} onClose={closeMenu} onAction={handleAction} />}
    </div>
  );
};

export default FileTree;
