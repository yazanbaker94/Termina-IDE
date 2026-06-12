import React, { useState } from 'react';
import { ChevronRight, File, Folder, FolderOpen } from 'lucide-react';
import { FileNode } from '../types';

interface FileTreeProps {
  tree: FileNode | null;
  activeFilePath: string;
  onFileSelect: (node: FileNode) => void;
}

interface TreeNodeProps {
  node: FileNode;
  depth: number;
  activeFilePath: string;
  onFileSelect: (node: FileNode) => void;
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

const TreeNode: React.FC<TreeNodeProps> = ({ node, depth, activeFilePath, onFileSelect }) => {
  const [expanded, setExpanded] = useState(depth < 1);

  if (node.type === 'file') {
    const isActive = activeFilePath === node.path;
    return (
      <button
        className={`file-item ${isActive ? 'active' : ''}`}
        style={{ paddingLeft: 8 + depth * 16 }}
        onClick={() => onFileSelect(node)}
      >
        <span className="file-icon">{getFileIcon(node.name)}</span>
        <span className="file-name">{node.name}</span>
      </button>
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
            />
          ))}
        </div>
      )}
    </div>
  );
};

const FileTree: React.FC<FileTreeProps> = ({ tree, activeFilePath, onFileSelect }) => {
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
        />
      ))}
    </div>
  );
};

export default FileTree;
