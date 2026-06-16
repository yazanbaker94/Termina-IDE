import React from 'react';
import { GitBranch } from 'lucide-react';

interface BottomBarProps {
  projectName: string | null;
  fileName: string;
  language: string;
  saveStatus: string;
  branch: string | null;
  cursor?: { line: number; column: number } | null;
}

const BottomBar: React.FC<BottomBarProps> = ({ projectName, fileName, language, saveStatus, branch, cursor }) => {
  return (
    <div className="bottombar">
      <div className="bottombar-left">
        <span className="status-indicator" />
        <span className="status-text">{saveStatus || 'Ready'}</span>
      </div>
      <div className="bottombar-center">
        {projectName ? (
          <>
            <span className="status-project">{projectName}</span>
            {fileName && (
              <>
                <span className="status-separator">|</span>
                <span className="status-file">{fileName}</span>
              </>
            )}
          </>
        ) : (
          <span className="status-project">No folder open</span>
        )}
      </div>
      <div className="bottombar-right">
        {branch && (
          <span className="status-branch">
            <GitBranch size={10} />
            {branch}
          </span>
        )}
        {language && <span className="status-info">{language}</span>}
        <span className="status-info">UTF-8</span>
        <span className="status-info">Ln {cursor?.line ?? 1}, Col {cursor?.column ?? 1}</span>
      </div>
    </div>
  );
};

export default BottomBar;
