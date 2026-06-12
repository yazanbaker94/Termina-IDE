export interface SampleFile {
  name: string;
  path: string;
  content: string;
}

export const sampleFiles: SampleFile[] = [
  {
    name: 'index.ts',
    path: 'src/index.ts',
    content: `import { greet } from './utils';

const message = greet('Command Code IDE');
console.log(message);

export function bootstrap(): void {
  console.log('IDE starting...');
  // Initialization logic here
}

bootstrap();`,
  },
  {
    name: 'utils.ts',
    path: 'src/utils.ts',
    content: `export function greet(name: string): string {
  return \`Hello, \${name}!\`;
}

export function add(a: number, b: number): number {
  return a + b;
}

export function formatDate(date: Date): string {
  return date.toISOString().split('T')[0];
}`,
  },
  {
    name: 'app.tsx',
    path: 'src/app.tsx',
    content: `import React from 'react';

interface AppProps {
  title: string;
}

export const App: React.FC<AppProps> = ({ title }) => {
  return (
    <div className="app">
      <header>
        <h1>{title}</h1>
      </header>
      <main>
        <p>Welcome to your new project.</p>
      </main>
    </div>
  );
};`,
  },
  {
    name: 'styles.css',
    path: 'src/styles.css',
    content: `:root {
  --bg-primary: #1e1e2e;
  --bg-secondary: #181825;
  --text-primary: #cdd6f4;
  --text-muted: #6c7086;
  --accent: #cba6f7;
  --border: #313244;
  --surface: #1e1e2e;
}

* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  font-family: 'Inter', -apple-system, sans-serif;
  background: var(--bg-primary);
  color: var(--text-primary);
}`,
  },
];
