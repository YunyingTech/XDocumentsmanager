import { beforeEach, describe, expect, it } from 'vitest';
import { useUIStore } from './uiStore';

describe('UI store', () => {
  beforeEach(() => {
    localStorage.clear();
    useUIStore.setState({
      activeView: 'files',
      surfaceView: 'workspace',
      sidebarOpen: true,
      theme: 'system',
      language: 'en',
    });
  });

  it('switches views, surfaces, sidebar, and theme', () => {
    useUIStore.getState().setSurfaceView('logs');
    expect(useUIStore.getState().surfaceView).toBe('logs');
    useUIStore.getState().setView('search');
    expect(useUIStore.getState()).toMatchObject({ activeView: 'search', surfaceView: 'workspace' });
    useUIStore.getState().toggleSidebar();
    useUIStore.getState().setTheme('dark');
    expect(useUIStore.getState()).toMatchObject({ sidebarOpen: false, theme: 'dark' });
  });

  it('persists the selected language', () => {
    useUIStore.getState().setLanguage('zh-CN');
    expect(useUIStore.getState().language).toBe('zh-CN');
    expect(localStorage.getItem('xdocuments-language')).toBe('zh-CN');
  });
});
