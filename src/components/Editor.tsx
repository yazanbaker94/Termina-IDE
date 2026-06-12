import React, { useRef, useCallback } from 'react';
import Editor, { OnMount } from '@monaco-editor/react';
import type { editor } from 'monaco-editor';
import { FileCode, FileCode2, File, Paintbrush, Save, FolderOpen } from 'lucide-react';
import { FileState } from '../types';

interface EditorPanelProps {
  file: FileState | null;
  isLoading?: boolean;
  isDirty: boolean;
  hasProject: boolean;
  onChange: (content: string | undefined) => void;
  onSave: () => void;
}

const extIcons: Record<string, React.ReactNode> = {
  '.tsx': <FileCode2 size={13} />,
  '.ts': <FileCode size={13} />,
  '.css': <Paintbrush size={13} />,
};

function getFileIcon(name: string): React.ReactNode {
  const ext = '.' + (name.split('.').pop() || '');
  return extIcons[ext] || <File size={13} />;
}

const EditorPanel: React.FC<EditorPanelProps> = ({
  file,
  isLoading,
  isDirty,
  hasProject,
  onChange,
  onSave,
}) => {
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);

  const handleMount: OnMount = useCallback((editor) => {
    editorRef.current = editor;
  }, []);

  if (!file || !file.path) {
    return (
      <div className="editor-container">
        <div className="editor-empty">
          <div className="editor-empty-icon">
            {hasProject ? (
              <File size={40} />
            ) : (
              <FolderOpen size={40} />
            )}
          </div>
          <p className="editor-empty-text">
            {hasProject
              ? 'Select a file to start editing'
              : 'Open a folder to get started'}
          </p>
          <p className="editor-empty-sub">
            {hasProject
              ? 'Choose a file from the explorer sidebar.'
              : 'Use the Open Folder button or File > Open Folder.'}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="editor-container">
      <div className="editor-tabs">
        <div className="editor-tab active">
          <span className="tab-icon">{getFileIcon(file.name)}</span>
          <span className="tab-name">{file.name}</span>
          {isDirty && <span className="tab-dirty" />}
        </div>
        <div className="editor-tab-actions">
          {hasProject && (
            <button
              className={`editor-save-btn ${isDirty ? 'dirty' : ''}`}
              onClick={onSave}
              title="Save (Ctrl+S)"
            >
              <Save size={13} />
            </button>
          )}
        </div>
      </div>
      <div className="editor-main">
        {isLoading ? (
          <div className="editor-loading">
            <span>Loading file...</span>
          </div>
        ) : (
          <Editor
            key={file.path}
            height="100%"
            language={file.language}
            defaultValue={file.content}
            onChange={onChange}
            onMount={handleMount}
            theme="vs-dark"
            options={{
              fontSize: 13,
              fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
              minimap: { enabled: true, scale: 1, showSlider: 'mouseover' },
              scrollBeyondLastLine: false,
              lineNumbers: 'on',
              renderLineHighlight: 'line',
              smoothScrolling: true,
              cursorBlinking: 'smooth',
              cursorSmoothCaretAnimation: 'on',
              bracketPairColorization: { enabled: true },
              padding: { top: 12 },
              automaticLayout: true,
            }}
            loading={
              <div className="editor-loading">
                <span>Loading editor...</span>
              </div>
            }
          />
        )}
      </div>
    </div>
  );
};

export default EditorPanel;
