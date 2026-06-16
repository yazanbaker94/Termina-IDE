import { describe, it, expect } from 'vitest';
import {
  buildContextualTitle,
  deduplicateTitle,
  extractTitleFromAgentResponse,
  extractTitleFromPrompt,
  isDefaultLabel,
  stripPromptNoise,
} from '../src/utils/sessionNaming';

describe('sessionNaming - isDefaultLabel', () => {
  it('matches "Chat 1", "Chat 42", "chat 7" (case-insensitive)', () => {
    expect(isDefaultLabel('Chat 1')).toBe(true);
    expect(isDefaultLabel('Chat 42')).toBe(true);
    expect(isDefaultLabel('chat 7')).toBe(true);
    expect(isDefaultLabel('CHAT 100')).toBe(true);
  });

  it('matches "Untitled" and "Untitled 3"', () => {
    expect(isDefaultLabel('Untitled')).toBe(true);
    expect(isDefaultLabel('Untitled 3')).toBe(true);
    expect(isDefaultLabel('untitled')).toBe(true);
  });

  it('returns true for empty/null', () => {
    expect(isDefaultLabel('')).toBe(true);
    expect(isDefaultLabel(null)).toBe(true);
    expect(isDefaultLabel(undefined)).toBe(true);
  });

  it('returns false for any custom label', () => {
    expect(isDefaultLabel('Fix login bug')).toBe(false);
    expect(isDefaultLabel('My chat')).toBe(false);
    expect(isDefaultLabel('Chat')).toBe(false);
    expect(isDefaultLabel(' Chats 1')).toBe(false);
  });
});

describe('sessionNaming - stripPromptNoise', () => {
  it('strips fenced code blocks', () => {
    expect(stripPromptNoise('Refactor this ```function foo() { return 1; }``` please'))
      .toBe('Refactor this please');
  });

  it('strips inline backticks', () => {
    expect(stripPromptNoise('Add a `useState` hook to the component'))
      .toBe('Add a hook to the component');
  });

  it('strips @-mentions', () => {
    expect(stripPromptNoise('Look at @src/utils/foo.ts and @"/path with spaces/file.ts"'))
      .toBe('Look at and');
  });

  it('strips URLs', () => {
    expect(stripPromptNoise('See https://example.com/docs for details'))
      .toBe('See for details');
  });

  it('strips file paths', () => {
    expect(stripPromptNoise('Open C:\\Users\\me\\file.txt and /home/user/doc.pdf'))
      .toBe('Open and');
  });

  it('collapses whitespace', () => {
    expect(stripPromptNoise('  hello   world  \n\n foo  ')).toBe('hello world foo');
  });

  it('handles empty input', () => {
    expect(stripPromptNoise('')).toBe('');
    expect(stripPromptNoise('   ')).toBe('');
  });
});

describe('sessionNaming - extractTitleFromPrompt', () => {
  it('extracts a clean title from a normal prompt', () => {
    expect(extractTitleFromPrompt('Fix the login bug on the homepage'))
      .toBe('Fix the login bug on the homepage');
  });

  it('sentence-cases the first letter', () => {
    expect(extractTitleFromPrompt('add dark mode to settings'))
      .toBe('Add dark mode to settings');
  });

  it('preserves intentional casing in later words (e.g. "iOS")', () => {
    expect(extractTitleFromPrompt('Fix the iOS build pipeline'))
      .toBe('Fix the iOS build pipeline');
  });

  it('strips leading shell commands and re-extracts', () => {
    expect(extractTitleFromPrompt('cd src && explain the auth flow'))
      .toBe('Explain the auth flow');
  });

  it('strips leading noise words (greetings) and re-extracts', () => {
    expect(extractTitleFromPrompt('hi, can you refactor the login flow please'))
      .toBe('Can you refactor the login flow please');
  });

  it('returns empty string for too-short input', () => {
    expect(extractTitleFromPrompt('fix it')).toBe('');
    expect(extractTitleFromPrompt('hi')).toBe('');
    expect(extractTitleFromPrompt('')).toBe('');
  });

  it('returns empty string for pure commands', () => {
    expect(extractTitleFromPrompt('/help')).toBe('');
    expect(extractTitleFromPrompt('git status')).toBe('');
    expect(extractTitleFromPrompt('ls -la')).toBe('');
  });

  it('returns empty string for code-only input', () => {
    expect(extractTitleFromPrompt('```\nconst x = 1;\n```')).toBe('');
  });

  it('truncates long titles on a word boundary', () => {
    const longPrompt = 'Refactor the entire authentication subsystem to use OAuth2 and JWT tokens across all microservices';
    const title = extractTitleFromPrompt(longPrompt);
    expect(title.length).toBeLessThanOrEqual(42);
    expect(title.length).toBeGreaterThan(0);
    // No partial word at the end
    expect(title).toMatch(/^\S+( \S+)*$/);
  });

  it('handles multi-sentence input by using the first sentence', () => {
    expect(extractTitleFromPrompt('Fix the login bug. Also update the tests for it.'))
      .toBe('Fix the login bug');
  });

  it('handles paths and code in the prompt', () => {
    expect(extractTitleFromPrompt('Refactor @src/components/Button.tsx to use hooks'))
      .toBe('Refactor to use hooks');
  });

  it('handles newlines in the prompt (treated as spaces)', () => {
    const title = extractTitleFromPrompt('Fix the login bug\nAnd add tests\nFor the new flow');
    // Newlines become spaces, then the first 7 words are taken
    expect(title).toBe('Fix the login bug And add tests');
  });

  it('drops at most 2 leading noise words', () => {
    // Three noise words in a row -> still drop only 2, the 3rd remains
    const title = extractTitleFromPrompt('hi ok please fix the login bug');
    // After dropping "hi" and "ok", we have "please fix the login bug"
    expect(title.toLowerCase()).toContain('fix the login');
  });

  it('returns empty when only noise words remain after dropping', () => {
    expect(extractTitleFromPrompt('hi ok thanks bye')).toBe('');
  });
});

