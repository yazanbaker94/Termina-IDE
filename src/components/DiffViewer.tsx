import React from 'react';
import { DiffEditor } from '@monaco-editor/react';
import { X, ExternalLink, Undo2, FilePlus, FileEdit, FileMinus, Check } from 'lucide-react';
import { FileDiff } from '../types';

interface DiffViewerProps {
  diff: FileDiff;
  onClose: () => void;
  onOpenFile: (filePath: string) => void;
  onRevertFile: (filePath: string) => void;
  onAcceptFile?: (filePath: string) => void;
}

function changeLabel(changeType: string) {
  switch (changeType) {
    case 'added': return 'Added';
    case 'changed': return 'Modified';
    case 'deleted': return 'Deleted';
    default: return 'Changed';
  }
}

function changeIcon(changeType: string) {
  switch (changeType) {
    case 'added': return <FilePlus size={12} />;
    case 'changed': return <FileEdit size={12} />;
    case 'deleted': return <FileMinus size={12} />;
    default: return <FileEdit size={12} />;
  }
}

function changeClass(changeType: string) {
  switch (changeType) {
    case 'added': return 'agent-changed-added';
    case 'changed': return 'agent-changed-changed';
    case 'deleted': return 'agent-changed-deleted';
    default: return '';
  }
}

const DiffViewer: React.FC<DiffViewerProps> = ({ diff, onClose, onOpenFile, onRevertFile, onAcceptFile }) => {
  return (
    <div className="editor-container">
      <div className="editor-tabs">
        <div className={`editor-tab diff-tab active ${changeClass(diff.changeType)}`}>
          <span className="tab-icon">{changeIcon(diff.changeType)}</span>
          <span className="tab-name">{diff.fileName}</span>
          <span className={`diff-badge ${changeClass(diff.changeType)}`}>
            {changeLabel(diff.changeType)}
          </span>
        </div>
        <div className="editor-tab-actions">
          {onAcceptFile && (
            <button
              className="panel-action-btn"
              onClick={() => onAcceptFile(diff.filePath)}
              title="Accept file changes"
            >
              <Check size={13} />
            </button>
          )}
          <button
            className="panel-action-btn"
            onClick={() => onRevertFile(diff.filePath)}
            title="Reject file changes (restore snapshot)"
          >
            <Undo2 size={13} />
          </button>
          {diff.changeType !== 'deleted' && (
            <button
              className="panel-action-btn"
              onClick={() => onOpenFile(diff.filePath)}
              title="Open file in editor"
            >
              <ExternalLink size={13} />
            </button>
          )}
          <button
            className="panel-action-btn"
            onClick={onClose}
            title="Close diff view"
          >
            <X size={13} />
          </button>
        </div>
      </div>
      <div className="editor-main">
        <DiffEditor
          height="100%"
          language={diff.language}
          original={diff.beforeContent}
          modified={diff.afterContent}
          theme="vs-dark"
          options={{
            fontSize: 13,
            fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            lineNumbers: 'on',
            renderLineHighlight: 'line',
            smoothScrolling: true,
            cursorBlinking: 'smooth',
            cursorSmoothCaretAnimation: 'on',
            padding: { top: 12 },
            automaticLayout: true,
            readOnly: true,
            renderSideBySide: true,
            originalEditable: false,
          }}
          loading={
            <div className="editor-loading">
              <span>Loading diff...</span>
            </div>
          }
        />
      </div>
    </div>
  );
};

export default DiffViewer;
