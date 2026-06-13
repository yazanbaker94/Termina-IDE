import React from 'react';
import { FolderOpen, Files, Minus, Square, X } from 'lucide-react';

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
        <div className="window-controls">
          <button
            className="window-control-btn"
            onClick={() => window.electronAPI.minimizeWindow()}
            title="Minimize"
          >
            <Minus size={13} />
          </button>
          <button
            className="window-control-btn"
            onClick={() => window.electronAPI.maximizeToggleWindow()}
            title="Maximize"
          >
            <Square size={11} />
          </button>
          <button
            className="window-control-btn window-close-btn"
            onClick={() => window.electronAPI.closeWindow()}
            title="Close"
          >
            <X size={13} />
          </button>
        </div>
      </div>
    </div>
  );
};

export default Toolbar;
