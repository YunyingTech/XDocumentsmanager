import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: [
        'src/lib/{format,i18n,tauri}.ts',
        'src/stores/*.ts',
        'src/components/search/{SearchResults,SearchView}.tsx',
        'src/components/layout/TaskCenter.tsx',
        'src/components/viewer/PdfViewer.tsx',
      ],
      thresholds: {
        statements: 75,
        branches: 50,
        functions: 75,
        lines: 75,
      },
    },
  },
});
