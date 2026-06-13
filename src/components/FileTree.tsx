import React, { useState, useCallback, useRef, useEffect } from 'react';
import { ChevronRight, File, Folder, FolderOpen, FilePlus, FolderPlus, Trash2, PenLine, ExternalLink, ClipboardPaste, Copy } from 'lucide-react';
import { FileNode } from '../types';

interface FileTreeProps {
  tree: FileNode | null;
  activeFilePath: string;
  onFileSelect: (node: FileNode) => void;
  onRefreshTree: () => void;
  onCloseActiveFile?: () => void;
}

interface ContextMenuData {
  x: number; y: number;
  kind: 'root' | 'folder' | 'file';
  path: string;
  name: string;
}

interface EditingState {
  type: 'rename' | 'createFile' | 'createFolder';
  path?: string;        // existing path for rename
  originalName?: string; // for rename
  parentDir?: string;    // for create
  tempId?: string;       // for create
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
          <button className="file-context-item" onClick={() => doAction('paste')}><ClipboardPaste size={11} /><span>Paste</span></button>
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
  onFileSelect: (node: FileNode) => void;
  onOpenContextMenu: (kind: 'file' | 'folder', node: FileNode, x: number, y: number) => void;
}

const TreeNodeRow: React.FC<TreeNodeRowProps> = React.memo(({ node, depth, activeFilePath, onFileSelect, onOpenContextMenu }) => {
  const [expanded, setExpanded] = useState(depth < 1);
  const isDir = node.type === 'directory';
  const hasChildren = !!node.children?.length;
  const isActive = activeFilePath === node.path;

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onOpenContextMenu(isDir ? 'folder' : 'file', node, e.clientX, e.clientY);
  };

  if (!isDir) {
    return (
      <button
        data-tree-row="true"
        data-path={node.path}
        data-kind="file"
        className={`file-item ${isActive ? 'active' : ''}`}
        style={{ paddingLeft: 8 + depth * 16 }}
        onClick={() => onFileSelect(node)}
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
        className={`tree-folder ${isActive ? 'active' : ''}`}
        style={{ paddingLeft: 8 + depth * 16 }}
        onClick={() => hasChildren && setExpanded(!expanded)}
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
    try {
      await onConfirm(val);
    } catch (err: any) {
      setError(err?.message ?? 'Operation failed');
    }
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
        <input
          ref={inputRef}
          className={`file-edit-input ${error ? 'file-edit-input-error' : ''}`}
          defaultValue={defaultValue}
          placeholder={placeholder}
          onKeyDown={handleKeyDown}
          onBlur={() => onCancel()}
        />
        {error && <span className="file-edit-error">{error}</span>}
      </div>
    </div>
  );
};

const FileTree: React.FC<FileTreeProps> = ({ tree, activeFilePath, onFileSelect, onRefreshTree, onCloseActiveFile }) => {
  const [menu, setMenu] = useState<ContextMenuData | null>(null);
  const [editing, setEditing] = useState<EditingState | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const rootPath = tree?.path ?? '';
  const fileTreeRef = useRef<HTMLDivElement>(null);

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
          if (!dir) return;
          const r = await window.electronAPI.pasteFromClipboard(dir);
          if (!r.success) alert(r.error);
          onRefreshTree();
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
          onRefreshTree();
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
  }, [rootPath, onRefreshTree, activeFilePath, onCloseActiveFile]);

  const confirmRename = useCallback(async (value: string) => {
    if (!editing?.path || !editing?.originalName) return;
    if (value === editing.originalName) { setEditing(null); return; }
    const r = await window.electronAPI.renamePath(editing.path, value);
    if (!r.success) throw new Error(r.error);
    setEditing(null);
    onRefreshTree();
  }, [editing, onRefreshTree]);

  const confirmCreate = useCallback(async (value: string) => {
    if (!editing?.parentDir) return;
    if (editing.type === 'createFile') {
      const r = await window.electronAPI.createFile(editing.parentDir, value);
      if (!r.success) throw new Error(r.error);
      setEditing(null);
      onRefreshTree();
      if (r.path) onFileSelect({ name: value, path: r.path, type: 'file' });
    } else if (editing.type === 'createFolder') {
      const r = await window.electronAPI.createFolder(editing.parentDir, value);
      if (!r.success) throw new Error(r.error);
      setEditing(null);
      onRefreshTree();
    }
  }, [editing, onRefreshTree, onFileSelect]);

  const handleRootContext = (e: React.MouseEvent) => {
    e.preventDefault();
    const row = (e.target as HTMLElement).closest('[data-tree-row="true"]');
    if (row) return; // child handles it
    if (!rootPath) return;
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
    // Determine target: root or hovered folder
    let target = rootPath;
    const row = (e.target as HTMLElement).closest('[data-tree-row="true"][data-kind="folder"]');
    if (row) target = row.getAttribute('data-path') || rootPath;
    if (!target) return;
    const r = await window.electronAPI.copyExternalFiles(target, sourcePaths);
    if (!r.success) alert(r.error);
    else onRefreshTree();
  }, [rootPath, onRefreshTree]);

  if (!tree || !tree.children) {
    return (
      <div ref={fileTreeRef} className="tree-empty" onContextMenu={handleRootContext} onDrop={onDrop} onDragOver={(e) => e.preventDefault()}>
        <span className="tree-empty-text">Empty folder</span>
        {menu && <ContextMenu data={menu} onClose={closeMenu} onAction={handleAction} />}
      </div>
    );
  }

  return (
    <div ref={fileTreeRef} className="file-list" onContextMenu={handleRootContext} onDrop={onDrop} onDragOver={(e) => e.preventDefault()}>
      {editing?.type === 'createFile' || editing?.type === 'createFolder' ? (
        <EditingRow
          type={editing.type}
          depth={0}
          placeholder={editing.type === 'createFile' ? 'filename.ext' : 'folder-name'}
          onConfirm={confirmCreate}
          onCancel={() => setEditing(null)}
        />
      ) : null}
      {tree.children.map((child) => {
        if (editing?.type === 'rename' && child.path === editing.path) {
          return (
            <EditingRow
              key={child.path}
              type="rename"
              depth={0}
              defaultValue={editing.originalName}
              placeholder="new name"
              onConfirm={confirmRename}
              onCancel={() => setEditing(null)}
            />
          );
        }
        return (
          <TreeNodeRow
            key={child.path}
            node={child}
            depth={0}
            activeFilePath={activeFilePath}
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
