import { Loader2 } from 'lucide-react';

interface LoadingOverlayProps {
  message?: string;
}

export function LoadingOverlay({ message = 'Loading...' }: LoadingOverlayProps) {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-3">
      <Loader2 size={28} className="text-accent-500 animate-spin" />
      <p className="text-sm text-surface-500">{message}</p>
    </div>
  );
}
