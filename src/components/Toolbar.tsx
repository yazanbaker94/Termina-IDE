import React from 'react';
import { FolderOpen, Files, Minus, Square, X } from 'lucide-react';

interface ToolbarProps {
  onOpenFolder: () => void;
  onToggleFiles: () => void;
}

const handleWindowControl = async (action: 'minimize' | 'maximizeToggle' | 'close', e: React.MouseEvent) => {
  e.preventDefault();
  e.stopPropagation();
  try { await window.electronAPI.windowControl(action); } catch {}
};

const Toolbar: React.FC<ToolbarProps> = ({ onOpenFolder, onToggleFiles }) => {
  return (
    <div className="toolbar">
      <div className="toolbar-left">
        <span className="toolbar-brand">Termina</span>
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
            onClick={(e) => handleWindowControl('minimize', e)}
            title="Minimize"
          >
            <Minus size={13} />
          </button>
          <button
            className="window-control-btn"
            onClick={(e) => handleWindowControl('maximizeToggle', e)}
            title="Maximize"
          >
            <Square size={11} />
          </button>
          <button
            className="window-control-btn window-close-btn"
            onClick={(e) => handleWindowControl('close', e)}
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
