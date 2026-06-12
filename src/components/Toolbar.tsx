import React from 'react';
import { FolderOpen, Files } from 'lucide-react';

interface ToolbarProps {
  onOpenFolder: () => void;
  onToggleFiles: () => void;
}

const Toolbar: React.FC<ToolbarProps> = ({ onOpenFolder, onToggleFiles }) => {
  return (
    <div className="toolbar">
      <div className="toolbar-left">
        <span className="toolbar-brand">Command Code</span>
      </div>
      <div className="toolbar-center">
        <button className="toolbar-btn" onClick={onOpenFolder} title="Open Folder">
          <FolderOpen size={16} />
          <span>Open Folder</span>
        </button>
      </div>
      <div className="toolbar-right">
        <button className="toolbar-btn icon-btn" onClick={onToggleFiles} title="Toggle Files">
          <Files size={16} />
        </button>
      </div>
    </div>
  );
};

export default Toolbar;
