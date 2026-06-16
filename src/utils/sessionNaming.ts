/**
 * Session naming utility.
 *
 * The app auto-names chat sessions based on what the user types and what the
 * agent does. The goal is to produce short, human-readable titles that help
 * the user find the right session later when scanning the session rail.
 *
 * Strategy:
 *   1. Pull a candidate string from the user's first prompt (multi-line aware).
 *   2. Strip noise: file paths, code snippets, @-mentions, URLs, backticks,
 *      shell-style commands, control characters.
 *   3. Extract the most "title-worthy" substring (2+ words, not a known
 *      shell command, not too long).
 *   4. Optionally enrich with project name or a hint derived from the agent's
 *      first response (e.g. "Refactor auth flow", "Fix login bug").
 *   5. Apply length/word limits, then sentence-case the result.
 *   6. Deduplicate against sibling titles by appending a small numeric suffix.
 *
 * The functions in this module are pure and side-effect free so they can be
 * unit-tested in isolation. The component layer (AgentPanel / App) decides
 * when to call them and what to do with the result (rename, no-op, etc.).
 */

const MAX_TITLE_CHARS = 42;
const MAX_WORDS = 7;
const MIN_PROMPT_CHARS = 8;
const MIN_WORDS = 2;

// Words/commands that don't make a good title. The first word of the prompt
// matching any of these is treated as "this isn't a real prompt" and the
// extractor falls through to the next non-noise word.
const NOISE_FIRST_WORDS = new Set([
  '?', '/help', 'help', 'exit', 'clear', 'cls', 'ls', 'dir', 'pwd', 'cd',
  'whoami', 'sudo', 'npm', 'yarn', 'pnpm', 'git', 'echo', 'cat', 'mv', 'cp',
  'rm', 'mkdir', 'touch', 'vi', 'vim', 'nano', 'code', 'open',
]);

// Common directory names that should be treated as path-like when they
// follow a leading noise word (e.g. "cd src && explain" -> "Explain").
const COMMON_DIR_NAMES = new Set([
  'src', 'dist', 'build', 'lib', 'bin', 'out', 'app', 'apps', 'pkg',
  'test', 'tests', '__tests__', 'spec', 'specs', 'docs', 'doc',
  'public', 'static', 'assets', 'config', 'configs', 'scripts',
]);

// Generic greetings / pleasantries that produce useless titles like
// "Hi can you help me". We still attempt to extract a meaningful tail when
// possible (e.g. "hi, can you refactor the login flow?" -> "Refactor the
// login flow").
const GENERIC_GREETINGS = new Set([
  'hi', 'hey', 'hello', 'yo', 'sup', 'hiya', 'heya', 'howdy', 'hola',
  'thanks', 'thank', 'ty', 'thx', 'cheers', 'bye', 'goodbye', 'cya',
  'ok', 'okay', 'cool', 'great', 'nice', 'awesome', 'sweet', 'wow',
  'please', 'pls', 'plz',
]);

/**
 * Return true if the user has already manually named this session.
 * We only auto-rename when the label is still a default ("Chat N" or
 * "Untitled"), so manual renames are always preserved.
 */
export function isDefaultLabel(label: string | null | undefined): boolean {
  if (!label) return true;
  return /^Chat\s+\d+$/i.test(label.trim()) || /^Untitled(\s+\d+)?$/i.test(label.trim());
}

/**
 * Strip code blocks, inline backticks, file paths, URLs, and @-mentions
 * from a prompt. Returns a cleaned string. This is intentionally permissive
 * — better to keep too much than to drop real content.
 */
