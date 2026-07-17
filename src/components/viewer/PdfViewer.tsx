import { useState, useEffect } from 'react';
import { X, ChevronLeft, ChevronRight, ZoomIn, ZoomOut } from 'lucide-react';
import { readFileBytes } from '../../lib/tauri';

interface PdfViewerProps {
  filePath: string;
  fileName: string;
  onClose: () => void;
}

export function PdfViewer({ filePath, fileName, onClose }: PdfViewerProps) {
  const [pdfData, setPdfData] = useState<Uint8Array | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pageNum, setPageNum] = useState(1);
  const [totalPages, setTotalPages] = useState(0);
  const [scale, setScale] = useState(1.2);
  const [pdfDoc, setPdfDoc] = useState<any>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadPdf() {
      setLoading(true);
      setError(null);
      try {
        const bytes = await readFileBytes(filePath);
        if (cancelled) return;

        const data = new Uint8Array(bytes);
        setPdfData(data);

        // Dynamic import PDF.js
        const pdfjsLib = await import('pdfjs-dist');
        pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';

        const doc = await pdfjsLib.getDocument({ data }).promise;
        if (cancelled) return;

        setPdfDoc(doc);
        setTotalPages(doc.numPages);
        setPageNum(1);
      } catch (err: any) {
        if (!cancelled) {
          setError(err?.message || 'Failed to load PDF');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadPdf();
    return () => { cancelled = true; };
  }, [filePath]);

  return (
    <div className="fixed inset-0 z-50 bg-surface-950/90 flex flex-col">
      {/* Toolbar */}
      <div className="flex items-center gap-3 px-4 h-12 bg-surface-900/80 backdrop-blur text-surface-300">
        <span className="text-sm font-medium truncate flex-1">{fileName}</span>

        <button
          onClick={() => setScale((s) => Math.max(0.5, s - 0.2))}
          className="p-1.5 rounded-lg hover:bg-surface-800"
          disabled={!pdfDoc}
        >
          <ZoomOut size={16} />
        </button>
        <span className="text-xs w-12 text-center">{Math.round(scale * 100)}%</span>
        <button
          onClick={() => setScale((s) => Math.min(3, s + 0.2))}
          className="p-1.5 rounded-lg hover:bg-surface-800"
          disabled={!pdfDoc}
        >
          <ZoomIn size={16} />
        </button>

        <div className="flex items-center gap-1">
          <button
            onClick={() => setPageNum((p) => Math.max(1, p - 1))}
            className="p-1.5 rounded-lg hover:bg-surface-800"
            disabled={!pdfDoc || pageNum <= 1}
          >
            <ChevronLeft size={16} />
          </button>
          <span className="text-xs w-20 text-center">
            {pageNum} / {totalPages || '—'}
          </span>
          <button
            onClick={() => setPageNum((p) => Math.min(totalPages, p + 1))}
            className="p-1.5 rounded-lg hover:bg-surface-800"
            disabled={!pdfDoc || pageNum >= totalPages}
          >
            <ChevronRight size={16} />
          </button>
        </div>

        <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-surface-800 ml-2">
          <X size={18} />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto flex items-start justify-center p-4">
        {loading && (
          <div className="text-surface-400 text-sm py-16">Loading PDF...</div>
        )}
        {error && (
          <div className="text-red-400 text-sm py-16">{error}</div>
        )}
        {pdfData && !pdfDoc && !loading && !error && (
          <div className="text-surface-400 text-sm py-16">
            PDF loaded. Rendering will be available when PDF.js worker is configured.
            <br />
            <span className="text-xs mt-2 block">
              File size: {pdfData.byteLength.toLocaleString()} bytes
            </span>
          </div>
        )}
        {pdfDoc && (
          <PdfPage doc={pdfDoc} pageNum={pageNum} scale={scale} />
        )}
      </div>
    </div>
  );
}

function PdfPage({ doc, pageNum, scale }: { doc: any; pageNum: number; scale: number }) {
  const canvasRef = (el: HTMLCanvasElement | null) => {
    if (!el || !doc) return;

    doc.getPage(pageNum).then((page: any) => {
      const viewport = page.getViewport({ scale });
      const canvas = el;
      canvas.height = viewport.height;
      canvas.width = viewport.width;

      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      page.render({
        canvasContext: ctx,
        viewport,
      });
    });
  };

  return (
    <canvas
      ref={canvasRef}
      className="shadow-2xl rounded"
    />
  );
}
