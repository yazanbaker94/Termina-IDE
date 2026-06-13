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
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);

  const closeMenu = useCallback(() => setContextMenu(null), []);
  const isDir = node.type === 'directory';

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY });
  };

  const handleCreateFile = async () => {
    closeMenu();
    const parentDir = isDir ? node.path : '';
    if (!parentDir) return;
    const name = prompt('File name:');
    if (!name?.trim()) return;
    const r = await window.electronAPI.createFile(parentDir, name.trim());
    if (!r.success) alert(r.error);
    onRefreshTree();
  };

  const handleCreateFolder = async () => {
    closeMenu();
    const parentDir = isDir ? node.path : '';
    if (!parentDir) return;
    const name = prompt('Folder name:');
    if (!name?.trim()) return;
    const r = await window.electronAPI.createFolder(parentDir, name.trim());
    if (!r.success) alert(r.error);
    onRefreshTree();
  };

  const handlePaste = async () => {
    closeMenu();
    const targetDir = isDir ? node.path : '';
    if (!targetDir) return;
    const r = await window.electronAPI.pasteFromClipboard(targetDir);
    if (!r.success) alert(r.error);
    onRefreshTree();
  };

  const handleRename = async () => {
    closeMenu();
    const name = prompt('New name:', node.name);
    if (!name?.trim() || name.trim() === node.name) return;
    const r = await window.electronAPI.renamePath(node.path, name.trim());
    if (!r.success) alert(r.error);
    onRefreshTree();
  };

  const handleDelete = async () => {
    closeMenu();
    const msg = isDir
      ? `Delete folder "${node.name}" and all its contents?`
      : `Delete file "${node.name}"?`;
    if (!window.confirm(msg)) return;
    const r = await window.electronAPI.deletePath(node.path);
    if (!r.success) alert(r.error);
    onRefreshTree();
  };

  const handleReveal = () => {
    closeMenu();
    window.electronAPI.revealInExplorer(node.path);
  };

  const handleCopyExternalFiles = async (files: FileList) => {
    closeMenu();
    const targetDir = isDir ? node.path : '';
    if (!targetDir || files.length === 0) return;
    const filePaths: string[] = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i] as any;
      if (f.path) filePaths.push(f.path);
    }
    if (filePaths.length === 0) return;
    const r = await window.electronAPI.copyExternalFiles(targetDir, filePaths);
    if (!r.success) alert(r.error);
    onRefreshTree();
  };

  const folderMenu = (
    <ContextMenu x={contextMenu!.x} y={contextMenu!.y} onClose={closeMenu}>
      <button className="file-context-item" onClick={handleCreateFile}><FilePlus size={11} /><span>New File</span></button>
      <button className="file-context-item" onClick={handleCreateFolder}><FolderPlus size={11} /><span>New Folder</span></button>
      <button className="file-context-item" onClick={handlePaste}><ClipboardPaste size={11} /><span>Paste</span></button>
      <div className="file-context-separator" />
      <button className="file-context-item" onClick={handleRename}><PenLine size={11} /><span>Rename</span></button>
      <div className="file-context-separator" />
      <button className="file-context-item" onClick={handleReveal}><ExternalLink size={11} /><span>Reveal in Explorer</span></button>
    </ContextMenu>
  );

  const fileMenu = (
    <ContextMenu x={contextMenu!.x} y={contextMenu!.y} onClose={closeMenu}>
      <button className="file-context-item" onClick={handleRename}><PenLine size={11} /><span>Rename</span></button>
      <button className="file-context-item" onClick={handleDelete}><Trash2 size={11} /><span>Delete</span></button>
      <div className="file-context-separator" />
      <button className="file-context-item" onClick={handleReveal}><ExternalLink size={11} /><span>Reveal in Explorer</span></button>
    </ContextMenu>
  );

  if (!isDir) {
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
        {contextMenu && fileMenu}
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
      {contextMenu && folderMenu}
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
  const rootPasteFiles = async (files: FileList) => {
    closeRootMenu();
    const filePaths: string[] = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i] as any;
      if (f.path) filePaths.push(f.path);
    }
    if (filePaths.length === 0) return;
    const r = await window.electronAPI.copyExternalFiles(rootPath, filePaths);
    if (!r.success) alert(r.error);
    onRefreshTree();
  };

  if (!tree || !tree.children) {
    return (
      <div className="tree-empty">
        <span className="tree-empty-text">Empty folder</span>
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
