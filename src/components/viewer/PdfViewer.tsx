import { useState, useEffect, useRef } from 'react';
import { X, ChevronLeft, ChevronRight, ZoomIn, ZoomOut } from 'lucide-react';
import { readFileBytes } from '../../lib/tauri';
import { useI18n } from '../../lib/i18n';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import { useDialogFocus } from '../../hooks/useDialogFocus';

interface PdfViewerProps {
  filePath: string;
  fileName: string;
  onClose: () => void;
  mode?: 'modal' | 'embedded';
}

export function PdfViewer({ filePath, fileName, onClose, mode = 'modal' }: PdfViewerProps) {
  const { t } = useI18n();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pageNum, setPageNum] = useState(1);
  const [totalPages, setTotalPages] = useState(0);
  const [scale, setScale] = useState(1.2);
  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null);
  const dialogRef = useDialogFocus(mode === 'modal', onClose);

  useEffect(() => {
    let cancelled = false;

    let loadedDoc: PDFDocumentProxy | null = null;

    async function loadPdf() {
      setLoading(true);
      setError(null);
      setPdfDoc(null);
      setTotalPages(0);
      try {
        const bytes = await readFileBytes(filePath);
        if (cancelled) return;

        const data = new Uint8Array(bytes);
        const pdfjsLib = await import('pdfjs-dist');
        pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

        const doc = await pdfjsLib.getDocument({ data }).promise;
        loadedDoc = doc;
        if (cancelled) {
          await doc.destroy();
          return;
        }

        setPdfDoc(doc);
        setTotalPages(doc.numPages);
        setPageNum(1);
      } catch (err: any) {
        if (!cancelled) {
          setError(err?.message || t('viewer.loadFailed'));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadPdf();
    return () => {
      cancelled = true;
      if (loadedDoc) void loadedDoc.destroy();
    };
  }, [filePath, t]);

  return (
    <div
      ref={dialogRef}
      role={mode === 'modal' ? 'dialog' : 'region'}
      aria-modal={mode === 'modal' ? 'true' : undefined}
      aria-label={`${t('files.preview')}: ${fileName}`}
      aria-busy={loading}
      tabIndex={mode === 'modal' ? -1 : undefined}
      onKeyDown={(event) => {
        if (!pdfDoc) return;
        if (event.key === 'ArrowLeft') setPageNum((page) => Math.max(1, page - 1));
        if (event.key === 'ArrowRight') setPageNum((page) => Math.min(totalPages, page + 1));
        if (event.key === '+' || event.key === '=') setScale((value) => Math.min(3, value + 0.2));
        if (event.key === '-') setScale((value) => Math.max(0.5, value - 0.2));
      }}
      className={`${mode === 'modal' ? 'fixed inset-0 z-50' : 'h-full min-h-0'} flex flex-col overscroll-contain bg-surface-950`}
    >
      {/* Toolbar */}
      <div className="flex items-center gap-3 px-4 h-12 bg-surface-900/80 backdrop-blur text-surface-300">
        <span className="text-sm font-medium truncate flex-1">{fileName}</span>

        <button
          onClick={() => setScale((s) => Math.max(0.5, s - 0.2))}
          className="p-1.5 rounded-lg hover:bg-surface-800"
          disabled={!pdfDoc || scale <= 0.5}
          title={t('viewer.zoomOut')}
          aria-label={t('viewer.zoomOut')}
        >
          <ZoomOut size={16} aria-hidden="true" />
        </button>
        <span className="text-xs w-12 text-center">{Math.round(scale * 100)}%</span>
        <button
          onClick={() => setScale((s) => Math.min(3, s + 0.2))}
          className="p-1.5 rounded-lg hover:bg-surface-800"
          disabled={!pdfDoc || scale >= 3}
          title={t('viewer.zoomIn')}
          aria-label={t('viewer.zoomIn')}
        >
          <ZoomIn size={16} aria-hidden="true" />
        </button>

        <div className="flex items-center gap-1">
          <button
            onClick={() => setPageNum((p) => Math.max(1, p - 1))}
            className="p-1.5 rounded-lg hover:bg-surface-800"
            disabled={!pdfDoc || pageNum <= 1}
            title={t('viewer.previousPage')}
            aria-label={t('viewer.previousPage')}
          >
            <ChevronLeft size={16} aria-hidden="true" />
          </button>
          <span className="text-xs w-20 text-center">
            {pageNum} / {totalPages || '-'}
          </span>
          <button
            onClick={() => setPageNum((p) => Math.min(totalPages, p + 1))}
            className="p-1.5 rounded-lg hover:bg-surface-800"
            disabled={!pdfDoc || pageNum >= totalPages}
            title={t('viewer.nextPage')}
            aria-label={t('viewer.nextPage')}
          >
            <ChevronRight size={16} aria-hidden="true" />
          </button>
        </div>

        <button type="button" onClick={onClose} className="p-1.5 rounded-lg hover:bg-surface-800 ml-2" title={t('viewer.close')} aria-label={t('viewer.close')} data-dialog-initial-focus>
          <X size={18} aria-hidden="true" />
        </button>
      </div>

      {/* Content */}
      <div className="flex min-h-0 flex-1 items-start justify-center overflow-auto p-4">
        {loading && (
          <div className="text-surface-400 text-sm py-16" role="status" aria-live="polite">{t('viewer.loading')}</div>
        )}
        {error && (
          <div className="text-red-400 text-sm py-16" role="alert">{error}</div>
        )}
        {pdfDoc && (
          <PdfPage doc={pdfDoc} pageNum={pageNum} scale={scale} label={`${fileName}, ${t('files.pages')} ${pageNum}`} />
        )}
      </div>
    </div>
  );
}

function PdfPage({ doc, pageNum, scale, label }: { doc: PDFDocumentProxy; pageNum: number; scale: number; label: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let cancelled = false;
    let renderTask: RenderTask | null = null;

    void doc.getPage(pageNum).then((page) => {
      if (cancelled) return;
      const viewport = page.getViewport({ scale });
      canvas.height = viewport.height;
      canvas.width = viewport.width;

      const context = canvas.getContext('2d');
      if (!context) return;
      renderTask = page.render({ canvasContext: context, viewport });
      return renderTask.promise;
    }).catch((error: unknown) => {
      if (!cancelled && (error as { name?: string }).name !== 'RenderingCancelledException') {
        console.error('PDF page rendering failed:', error);
      }
    });

    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [doc, pageNum, scale]);

  return (
    <canvas
      ref={canvasRef}
      role="img"
      aria-label={label}
      className="shadow-2xl rounded"
    />
  );
}
