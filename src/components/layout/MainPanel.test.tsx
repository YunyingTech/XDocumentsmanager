import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { useUIStore } from '../../stores/uiStore';
import { MainPanel } from './MainPanel';

vi.mock('../file-browser/FileBrowser', () => ({ FileBrowser: () => <div>File library mounted</div> }));
vi.mock('../search/SearchView', () => ({ SearchView: () => null }));
vi.mock('../folders/FolderManager', () => ({ FolderManager: () => null }));
vi.mock('../settings/SettingsPanel', () => ({ SettingsPanel: () => null }));
vi.mock('../ocr/OcrPage', () => ({ OcrPage: () => null }));
vi.mock('../logs/RuntimeLogs', () => ({ RuntimeLogs: () => <div>Log reader mounted</div> }));
beforeEach(() => useUIStore.setState({ activeView: 'files', surfaceView: 'workspace', language: 'en' }));

it('keeps workspace queries unmounted until ready while allowing log navigation', () => {
  const view = render(<MainPanel startup={{ phase: 'search_sync', ready: false, error: null }} />);
  expect(screen.getByRole('status')).toHaveTextContent('Synchronizing');
  expect(screen.queryByText('File library mounted')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Runtime logs' }));
  expect(screen.getByText('Log reader mounted')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Workspace' }));
  view.rerender(<MainPanel startup={{ phase: 'ready', ready: true, error: null }} />);
  expect(screen.getByText('File library mounted')).toBeInTheDocument();
});

it('shows an actionable failure instead of an endless spinner', () => {
  render(<MainPanel startup={{ phase: 'failed', ready: false, error: 'database locked' }} />);
  expect(screen.getByRole('alert')).toHaveTextContent('database locked');
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Runtime logs' }));
  expect(screen.getByText('Log reader mounted')).toBeInTheDocument();
});
