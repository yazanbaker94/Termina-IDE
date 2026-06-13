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

const TreeNode: React.FC<TreeNodeProps> = ({ node, depth, activeFilePath, onFileSelect, onRefreshTree }) => {
  const [expanded, setExpanded] = useState(depth < 1);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);

  const closeMenu = useCallback(() => setContextMenu(null), []);

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY });
  };

  const handleCreateFile = async () => {
    closeMenu();
    const parentDir = node.type === 'directory' ? node.path : '';
    if (!parentDir) return;
    const name = prompt('File name:');
    if (!name?.trim()) return;
    await window.electronAPI.createFile(parentDir, name.trim());
    onRefreshTree();
  };

  const handleCreateFolder = async () => {
    closeMenu();
    const parentDir = node.type === 'directory' ? node.path : '';
    if (!parentDir) return;
    const name = prompt('Folder name:');
    if (!name?.trim()) return;
    await window.electronAPI.createFolder(parentDir, name.trim());
    onRefreshTree();
  };

  const handlePaste = async () => {
    closeMenu();
    const targetDir = node.type === 'directory' ? node.path : '';
    if (!targetDir) return;
    await window.electronAPI.pasteFromClipboard(targetDir);
    onRefreshTree();
  };

  const handleRename = async () => {
    closeMenu();
    if (node.type !== 'file') return;
    const name = prompt('New name:', node.name);
    if (!name?.trim() || name.trim() === node.name) return;
    await window.electronAPI.renamePath(node.path, name.trim());
    onRefreshTree();
  };

  const handleDelete = async () => {
    closeMenu();
    const msg = node.type === 'directory'
      ? `Delete folder "${node.name}" and all its contents?`
      : `Delete file "${node.name}"?`;
    if (!window.confirm(msg)) return;
    await window.electronAPI.deletePath(node.path);
    onRefreshTree();
  };

  const handleReveal = () => {
    closeMenu();
    window.electronAPI.revealInExplorer(node.path);
  };

  if (node.type === 'file') {
    const isActive = activeFilePath === node.path;
    return (
      <>
        <button
          className={`file-item ${isActive ? 'active' : ''}`}
          style={{ paddingLeft: 8 + depth * 16 }}
          onClick={() => onFileSelect(node)}
          onContextMenu={handleContextMenu}
        >
          <span className="file-icon">{getFileIcon(node.name)}</span>
          <span className="file-name">{node.name}</span>
        </button>
        {contextMenu && (
          <div className="file-context-menu" style={{ position: 'fixed', left: contextMenu.x, top: contextMenu.y, zIndex: 100 }}
            onClick={(e) => e.stopPropagation()}>
            <button className="file-context-item" onClick={handleRename}><PenLine size={11} /><span>Rename</span></button>
            <button className="file-context-item" onClick={handleDelete}><Trash2 size={11} /><span>Delete</span></button>
            <button className="file-context-item" onClick={handleReveal}><ExternalLink size={11} /><span>Reveal in Explorer</span></button>
          </div>
        )}
        {contextMenu && <div className="file-context-backdrop" onClick={closeMenu} />}
      </>
    );
  }

  const hasChildren = node.children && node.children.length > 0;
  const isActive = activeFilePath === node.path;

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
      {contextMenu && (
        <div className="file-context-menu" style={{ position: 'fixed', left: contextMenu.x, top: contextMenu.y, zIndex: 100 }}
          onClick={(e) => e.stopPropagation()}>
          <button className="file-context-item" onClick={handleCreateFile}><FilePlus size={11} /><span>New File</span></button>
          <button className="file-context-item" onClick={handleCreateFolder}><FolderPlus size={11} /><span>New Folder</span></button>
          <button className="file-context-item" onClick={handlePaste}><ClipboardPaste size={11} /><span>Paste</span></button>
          <div className="file-context-separator" />
          <button className="file-context-item" onClick={handleReveal}><ExternalLink size={11} /><span>Reveal in Explorer</span></button>
        </div>
      )}
      {contextMenu && <div className="file-context-backdrop" onClick={closeMenu} />}
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
  if (!tree || !tree.children) {
    return (
      <div className="tree-empty">
        <span className="tree-empty-text">Empty folder</span>
      </div>
    );
  }

  return (
    <div className="file-list">
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
