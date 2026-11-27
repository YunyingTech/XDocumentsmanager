import { render, screen } from '@testing-library/react';
import { beforeEach, expect, it } from 'vitest';
import { StartupProgress } from './StartupProgress';
import { useUIStore } from '../../stores/uiStore';

beforeEach(() => useUIStore.setState({ language: 'en' }));
it('shows completed stages, actual document counts and elapsed time', () => {
  render(<StartupProgress status={{ phase: 'search_sync', ready: true, error: null, completed_steps: 3, processed: 500, total: 1000, elapsed_ms: 42000 }} />);
  const progress = screen.getByRole('progressbar', { name: 'Startup progress' });
  expect(progress).toHaveAttribute('value', '3');
  expect(progress).toHaveAttribute('max', '4');
  expect(screen.getByText('500 / 1,000')).toBeInTheDocument();
  expect(screen.getByText(/42s/)).toBeInTheDocument();
});
it('keeps the progress visible after the library opens and explains search failure', () => {
  const view = render(<StartupProgress compact status={{ phase: 'search_starting', ready: true, error: null, completed_steps: 2 }} />);
  expect(screen.getByText('Preparing search in background')).toBeInTheDocument();
  view.rerender(<StartupProgress compact status={{ phase: 'ready', ready: true, error: 'shards unavailable' }} />);
  expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  expect(screen.getByTitle('shards unavailable')).toHaveTextContent('Local search is available');
});