describe('sessionNaming - extractTitleFromAgentResponse', () => {
  it('extracts from the first line of the response', () => {
    const response = "I'll refactor the auth flow to use async/await.\n\nHere's the plan:";
    expect(extractTitleFromAgentResponse(response)).toBe("I'll refactor the auth flow to use async/await");
  });

  it('skips empty leading lines', () => {
    const response = '\n\nLet me add error handling to the API endpoint.';
    expect(extractTitleFromAgentResponse(response)).toBe('Let me add error handling to the API endpoint');
  });

  it('handles responses that start with a code block', () => {
    const response = "```typescript\nconst x = 1;\n```\n\nI added the variable.";
    // The first non-empty line is a code fence -> strip -> empty
    // Falls through to subsequent line
    expect(extractTitleFromAgentResponse(response)).toBe('I added the variable');
  });

  it('returns empty for empty response', () => {
    expect(extractTitleFromAgentResponse('')).toBe('');
  });

  it('bounds the input to 500 chars', () => {
    const longResponse = 'x'.repeat(1000);
    expect(extractTitleFromAgentResponse(longResponse)).toBe('');
  });
});

describe('sessionNaming - buildContextualTitle', () => {
  it('prefers the prompt title when available', () => {
    expect(buildContextualTitle({
      projectName: 'my-app',
      prompt: 'Fix the login bug',
      agentResponse: 'I will refactor the database',
    })).toBe('Fix the login bug');
  });

  it('falls back to agent response when prompt is weak', () => {
    expect(buildContextualTitle({
      projectName: 'my-app',
      prompt: 'hi',
      agentResponse: 'I will refactor the database connection',
    })).toBe('I will refactor the database connection');
  });

  it('falls back to project name when nothing else is available', () => {
    expect(buildContextualTitle({
      projectName: 'cool-project',
      prompt: '',
      agentResponse: '',
    })).toBe('cool-project');
  });

  it('returns empty when nothing is available', () => {
    expect(buildContextualTitle({})).toBe('');
    expect(buildContextualTitle({ prompt: '', agentResponse: '' })).toBe('');
  });
});

describe('sessionNaming - deduplicateTitle', () => {
  it('returns the title unchanged when no clash', () => {
    expect(deduplicateTitle('Fix login bug', ['Other chat', 'Chat 1'])).toBe('Fix login bug');
  });

  it('appends (2) when the title is already taken', () => {
    expect(deduplicateTitle('Fix login bug', ['Fix login bug', 'Other chat']))
      .toBe('Fix login bug (2)');
  });

  it('appends (3) when both base and (2) are taken', () => {
    expect(deduplicateTitle('Fix login bug', ['Fix login bug', 'Fix login bug (2)']))
      .toBe('Fix login bug (3)');
  });

  it('is case-insensitive when matching', () => {
    expect(deduplicateTitle('Fix Login Bug', ['fix login bug']))
      .toBe('Fix Login Bug (2)');
  });

  it('returns empty unchanged', () => {
    expect(deduplicateTitle('', ['Other'])).toBe('');
  });

  it('finds the lowest free suffix even with gaps', () => {
    expect(deduplicateTitle('Task', ['Task', 'Task (2)', 'Task (4)']))
      .toBe('Task (3)');
  });
});