export function stripPromptNoise(input: string): string {
  let s = input;
  // Remove fenced code blocks ```...```
  s = s.replace(/```[\s\S]*?```/g, ' ');
  // Remove inline backticks `...`
  s = s.replace(/`[^`\n]*`/g, ' ');
  // Remove @-mentions like @src/utils/foo.ts or @"/path with spaces".
  // The exclusion class deliberately stops at '.', so a trailing file
  // extension like .ts is left behind and cleaned up by the file-extension
  // step below.
  s = s.replace(/@"[^"]*"/g, ' ');
  s = s.replace(/@[^\s,;.?!\)\]]+/g, ' ');
  // Remove URLs
  s = s.replace(/https?:\/\/\S+/g, ' ');
  // Remove absolute Unix file paths (must start with /). Uses a permissive
  // class so paths with dashes / dots in the middle are caught.
  s = s.replace(/\/[^\s,;!?]*?\.[a-z0-9]{1,8}/gi, ' ');
  // Remove absolute Windows file paths (C:\...)
  s = s.replace(/[a-z]:\\[^\s,;!?]*/gi, ' ');
  // Remove orphan file extensions left behind (e.g. ".ts" after stripping
  // "@src/utils/foo"). Only matches when preceded by whitespace and is a
  // short lowercase token.
  s = s.replace(/(^|\s)\.[a-z0-9]{1,8}(?=\s|$)/g, ' ');
  // Collapse all whitespace
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

/**
 * Extract a candidate title from a raw prompt string.
 *
 * Handles multi-line input, leading greetings, and noise. Returns an empty
 * string if no reasonable title can be produced.
 */
export function extractTitleFromPrompt(prompt: string): string {
  return extractTitle(prompt, { maxWords: MAX_WORDS, maxChars: MAX_TITLE_CHARS });
}

/**
 * Derive a hint from the agent's first response. Many coding agents echo
 * back a short summary line at the top of their reply (e.g. "I'll refactor
 * the auth flow to use async/await."). We grab the first sentence of the
 * response and treat it like a prompt for extraction, with a slightly
 * higher word limit since agent summaries tend to be information-dense.
 *
 * If the first non-empty line yields no title (e.g. it's a code fence or
 * a one-word status indicator), we fall through to subsequent lines.
 * Lines that look like code (contain semicolons, operators, or start with
 * code keywords) are skipped.
 */
export function extractTitleFromAgentResponse(response: string): string {
  if (!response) return '';
  // Take the first ~500 chars of the response to bound work
  const head = response.slice(0, 500);
  const lines = head.split('\n').map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    if (looksLikeCode(line)) continue;
    const title = extractTitle(line, { maxWords: 10, maxChars: 52 });
    if (title) return title;
  }
  return '';
}

/**
 * Heuristic: does this line look like source code rather than prose?
 * We check for common code patterns: semicolons, balanced braces, common
 * code keywords at the start, or lines that are mostly operators.
 */
function looksLikeCode(line: string): boolean {
  // Lines starting with common code keywords
  if (/^(const|let|var|function|class|interface|type|import|export|return|if|for|while|switch|try|catch|throw|new|async|await|def|fn|pub|impl|struct|enum)\b/.test(line)) return true;
  // Lines containing semicolons (common in C-family languages)
  if (/;/.test(line)) return true;
  // Lines that are mostly brackets/operators
  if (/[{}()[\];]/.test(line) && line.replace(/[{}()[\];\s]/g, '').length < line.length / 2) return true;
  // Lines that look like a function call with no prose
  if (/^[a-zA-Z_$][a-zA-Z0-9_$.]*\([^)]*\)\s*[{;]?$/.test(line)) return true;
  return false;
}

/** Internal: like extractTitleFromPrompt but with caller-tunable limits. */
function extractTitle(input: string, opts: { maxWords: number; maxChars: number }): string {
  if (!input) return '';
  const cleaned = stripPromptNoise(input);
  if (cleaned.length < MIN_PROMPT_CHARS) return '';
  const hasTerminalPunc = /[.!?]/.test(cleaned);
  let candidate: string;
  if (hasTerminalPunc) {
    const sentences = cleaned
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim().replace(/[.!?]+$/, ''))
      .filter(Boolean);
    candidate = sentences.length > 0 ? sentences[0] : cleaned;
  } else {
    candidate = cleaned;
  }
  let words = candidate.split(/\s+/).filter((w) => w.length > 0);
  if (words.length < MIN_WORDS) return '';
  let dropped = 0;
  while (words.length >= MIN_WORDS && dropped < 3) {
    const firstRaw = words[0];
    const first = firstRaw.toLowerCase().replace(/[^\w/]+/g, '');
    const isOperator = firstRaw === '&&' || firstRaw === '||' || firstRaw === '|' || firstRaw === '>' || firstRaw === '<' || firstRaw === ';';
    const isPathLike = /^[a-zA-Z0-9_.-]*[\\/][a-zA-Z0-9_.-]*$/.test(firstRaw) || /^\.\.?[\\/]/.test(firstRaw);
    const isCommonDir = dropped > 0 && COMMON_DIR_NAMES.has(first);
    if (NOISE_FIRST_WORDS.has(first) || GENERIC_GREETINGS.has(first) || isOperator || isPathLike || isCommonDir) {
      words = words.slice(1);
      dropped++;
    } else {
      break;
    }
  }
  if (words.length < MIN_WORDS) return '';
  const allNoise = words.every((w) => {
    const lower = w.toLowerCase().replace(/[^\w/]+/g, '');
    return GENERIC_GREETINGS.has(lower);
  });
  if (allNoise) return '';
  words = words.slice(0, opts.maxWords);
  let title = words.join(' ');
  if (title.length > opts.maxChars) {
    title = title.slice(0, opts.maxChars).replace(/\s\S*$/, '');
  }
  if (title.length < 3) return '';
  title = title.charAt(0).toUpperCase() + title.slice(1);
  return title;
}

/**
 * Build a title that combines project context with a prompt-derived title.
 * Falls back to just the prompt title or just the project name.
 */
export function buildContextualTitle(opts: {
  projectName?: string | null;
  prompt?: string;
  agentResponse?: string;
}): string {
  const promptTitle = opts.prompt ? extractTitleFromPrompt(opts.prompt) : '';
  const responseTitle = opts.agentResponse ? extractTitleFromAgentResponse(opts.agentResponse) : '';

  // Prefer the prompt title when it's strong; otherwise fall back to the
  // agent's first response. This order matters: the user typed it, so it
  // reflects their intent more than the agent's reply does.
  let base = promptTitle || responseTitle;

  // If we still have nothing but have a project name, surface the project.
  if (!base && opts.projectName) {
    const cleanedProject = stripPromptNoise(opts.projectName).replace(/\s+/g, ' ').trim();
    if (cleanedProject.length > 0) base = cleanedProject;
  }

  return base;
}

/**
 * Make a candidate title unique against an array of existing titles.
 * - "Fix login bug" with no clash  -> "Fix login bug"
 * - "Fix login bug" with one clash -> "Fix login bug (2)"
 * - "Fix login bug" with two clashing siblings -> "Fix login bug (3)"
 */
export function deduplicateTitle(candidate: string, existing: string[]): string {
  if (!candidate) return candidate;
  const taken = new Set(existing.map((t) => t.trim().toLowerCase()));
  const lower = candidate.trim().toLowerCase();
  if (!taken.has(lower)) return candidate;
  for (let i = 2; i < 1000; i++) {
    const next = `${candidate} (${i})`;
    if (!taken.has(next.toLowerCase())) return next;
  }
  // Pathological fallback
  return `${candidate} (${Date.now()})`;
}
