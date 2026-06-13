import React, { useState, useMemo } from 'react';
import { X, RefreshCw, FolderOpen, Search } from 'lucide-react';
import { FileNode } from '../types';
import FileTree from './FileTree';

interface FilesDrawerProps {
  visible?: boolean;
  projectName: string | null;
  rootTree: FileNode | null;
  activeFilePath: string;
  onClose: () => void;
  onFileSelect: (node: FileNode) => void;
  onRefreshTree: () => void;
  onOpenFolder: () => void;
  onCloseActiveFile?: () => void;
}

function filterTree(tree: FileNode | null, query: string): FileNode | null {
  if (!tree || !tree.children) return tree;
  if (!query.trim()) return tree;
  const lower = query.toLowerCase();
  function filterNode(node: FileNode): FileNode | null {
    if (node.type === 'file') return node.name.toLowerCase().includes(lower) ? node : null;
    if (!node.children) return null;
    const filtered = node.children.map(filterNode).filter(Boolean) as FileNode[];
    if (filtered.length > 0) return { ...node, children: filtered };
    return node.name.toLowerCase().includes(lower) ? node : null;
  }
  const children = tree.children.map(filterNode).filter(Boolean) as FileNode[];
  return { ...tree, children };
}

const FilesDrawer: React.FC<FilesDrawerProps> = ({
  projectName, rootTree, activeFilePath, onClose, onFileSelect, onRefreshTree, onOpenFolder, onCloseActiveFile,
}) => {
  const [filter, setFilter] = useState('');
  const filteredTree = useMemo(() => filterTree(rootTree, filter), [rootTree, filter]);

  return (
    <div className="files-drawer">
      <div className="files-drawer-header">
        <span className="files-drawer-title">FILES</span>
        <div className="files-drawer-actions">
          {!!projectName && <button className="files-drawer-action-btn" onClick={onRefreshTree} title="Refresh explorer"><RefreshCw size={12} /></button>}
          <button className="files-drawer-action-btn" onClick={onClose} title="Close"><X size={14} /></button>
        </div>
      </div>
      {projectName && (
        <div className="files-drawer-filter">
          <Search size={12} className="files-drawer-filter-icon" />
          <input className="files-drawer-filter-input" type="text" placeholder="Filter files..." value={filter} onChange={(e) => setFilter(e.target.value)} />
          {filter && <button className="files-drawer-filter-clear" onClick={() => setFilter('')}><X size={10} /></button>}
        </div>
      )}
      {!projectName ? (
        <div className="files-drawer-empty">
          <p className="files-drawer-empty-text">No folder open</p>
          <button className="files-drawer-open-btn" onClick={onOpenFolder}><FolderOpen size={14} /><span>Open Folder</span></button>
        </div>
      ) : (
        <div className="files-drawer-section">
          <FileTree tree={filteredTree} activeFilePath={activeFilePath} onFileSelect={onFileSelect} onRefreshTree={onRefreshTree} onCloseActiveFile={onCloseActiveFile} />
        </div>
      )}
    </div>
  );
};

export default FilesDrawer;
