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
        'src/hooks/useAppUpdates.ts',
        'src/components/search/{SearchResults,SearchView}.tsx',
        'src/components/layout/TaskCenter.tsx',
        'src/components/settings/UpdateSettings.tsx',
        'src/components/viewer/PdfViewer.tsx',
        'src/components/logs/RuntimeLogs.tsx',
        'src/components/layout/{MainPanel,StartupScreen}.tsx',
        'src/hooks/{useStartup,useRuntimeLogs}.ts',
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
