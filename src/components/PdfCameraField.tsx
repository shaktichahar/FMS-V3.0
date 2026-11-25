import React, { useEffect, useRef, useState } from 'react';
import { Camera, CheckCircle2, FileText, Upload, X } from 'lucide-react';
import { jsPDF } from 'jspdf';
import { formatFileSize } from '../lib/format';
import type { SanctionAttachment } from '../types/finance';

export interface PendingPdfDraft {
  base64: string;
  fileName: string;
  sizeBytes: number;
  source: 'pdf-upload' | 'camera-scan';
}

interface PdfCameraFieldProps {
  label: string;
  defaultFilePrefix: string;
  value: PendingPdfDraft | null;
  onChange: (next: PendingPdfDraft | null) => void;
  existingAttachment?: SanctionAttachment;
  removeExisting?: boolean;
  onRemoveExisting?: () => void;
  onError?: (msg: string | null) => void;
}

export function PdfCameraField({
  label,
  defaultFilePrefix,
  value,
  onChange,
  existingAttachment,
  removeExisting = false,
  onRemoveExisting,
  onError,
}: PdfCameraFieldProps) {
  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [capturedPages, setCapturedPages] = useState<string[]>([]);
  const [buildingPdf, setBuildingPdf] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const pdfInputRef = useRef<HTMLInputElement | null>(null);
  const fallbackCameraInputRef = useRef<HTMLInputElement | null>(null);

  const stopCameraStream = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  };

  useEffect(() => {
    return () => {
      stopCameraStream();
    };
  }, []);

  const handlePdfFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
      onError?.('Please select a valid PDF (.pdf) file.');
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      onError?.('PDF file must be 8 MB or smaller.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      if (!result) {
        onError?.('Unable to read the selected PDF file.');
        return;
      }
      onError?.(null);
      onChange({
        base64: result,
        fileName: file.name,
        sizeBytes: file.size,
        source: 'pdf-upload',
      });
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  const startCamera = async () => {
    setCameraError(null);
    setCapturedPages([]);
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setCameraError(
        'Live camera preview is unavailable here. Use "Capture Photo" below to scan from your device camera.'
      );
      setCameraOpen(true);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1600 },
          height: { ideal: 1200 },
        },
        audio: false,
      });
      streamRef.current = stream;
      setCameraOpen(true);
      requestAnimationFrame(() => {
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          void videoRef.current.play();
        }
      });
    } catch {
      setCameraError(
        'Camera permission was denied or no live camera was detected. Use "Capture Photo" below to scan a page.'
      );
      setCameraOpen(true);
    }
  };

  const captureLiveFrame = () => {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0 || video.videoHeight === 0) return;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.88);
    setCapturedPages((prev) => [...prev, dataUrl]);
  };

  const handleFallbackPhotoCapture = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    files.forEach((file) => {
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === 'string') {
          setCapturedPages((prev) => [...prev, reader.result as string]);
          setCameraOpen(true);
        }
      };
      reader.readAsDataURL(file);
    });
    e.target.value = '';
  };

  const convertCapturedPagesToPdf = async () => {
    if (capturedPages.length === 0) return;
    setBuildingPdf(true);
    onError?.(null);
    try {
      const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
      const pageWidth = doc.internal.pageSize.getWidth();
      const pageHeight = doc.internal.pageSize.getHeight();
      const margin = 10;

      for (let i = 0; i < capturedPages.length; i += 1) {
        if (i > 0) doc.addPage();
        const imgData = capturedPages[i];
        const dims = await new Promise<{ w: number; h: number }>((resolve) => {
          const img = new Image();
          img.onload = () => resolve({ w: img.naturalWidth || 1200, h: img.naturalHeight || 1600 });
          img.onerror = () => resolve({ w: 1200, h: 1600 });
          img.src = imgData;
        });

        const maxW = pageWidth - margin * 2;
        const maxH = pageHeight - margin * 2;
        const ratio = Math.min(maxW / dims.w, maxH / dims.h);
        const renderW = dims.w * ratio;
        const renderH = dims.h * ratio;
        const offsetX = (pageWidth - renderW) / 2;
        const offsetY = (pageHeight - renderH) / 2;

        doc.addImage(imgData, 'JPEG', offsetX, offsetY, renderW, renderH, undefined, 'MEDIUM');
      }

      const dataUri = doc.output('datauristring');
      const approxBytes = Math.round((dataUri.length * 3) / 4);
      const safePrefix = (defaultFilePrefix || 'document').replace(/[^a-zA-Z0-9-_]/g, '_');

      onChange({
        base64: dataUri,
        fileName: `${safePrefix}_scan.pdf`,
        sizeBytes: approxBytes,
        source: 'camera-scan',
      });
      stopCameraStream();
      setCameraOpen(false);
      setCapturedPages([]);
    } catch {
      onError?.('Could not generate PDF from scanned pages. Please try again.');
    } finally {
      setBuildingPdf(false);
    }
  };

  return (
    <div className="space-y-2.5">
      <label className="block text-xs font-medium text-slate-700">{label}</label>

      <input
        ref={pdfInputRef}
        type="file"
        accept="application/pdf,.pdf"
        onChange={handlePdfFileSelect}
        className="hidden"
      />
      <input
        ref={fallbackCameraInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        onChange={handleFallbackPhotoCapture}
        className="hidden"
      />

      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => pdfInputRef.current?.click()}
          className="min-h-[42px] px-3 rounded-xl border border-slate-200 hover:border-teal-700 hover:bg-teal-50/30 text-xs font-semibold text-slate-800 flex items-center justify-center gap-1.5 cursor-pointer transition-colors"
        >
          <Upload className="w-3.5 h-3.5 text-teal-700 shrink-0" />
          <span>Attach PDF</span>
        </button>
        <button
          type="button"
          onClick={startCamera}
          className="min-h-[42px] px-3 rounded-xl border border-slate-200 hover:border-teal-700 hover:bg-teal-50/30 text-xs font-semibold text-slate-800 flex items-center justify-center gap-1.5 cursor-pointer transition-colors"
        >
          <Camera className="w-3.5 h-3.5 text-teal-700 shrink-0" />
          <span>Scan Camera</span>
        </button>
      </div>

      {value && (
        <div className="p-2.5 rounded-xl bg-emerald-50 border border-emerald-200 flex items-center justify-between gap-2.5">
          <div className="flex items-center gap-2 min-w-0">
            <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0" />
            <div className="min-w-0">
              <p className="text-xs font-semibold text-emerald-900 truncate">{value.fileName}</p>
              <p className="text-[11px] text-emerald-700">
                {formatFileSize(value.sizeBytes)} ·{' '}
                {value.source === 'camera-scan' ? 'Scanned to PDF' : 'PDF attached'}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => onChange(null)}
            aria-label={`Remove ${label}`}
            className="min-w-[32px] min-h-[32px] flex items-center justify-center rounded-lg text-emerald-800 hover:bg-emerald-100 cursor-pointer shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {!value && existingAttachment && !removeExisting && (
        <div className="p-2.5 rounded-xl bg-slate-50 border border-slate-200 flex items-center justify-between gap-2.5">
          <div className="flex items-center gap-2 min-w-0">
            <FileText className="w-4 h-4 text-teal-700 shrink-0" />
            <div className="min-w-0">
              <p className="text-xs font-medium text-slate-900 truncate">
                {existingAttachment.fileName}
              </p>
              <p className="text-[11px] text-slate-500">
                Attached · {formatFileSize(existingAttachment.sizeBytes)}
              </p>
            </div>
          </div>
          {onRemoveExisting && (
            <button
              type="button"
              onClick={onRemoveExisting}
              className="text-xs font-medium text-red-700 hover:underline px-2 py-1 cursor-pointer shrink-0"
            >
              Remove
            </button>
          )}
        </div>
      )}

      {cameraOpen && (
        <div className="p-3 rounded-xl bg-slate-900 text-white space-y-2.5">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold">Camera Scanner — {label}</p>
            <button
              type="button"
              onClick={() => {
                stopCameraStream();
                setCameraOpen(false);
              }}
              className="text-xs text-slate-300 hover:text-white px-2 py-1 cursor-pointer"
            >
              Close
            </button>
          </div>

          {cameraError ? (
            <div className="space-y-2">
              <p className="text-xs text-amber-300 leading-relaxed">{cameraError}</p>
              <button
                type="button"
                onClick={() => fallbackCameraInputRef.current?.click()}
                className="w-full min-h-[40px] rounded-xl bg-teal-600 hover:bg-teal-500 text-xs font-semibold text-white flex items-center justify-center gap-1.5 cursor-pointer"
              >
                <Camera className="w-4 h-4" />
                <span>Capture Photo / Choose Image</span>
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="relative rounded-lg overflow-hidden bg-black aspect-[4/3]">
                <video
                  ref={videoRef}
                  playsInline
                  muted
                  className="w-full h-full object-cover"
                />
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={captureLiveFrame}
                  className="flex-1 min-h-[40px] rounded-xl bg-teal-600 hover:bg-teal-500 text-xs font-semibold text-white flex items-center justify-center gap-1.5 cursor-pointer"
                >
                  <Camera className="w-4 h-4" />
                  <span>Capture Page ({capturedPages.length + 1})</span>
                </button>
                <button
                  type="button"
                  onClick={() => fallbackCameraInputRef.current?.click()}
                  className="min-h-[40px] px-3 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-medium text-slate-200 cursor-pointer whitespace-nowrap"
                >
                  Photo File
                </button>
              </div>
            </div>
          )}

          {capturedPages.length > 0 && (
            <div className="pt-2 border-t border-white/10 space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="text-slate-300">
                  {capturedPages.length} scanned {capturedPages.length === 1 ? 'page' : 'pages'}
                </span>
                <button
                  type="button"
                  onClick={() => setCapturedPages([])}
                  className="text-slate-400 hover:text-white cursor-pointer"
                >
                  Clear
                </button>
              </div>
              <div className="flex items-center gap-2 overflow-x-auto pb-1">
                {capturedPages.map((src, idx) => (
                  <div
                    key={idx}
                    className="relative shrink-0 w-14 h-18 rounded-md overflow-hidden border border-white/20"
                  >
                    <img
                      src={src}
                      alt={`Scanned page ${idx + 1}`}
                      className="w-full h-full object-cover"
                    />
                    <button
                      type="button"
                      onClick={() => setCapturedPages((prev) => prev.filter((_, i) => i !== idx))}
                      aria-label={`Remove page ${idx + 1}`}
                      className="absolute top-0.5 right-0.5 w-5 h-5 rounded-full bg-black/70 text-white flex items-center justify-center cursor-pointer"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
              <button
                type="button"
                disabled={buildingPdf}
                onClick={convertCapturedPagesToPdf}
                className="w-full min-h-[40px] rounded-xl bg-white text-slate-900 hover:bg-slate-100 disabled:opacity-60 text-xs font-semibold cursor-pointer"
              >
                {buildingPdf
                  ? 'Generating PDF...'
                  : `Save ${capturedPages.length} ${capturedPages.length === 1 ? 'Page' : 'Pages'} as PDF`}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
