import React, { useState, useCallback } from 'react';
import { ChevronRight, File, Folder, FolderOpen, FilePlus, FolderPlus, Trash2, PenLine, ExternalLink, ClipboardPaste } from 'lucide-react';
import { FileNode } from '../types';

interface FileTreeProps {
  tree: FileNode | null;
  activeFilePath: string;
  onFileSelect: (node: FileNode) => void;
  onRefreshTree: () => void;
}

interface TreeNodeProps {
  node: FileNode;
  depth: number;
  activeFilePath: string;
  onFileSelect: (node: FileNode) => void;
  onRefreshTree: () => void;
}

const fileIcons: Record<string, React.ReactNode> = {};
function getFileIcon(name: string) {
  const ext = name.split('.').pop()?.toLowerCase();
  const key = ext || 'file';
  if (!fileIcons[key]) {
    fileIcons[key] = <File size={14} />;
  }
  return fileIcons[key];
}

const ContextMenu: React.FC<{ x: number; y: number; children: React.ReactNode; onClose: () => void }> = ({ x, y, children, onClose }) => {
  return (
    <>
      <div className="file-context-menu" style={{ position: 'fixed', left: x, top: y, zIndex: 100 }}
        onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
      <div className="file-context-backdrop" onClick={onClose} />
    </>
  );
};

const TreeNode: React.FC<TreeNodeProps> = ({ node, depth, activeFilePath, onFileSelect, onRefreshTree }) => {
  const [expanded, setExpanded] = useState(depth < 1);
  const [ctx, setCtx] = useState<{ x: number; y: number } | null>(null);

  const closeMenu = useCallback(() => setCtx(null), []);
  const isDir = node.type === 'directory';

  const targetDir = isDir ? node.path : '';

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setCtx({ x: e.clientX, y: e.clientY });
  };

  const createFile = async () => { closeMenu(); if (!targetDir) return; const n = prompt('File name:'); if (!n?.trim()) return; const r = await window.electronAPI.createFile(targetDir, n.trim()); if (!r.success) alert(r.error); onRefreshTree(); };
  const createFolder = async () => { closeMenu(); if (!targetDir) return; const n = prompt('Folder name:'); if (!n?.trim()) return; const r = await window.electronAPI.createFolder(targetDir, n.trim()); if (!r.success) alert(r.error); onRefreshTree(); };
  const paste = async () => { closeMenu(); if (!targetDir) return; const r = await window.electronAPI.pasteFromClipboard(targetDir); if (!r.success) alert(r.error); onRefreshTree(); };
  const rename = async () => { closeMenu(); const n = prompt('New name:', node.name); if (!n?.trim() || n.trim() === node.name) return; const r = await window.electronAPI.renamePath(node.path, n.trim()); if (!r.success) alert(r.error); onRefreshTree(); };
  const del = async () => { closeMenu(); const msg = isDir ? `Delete folder "${node.name}" and all its contents?` : `Delete file "${node.name}"?`; if (!window.confirm(msg)) return; const r = await window.electronAPI.deletePath(node.path); if (!r.success) alert(r.error); onRefreshTree(); };
  const reveal = () => { closeMenu(); window.electronAPI.revealInExplorer(node.path); };

  if (!isDir) {
    const isActive = activeFilePath === node.path;
    return (
      <>
        <button
          className={`file-item ${isActive ? 'active' : ''}`}
          style={{ paddingLeft: 8 + depth * 16 }}
          onClick={() => onFileSelect(node)}
          onContextMenu={onContextMenu}
        >
          <span className="file-icon">{getFileIcon(node.name)}</span>
          <span className="file-name">{node.name}</span>
        </button>
        {ctx && (
          <ContextMenu x={ctx.x} y={ctx.y} onClose={closeMenu}>
            <button className="file-context-item" onClick={rename}><PenLine size={11} /><span>Rename</span></button>
            <button className="file-context-item" onClick={del}><Trash2 size={11} /><span>Delete</span></button>
            <div className="file-context-separator" />
            <button className="file-context-item" onClick={reveal}><ExternalLink size={11} /><span>Reveal in Explorer</span></button>
          </ContextMenu>
        )}
      </>
    );
  }

  const hasChildren = !!node.children?.length;
  const isActive = activeFilePath === node.path;

  return (
    <div>
      <button
        className={`tree-folder ${isActive ? 'active' : ''}`}
        style={{ paddingLeft: 8 + depth * 16 }}
        onClick={() => hasChildren && setExpanded(!expanded)}
        onContextMenu={onContextMenu}
      >
        <span className="tree-chevron" style={{ transform: expanded ? 'rotate(90deg)' : undefined }}>
          <ChevronRight size={12} />
        </span>
        <span className="file-icon">
          {expanded ? <FolderOpen size={14} /> : <Folder size={14} />}
        </span>
        <span className="file-name">{node.name}</span>
      </button>
      {ctx && (
        <ContextMenu x={ctx.x} y={ctx.y} onClose={closeMenu}>
          <button className="file-context-item" onClick={createFile}><FilePlus size={11} /><span>New File</span></button>
          <button className="file-context-item" onClick={createFolder}><FolderPlus size={11} /><span>New Folder</span></button>
          <button className="file-context-item" onClick={paste}><ClipboardPaste size={11} /><span>Paste</span></button>
          <div className="file-context-separator" />
          <button className="file-context-item" onClick={rename}><PenLine size={11} /><span>Rename</span></button>
          <div className="file-context-separator" />
          <button className="file-context-item" onClick={reveal}><ExternalLink size={11} /><span>Reveal in Explorer</span></button>
        </ContextMenu>
      )}
      {expanded && hasChildren && (
        <div>
          {node.children!.map((child) => (
            <TreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              activeFilePath={activeFilePath}
              onFileSelect={onFileSelect}
              onRefreshTree={onRefreshTree}
            />
          ))}
        </div>
      )}
    </div>
  );
};

