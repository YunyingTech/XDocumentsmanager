import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as api from '../../lib/tauri';
import { useOcrStore } from '../../stores/ocrStore';
import { useUIStore } from '../../stores/uiStore';
import { OcrPage } from './OcrPage';
import { SettingsPanel } from '../settings/SettingsPanel';

vi.mock('../../lib/tauri');
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn().mockResolvedValue(() => undefined) }));

describe('RapidOCR concurrency inputs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useUIStore.setState({ language: 'en' });
    useOcrStore.setState({ engine: 'rapid', rapidWorkerCount: 3, candidates: [], selectedFileIds: new Set() });
    vi.mocked(api.getSetting).mockImplementation(async (key) => key === 'rapidocr_worker_count' ? '256' : null);
    vi.mocked(api.setSetting).mockResolvedValue(undefined);
    vi.mocked(api.getRapidOcrStatus).mockRejectedValue(new Error('Runtime not started in UI test'));
    vi.mocked(api.getOpenAiConfig).mockResolvedValue({ endpoint: '', model: '', api_key_configured: false, smart_search_enabled: false });
    vi.mocked(api.listOcrCandidates).mockResolvedValue({ items: [], total: 0, page: 0, page_size: 50, total_pages: 0 });
  });

  it.each([
    ['OCR page', OcrPage], ['Settings panel', SettingsPanel],
  ] as const)('%s loads, accepts, and saves 256 workers', async (_name, Component) => {
    render(<Component />);
    const input = screen.getByRole('spinbutton', { name: 'Parallel workers' });
    expect(input).toHaveAttribute('min', '1');
    expect(input).toHaveAttribute('max', '256');
    await waitFor(() => expect(input).toHaveValue(256));
    fireEvent.change(input, { target: { value: '128' } });
    await waitFor(() => expect(api.setSetting).toHaveBeenLastCalledWith('rapidocr_worker_count', '128'));
    fireEvent.change(input, { target: { value: '256' } });
    await waitFor(() => expect(api.setSetting).toHaveBeenLastCalledWith('rapidocr_worker_count', '256'));
    expect(input).toHaveValue(256);
  });
});
