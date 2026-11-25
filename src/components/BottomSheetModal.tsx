import React, { useEffect } from 'react';
import { X } from 'lucide-react';

interface BottomSheetModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}

export function BottomSheetModal({
  open,
  onClose,
  title,
  subtitle,
  children,
}: BottomSheetModalProps) {
  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', handleKey);
      document.body.style.overflow = '';
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end md:items-center justify-center bg-slate-950/50 backdrop-blur-[2px] md:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="sheet-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full md:max-w-lg bg-white rounded-t-3xl md:rounded-2xl border border-slate-200 shadow-2xl max-h-[90vh] flex flex-col overflow-hidden">
        {/* Android Bottom Sheet Drag Handle */}
        <div className="md:hidden pt-3 pb-1 flex justify-center">
          <div className="w-10 h-1.5 rounded-full bg-slate-300" aria-hidden="true" />
        </div>

        <div className="flex items-start justify-between gap-4 px-5 py-4 border-b border-slate-100">
          <div className="min-w-0">
            <h2
              id="sheet-title"
              className="text-lg font-semibold text-slate-900 tracking-tight truncate"
            >
              {title}
            </h2>
            {subtitle && (
              <p className="text-xs text-slate-500 mt-0.5">{subtitle}</p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close dialog"
            className="min-h-[44px] min-w-[44px] -mr-2 -mt-1.5 flex items-center justify-center rounded-xl text-slate-500 hover:text-slate-900 hover:bg-slate-100 transition-colors focus-visible:outline-2 focus-visible:outline-teal-700"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-5 py-5 overflow-y-auto flex-1">{children}</div>
      </div>
    </div>
  );
}
