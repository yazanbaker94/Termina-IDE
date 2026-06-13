import React, { useState, useCallback } from 'react';
import { ChevronRight, File, Folder, FolderOpen, FilePlus, FolderPlus, Trash2, PenLine, ExternalLink, ClipboardPaste } from 'lucide-react';
import { FileNode } from '../types';

interface FileTreeProps {
  tree: FileNode | null;
  activeFilePath: string;
  onFileSelect: (node: FileNode) => void;
  onRefreshTree: () => void;
}

interface ContextMenuData {
  x: number; y: number;
  kind: 'root' | 'folder' | 'file';
  path: string;
  name: string;
}

const ContextMenu: React.FC<{ data: ContextMenuData; onClose: () => void; onAction: (action: string, data: ContextMenuData) => Promise<void> }> = ({ data, onClose, onAction }) => {
  const doAction = async (action: string) => {
    await onAction(action, data);
    onClose();
  };

  return (
    <>
      <div className="file-context-menu" style={{ position: 'fixed', left: data.x, top: data.y, zIndex: 100 }}
        onClick={(e) => e.stopPropagation()}>
        {data.kind === 'root' || data.kind === 'folder' ? (
          <>
            <button className="file-context-item" onClick={() => doAction('newFile')}><FilePlus size={11} /><span>New File</span></button>
            <button className="file-context-item" onClick={() => doAction('newFolder')}><FolderPlus size={11} /><span>New Folder</span></button>
            <button className="file-context-item" onClick={() => doAction('paste')}><ClipboardPaste size={11} /><span>Paste</span></button>
            <div className="file-context-separator" />
          </>
        ) : null}
        {data.kind === 'folder' || data.kind === 'file' ? (
          <button className="file-context-item" onClick={() => doAction('rename')}><PenLine size={11} /><span>Rename</span></button>
        ) : null}
        {data.kind === 'file' ? (
          <button className="file-context-item" onClick={() => doAction('delete')}><Trash2 size={11} /><span>Delete</span></button>
        ) : null}
        <div className="file-context-separator" />
        <button className="file-context-item" onClick={() => doAction('reveal')}><ExternalLink size={11} /><span>Reveal in Explorer</span></button>
      </div>
      <div className="file-context-backdrop" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} />
    </>
  );
};

const fileIcons: Record<string, React.ReactNode> = {};

function getFileIcon(name: string) {
  const ext = name.split('.').pop()?.toLowerCase();
  const key = ext || 'file';
  if (!fileIcons[key]) {
    fileIcons[key] = <File size={14} />;
  }
  return fileIcons[key];
}

interface TreeNodeProps {
  node: FileNode;
  depth: number;
  activeFilePath: string;
  onFileSelect: (node: FileNode) => void;
  onOpenContextMenu: (kind: 'file' | 'folder', node: FileNode, x: number, y: number) => void;
}

const TreeNode: React.FC<TreeNodeProps> = React.memo(({ node, depth, activeFilePath, onFileSelect, onOpenContextMenu }) => {
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
        className={`file-item ${isActive ? 'active' : ''}`}
        style={{ paddingLeft: 8 + depth * 16 }}
        onClick={() => onFileSelect(node)}
        onContextMenu={handleContextMenu}
      >
        <span className="file-icon">{getFileIcon(node.name)}</span>
        <span className="file-name">{node.name}</span>
      </button>
    );
  }

  return (
    <div>
      <button
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
            <TreeNode
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

const FileTree: React.FC<FileTreeProps> = ({ tree, activeFilePath, onFileSelect, onRefreshTree }) => {
  const [menu, setMenu] = useState<ContextMenuData | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const rootPath = tree?.path ?? '';

  const openMenu = useCallback((kind: ContextMenuData['kind'], nodeOrPath: FileNode | string, x: number, y: number) => {
    const path = typeof nodeOrPath === 'string' ? nodeOrPath : nodeOrPath.path;
    const name = typeof nodeOrPath === 'string' ? path.split(/[\\/]/).pop() || path : nodeOrPath.name;
    setMenu({ x, y, kind, path, name });
  }, []);

  const handleAction = useCallback(async (action: string, data: ContextMenuData) => {
    console.log('[file-action]', action, data.kind, data.path);
    const targetDir = data.kind === 'folder' ? data.path : rootPath;
    const parentDirForFile = data.kind === 'file' ? data.path.replace(/[\\/][^\\/]*$/, '') : '';

    try {
      switch (action) {
        case 'newFile': {
          const dir = targetDir || parentDirForFile;
          if (!dir) return;
          const n = prompt('File name:');
          if (!n?.trim()) return;
          const r = await window.electronAPI.createFile(dir, n.trim());
          if (!r.success) { alert(r.error); return; }
          if (r.path) {
            const fr = await window.electronAPI.readFile(r.path);
            onFileSelect({ name: n.trim(), path: r.path, type: 'file' });
          }
          onRefreshTree();
          break;
        }
        case 'newFolder': {
          const dir = targetDir;
          if (!dir) return;
          const n = prompt('Folder name:');
          if (!n?.trim()) return;
          const r = await window.electronAPI.createFolder(dir, n.trim());
          if (!r.success) alert(r.error);
          onRefreshTree();
          break;
        }
        case 'paste': {
          const dir = targetDir || parentDirForFile;
          if (!dir) return;
          const r = await window.electronAPI.pasteFromClipboard(dir);
          if (!r.success) alert(r.error);
          onRefreshTree();
          break;
        }
        case 'rename': {
          const n = prompt('New name:', data.name);
          if (!n?.trim() || n.trim() === data.name) return;
          const r = await window.electronAPI.renamePath(data.path, n.trim());
          if (!r.success) alert(r.error);
          onRefreshTree();
          break;
        }
        case 'delete': {
          const msg = `Delete "${data.name}"?`;
          if (!window.confirm(msg)) return;
          const r = await window.electronAPI.deletePath(data.path);
          if (!r.success) alert(r.error);
          onRefreshTree();
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
  }, [rootPath, onRefreshTree, onFileSelect]);

  const handleRootContext = (e: React.MouseEvent) => {
    // Only open root menu when right-clicking background directly (not child elements)
    e.preventDefault();
    if (!rootPath) return;
    openMenu('root', rootPath, e.clientX, e.clientY);
  };

  const handleNodeContext = useCallback((kind: 'file' | 'folder', node: FileNode, x: number, y: number) => {
    openMenu(kind, node, x, y);
  }, [openMenu]);

  if (!tree || !tree.children) {
    return (
      <div className="tree-empty" onContextMenu={handleRootContext}>
        <span className="tree-empty-text">Empty folder</span>
        {menu && <ContextMenu data={menu} onClose={closeMenu} onAction={handleAction} />}
      </div>
    );
  }

  return (
    <div className="file-list" onContextMenu={handleRootContext}>
      {tree.children.map((child) => (
        <TreeNode
          key={child.path}
          node={child}
          depth={0}
          activeFilePath={activeFilePath}
          onFileSelect={onFileSelect}
          onOpenContextMenu={handleNodeContext}
        />
      ))}
      {menu && <ContextMenu data={menu} onClose={closeMenu} onAction={handleAction} />}
    </div>
  );
};

export default FileTree;
