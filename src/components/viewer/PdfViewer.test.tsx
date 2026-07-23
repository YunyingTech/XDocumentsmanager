import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const mocks = vi.hoisted(() => ({
  readFileBytes: vi.fn(),
  destroy: vi.fn(),
  getPage: vi.fn(),
  renderCancel: vi.fn(),
}));

vi.mock('../../lib/tauri', () => ({ readFileBytes: mocks.readFileBytes }));
vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: () => ({
    promise: Promise.resolve({
      numPages: 2,
      destroy: mocks.destroy,
      getPage: mocks.getPage,
    }),
  }),
}));

import { useUIStore } from '../../stores/uiStore';
import { PdfViewer } from './PdfViewer';

describe('PDF viewer', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
    useUIStore.setState({ language: 'en' });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as CanvasRenderingContext2D);
    mocks.getPage.mockResolvedValue({
      getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale }),
      render: () => ({ promise: Promise.resolve(), cancel: mocks.renderCancel }),
    });
  });

  it('loads pages, navigates, zooms, and closes', async () => {
    mocks.readFileBytes.mockResolvedValue([37, 80, 68, 70]);
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<PdfViewer filePath="C:\\docs\\two-pages.pdf" fileName="two-pages.pdf" onClose={onClose} mode="embedded" />);

    expect(await screen.findByText('1 / 2')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    expect(screen.getByText('2 / 2')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(screen.getByText('140%')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Close PDF viewer' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('shows backend read errors without exposing Invalid Date or a blank canvas', async () => {
    mocks.readFileBytes.mockRejectedValue(new Error('File no longer exists'));
    render(<PdfViewer filePath="C:\\missing.pdf" fileName="missing.pdf" onClose={() => undefined} />);
    expect(await screen.findByText('File no longer exists')).toBeInTheDocument();
    expect(screen.queryByRole('canvas')).not.toBeInTheDocument();
  });
});
