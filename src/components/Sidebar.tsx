import React from 'react';
import { FolderOpen, RefreshCw } from 'lucide-react';
import { FileNode } from '../types';
import FileTree from './FileTree';

interface SidebarProps {
  projectName: string | null;
  rootTree: FileNode | null;
  activeFilePath: string;
  onFileSelect: (node: FileNode) => void;
  onRefreshTree: () => void;
  onOpenFolder: () => void;
}

const Sidebar: React.FC<SidebarProps> = ({
  projectName,
  rootTree,
  activeFilePath,
  onFileSelect,
  onRefreshTree,
  onOpenFolder,
}) => {
  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <span className="sidebar-title">EXPLORER</span>
        {!!projectName && (
          <button className="sidebar-refresh-btn" onClick={onRefreshTree} title="Refresh explorer">
            <RefreshCw size={12} />
          </button>
        )}
      </div>

      {!projectName ? (
        <div className="sidebar-empty">
          <p className="sidebar-empty-text">No folder open</p>
          <button className="sidebar-open-btn" onClick={onOpenFolder}>
            <FolderOpen size={14} />
            <span>Open Folder</span>
          </button>
        </div>
      ) : (
        <div className="sidebar-section">
          <div className="sidebar-section-title">{projectName}</div>
          <FileTree
            tree={rootTree}
            activeFilePath={activeFilePath}
            onFileSelect={onFileSelect}
            onRefreshTree={onRefreshTree}
          />
        </div>
      )}
    </div>
  );
};

export default Sidebar;