const FileTree: React.FC<FileTreeProps> = ({ tree, activeFilePath, onFileSelect, onRefreshTree }) => {
  const [rootMenu, setRootMenu] = useState<{ x: number; y: number } | null>(null);
  const closeRootMenu = useCallback(() => setRootMenu(null), []);
  const rootPath = tree?.path ?? '';

  const handleRootContext = (e: React.MouseEvent) => {
    e.preventDefault();
    setRootMenu({ x: e.clientX, y: e.clientY });
  };

  const rootCreateFile = async () => { closeRootMenu(); const n = prompt('File name:'); if (!n?.trim()) return; const r = await window.electronAPI.createFile(rootPath, n.trim()); if (!r.success) alert(r.error); onRefreshTree(); };
  const rootCreateFolder = async () => { closeRootMenu(); const n = prompt('Folder name:'); if (!n?.trim()) return; const r = await window.electronAPI.createFolder(rootPath, n.trim()); if (!r.success) alert(r.error); onRefreshTree(); };
  const rootPaste = async () => { closeRootMenu(); const r = await window.electronAPI.pasteFromClipboard(rootPath); if (!r.success) alert(r.error); onRefreshTree(); };
  const rootReveal = () => { closeRootMenu(); window.electronAPI.revealInExplorer(rootPath); };

  if (!tree || !tree.children) {
    return (
      <div className="tree-empty" onContextMenu={handleRootContext}>
        <span className="tree-empty-text">Empty folder</span>
        {rootMenu && (
          <ContextMenu x={rootMenu.x} y={rootMenu.y} onClose={closeRootMenu}>
            <button className="file-context-item" onClick={rootCreateFile}><FilePlus size={11} /><span>New File</span></button>
            <button className="file-context-item" onClick={rootCreateFolder}><FolderPlus size={11} /><span>New Folder</span></button>
            <button className="file-context-item" onClick={rootPaste}><ClipboardPaste size={11} /><span>Paste</span></button>
            <div className="file-context-separator" />
            <button className="file-context-item" onClick={rootReveal}><ExternalLink size={11} /><span>Reveal in Explorer</span></button>
          </ContextMenu>
        )}
      </div>
    );
  }

  return (
    <div className="file-list" onContextMenu={handleRootContext}>
      {rootMenu && (
        <ContextMenu x={rootMenu.x} y={rootMenu.y} onClose={closeRootMenu}>
          <button className="file-context-item" onClick={rootCreateFile}><FilePlus size={11} /><span>New File</span></button>
          <button className="file-context-item" onClick={rootCreateFolder}><FolderPlus size={11} /><span>New Folder</span></button>
          <button className="file-context-item" onClick={rootPaste}><ClipboardPaste size={11} /><span>Paste</span></button>
          <div className="file-context-separator" />
          <button className="file-context-item" onClick={rootReveal}><ExternalLink size={11} /><span>Reveal in Explorer</span></button>
        </ContextMenu>
      )}
      {tree.children.map((child) => (
        <TreeNode
          key={child.path}
          node={child}
          depth={0}
          activeFilePath={activeFilePath}
          onFileSelect={onFileSelect}
          onRefreshTree={onRefreshTree}
        />
      ))}
    </div>
  );
};

export default FileTree;
