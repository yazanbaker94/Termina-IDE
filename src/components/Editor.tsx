import React, { useRef, useCallback, useEffect } from 'react';
import Editor, { OnMount } from '@monaco-editor/react';
import type { editor } from 'monaco-editor';
import { FileCode, FileCode2, File, Paintbrush, X } from 'lucide-react';
import { FileState } from '../types';

interface EditorPanelProps {
  file: FileState | null;
  isLoading?: boolean;
  isDirty: boolean;
  hasProject: boolean;
  onChange: (content: string | undefined) => void;
  onSave: () => void;
  onClose: () => void;
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
  onClose,
}) => {
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const applyingExternalChangeRef = useRef(false);
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;

  const handleMount: OnMount = useCallback((editor, monaco) => {
    editorRef.current = editor;
    editor.addAction({
      id: 'command-code-save',
      label: 'Save File',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
      run: () => {
        onSaveRef.current();
      },
    });
  }, []);

  // Live reload: sync Monaco model when file content changes from outside
  useEffect(() => {
    const ed = editorRef.current;
    if (!ed || !file) return;
    const model = ed.getModel();
    if (!model) return;
    if (model.getValue() !== file.content) {
      applyingExternalChangeRef.current = true;
      const viewState = ed.saveViewState();
      model.setValue(file.content);
      if (viewState) ed.restoreViewState(viewState);
      setTimeout(() => { applyingExternalChangeRef.current = false; }, 50);
    }
  }, [file]);

  const handleChange = useCallback((val: string | undefined) => {
    if (applyingExternalChangeRef.current) return;
    onChange(val);
  }, [onChange]);

  if (!file || !file.path) {
    return (
      <div className="code-review-container">
        <div className="editor-empty">
          <div className="editor-empty-icon">
            <File size={40} />
          </div>
          <p className="editor-empty-text">Select a file to start editing</p>
          <p className="editor-empty-sub">Choose a file from the file explorer.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="code-review-container">
      <div className="code-review-tabs">
        <div className="code-review-tab active">
          <span className="tab-icon">{getFileIcon(file.name)}</span>
          <span className="tab-name">{file.name}</span>
          {isDirty && <span className="tab-dirty" />}
        </div>
        <div className="code-review-tab-actions">
          <button className="panel-action-btn" onClick={onClose} title="Close file">
            <X size={13} />
          </button>
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
            onChange={handleChange}
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
