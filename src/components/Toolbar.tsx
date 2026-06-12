import React from 'react';
import { FolderOpen, Play, Files } from 'lucide-react';

interface ToolbarProps {
  onOpenFolder: () => void;
  onRunAgent: () => void;
  onToggleFiles: () => void;
  agentDisabled: boolean;
  agentRunning: boolean;
}

const Toolbar: React.FC<ToolbarProps> = ({ onOpenFolder, onRunAgent, onToggleFiles, agentDisabled, agentRunning }) => {
  const runTitle = agentDisabled
    ? 'Open a folder to run Command Code'
    : agentRunning
    ? 'Agent is running'
    : 'Run Command Code Agent';

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
        <button
          className="toolbar-btn"
          onClick={onRunAgent}
          disabled={agentDisabled || agentRunning}
          title={runTitle}
        >
          <Play size={16} />
          <span>Run Agent</span>
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
