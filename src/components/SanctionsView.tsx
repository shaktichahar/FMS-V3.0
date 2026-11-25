import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Camera,
  Check,
  CheckCircle2,
  Clock,
  Download,
  Eye,
  FileSpreadsheet,
  FileText,
  Pencil,
  Plus,
  Search,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { jsPDF } from 'jspdf';
import { api } from '../lib/api';
import {
  computeFinancialYear,
  formatCurrency,
  formatFileSize,
  formatFinancialYearRange,
  formatShortDate,
} from '../lib/format';
import type {
  BudgetHeadEnriched,
  BudgetSanctionEnriched,
  SafeUser,
} from '../types/finance';
import { BottomSheetModal } from './BottomSheetModal';

interface SanctionsViewProps {
  user: SafeUser;
  sanctions: BudgetSanctionEnriched[];
  budgetHeads: BudgetHeadEnriched[];
  onRefresh: () => Promise<void>;
  onOpenImport: () => void;
  preselectedHeadId?: string | null;
  externalOpenCreate?: boolean;
  onConsumeExternalCreate?: () => void;
}

interface PendingPdfDraft {
  base64: string;
  fileName: string;
  sizeBytes: number;
  source: 'pdf-upload' | 'camera-scan';
}

export function SanctionsView({
  user,
  sanctions,
  budgetHeads,
  onRefresh,
  onOpenImport,
  preselectedHeadId,
  externalOpenCreate,
  onConsumeExternalCreate,
}: SanctionsViewProps) {
  const isAdmin = user.role === 'admin';
  const [search, setSearch] = useState('');
  const [selectedFy, setSelectedFy] = useState<string>('all');
  const [selectedHeadId, setSelectedHeadId] = useState<string>('all');

  // Create/Edit Sanction Modal
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<BudgetSanctionEnriched | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  // Form fields
  const [budgetHeadId, setBudgetHeadId] = useState('');
  const [sanctionAmount, setSanctionAmount] = useState('');
  const [sanctionDate, setSanctionDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [sanctionOrderNo, setSanctionOrderNo] = useState('');
  const [sanctionedBy, setSanctionedBy] = useState('Technical Director RISL');
  const [notes, setNotes] = useState('');
  const [pendingPdf, setPendingPdf] = useState<PendingPdfDraft | null>(null);
  const [removeExistingPdf, setRemoveExistingPdf] = useState(false);

  // Camera Scanner State
  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [capturedPages, setCapturedPages] = useState<string[]>([]);
  const [buildingPdf, setBuildingPdf] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const pdfInputRef = useRef<HTMLInputElement | null>(null);
  const fallbackCameraInputRef = useRef<HTMLInputElement | null>(null);

  // Inline PDF Preview Modal
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewTitle, setPreviewTitle] = useState('');
  const [previewFileName, setPreviewFileName] = useState('sanction.pdf');
  const [previewBlobUrl, setPreviewBlobUrl] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  // Admin multi-select bulk delete & inline single delete confirm
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [approvingId, setApprovingId] = useState<string | null>(null);

  useEffect(() => {
    const valid = new Set(sanctions.map((s) => s.id));
    setSelectedIds((prev) => prev.filter((id) => valid.has(id)));
  }, [sanctions]);

  // Auto-calculated Indian Financial Year based on sanctionDate
  const autoFinancialYear = useMemo(
    () => computeFinancialYear(sanctionDate),
    [sanctionDate]
  );

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
      if (previewBlobUrl) URL.revokeObjectURL(previewBlobUrl);
    };
  }, [previewBlobUrl]);

  useEffect(() => {
    if (externalOpenCreate) {
      openCreate(preselectedHeadId || undefined);
      onConsumeExternalCreate?.();
    }
  }, [externalOpenCreate, preselectedHeadId]);

  const openCreate = (headOverride?: string) => {
    const today = new Date().toISOString().slice(0, 10);
    const fy = computeFinancialYear(today);
    setEditing(null);
    setBudgetHeadId(headOverride || budgetHeads[0]?.id || '');
    setSanctionAmount('');
    setSanctionDate(today);
    setSanctionOrderNo(`SO/${fy.replace('FY ', '')}/${Math.floor(100 + Math.random() * 900)}`);
    setSanctionedBy('Technical Director RISL');
    setNotes('');
    setPendingPdf(null);
    setRemoveExistingPdf(false);
    setFormError(null);
    setCameraOpen(false);
    setCapturedPages([]);
    setCameraError(null);
    setModalOpen(true);
  };

  const openEdit = (sanction: BudgetSanctionEnriched) => {
    setEditing(sanction);
    setBudgetHeadId(sanction.budgetHeadId);
    setSanctionAmount(String(sanction.sanctionAmount));
    setSanctionDate(sanction.sanctionDate);
    setSanctionOrderNo(sanction.sanctionOrderNo);
    setSanctionedBy(sanction.sanctionedBy);
    setNotes(sanction.notes);
    setPendingPdf(null);
    setRemoveExistingPdf(false);
    setFormError(null);
    setCameraOpen(false);
    setCapturedPages([]);
    setCameraError(null);
    setModalOpen(true);
  };

  const closeModal = () => {
    stopCameraStream();
    setCameraOpen(false);
    setModalOpen(false);
  };

  // Attach an existing PDF file
  const handlePdfFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
      setFormError('Please select a valid PDF (.pdf) file.');
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      setFormError('PDF file must be 8 MB or smaller.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      if (!result) {
        setFormError('Unable to read the selected PDF file.');
        return;
      }
      setFormError(null);
      setRemoveExistingPdf(false);
      setPendingPdf({
        base64: result,
        fileName: file.name,
        sizeBytes: file.size,
        source: 'pdf-upload',
      });
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  // Start Live Camera Viewfinder
  const startCamera = async () => {
    setCameraError(null);
    setCapturedPages([]);
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setCameraError(
        'Live camera preview is unavailable in this browser. Use "Capture Photo" below to scan from your device camera.'
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
        'Camera permission was denied or no live camera was detected. You can still use "Capture Photo" below to scan a sanction page.'
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

  // Fallback native mobile camera / photo capture input -> append to scanned pages
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

  // Convert 1 or more scanned pages into a real A4 PDF using jsPDF
  const convertCapturedPagesToPdf = async () => {
    if (capturedPages.length === 0) return;
    setBuildingPdf(true);
    setFormError(null);
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
      const safeOrder = (sanctionOrderNo || `sanction-${sanctionDate}`).replace(/[^a-zA-Z0-9-_]/g, '_');

      setPendingPdf({
        base64: dataUri,
        fileName: `${safeOrder}_scan.pdf`,
        sizeBytes: approxBytes,
        source: 'camera-scan',
      });
      setRemoveExistingPdf(false);
      stopCameraStream();
      setCameraOpen(false);
      setCapturedPages([]);
    } catch {
      setFormError('Could not generate PDF from scanned pages. Please try again.');
    } finally {
      setBuildingPdf(false);
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    const amountNum = Number(sanctionAmount);
    if (!budgetHeadId) {
      setFormError('Select a budget head first.');
      return;
    }
    if (!Number.isFinite(amountNum) || amountNum <= 0) {
      setFormError('Enter a sanction amount greater than ₹0.');
      return;
    }

    setSubmitting(true);
    try {
      if (editing) {
        await api.updateSanction(editing.id, {
          budgetHeadId,
          sanctionAmount: amountNum,
          sanctionDate,
          sanctionOrderNo: sanctionOrderNo.trim(),
          sanctionedBy: sanctionedBy.trim() || 'Technical Director RISL',
          notes: notes.trim(),
          removeAttachment: removeExistingPdf && !pendingPdf,
          ...(pendingPdf
            ? {
                attachmentBase64: pendingPdf.base64,
                attachmentName: pendingPdf.fileName,
                attachmentSource: pendingPdf.source,
              }
            : {}),
        });
        setFeedback(`Updated budget sanction (${autoFinancialYear}).`);
      } else {
        await api.createSanction({
          budgetHeadId,
          sanctionAmount: amountNum,
          sanctionDate,
          sanctionOrderNo: sanctionOrderNo.trim(),
          sanctionedBy: sanctionedBy.trim() || 'Technical Director RISL',
          notes: notes.trim(),
          ...(pendingPdf
            ? {
                attachmentBase64: pendingPdf.base64,
                attachmentName: pendingPdf.fileName,
                attachmentSource: pendingPdf.source,
              }
            : {}),
        });
        setFeedback(
          isAdmin
            ? `Sanction recorded under ${autoFinancialYear}.`
            : `Sanction submitted for Administrator approval under ${autoFinancialYear}. It will be added to the main budget totals and ledger once approved.`
        );
      }
      await onRefresh();
      closeModal();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Unable to save budget sanction.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleApprovalChange = async (
    sanction: BudgetSanctionEnriched,
    approvalStatus: 'approved' | 'rejected'
  ) => {
    setApprovingId(sanction.id);
    try {
      await api.updateSanction(sanction.id, { approvalStatus });
      setFeedback(
        approvalStatus === 'approved'
          ? `Approved sanction ${sanction.sanctionOrderNo}. Amount added to main budget and ledger.`
          : `Rejected sanction submission ${sanction.sanctionOrderNo}.`
      );
      await onRefresh();
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : 'Failed to update approval status.');
    } finally {
      setApprovingId(null);
    }
  };

  const handleDelete = async (sanction: BudgetSanctionEnriched) => {
    try {
      await api.deleteSanction(sanction.id);
      setConfirmDeleteId(null);
      setSelectedIds((prev) => prev.filter((id) => id !== sanction.id));
      setFeedback(`Deleted sanction ${sanction.sanctionOrderNo} for ${sanction.budgetHeadName}.`);
      await onRefresh();
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : 'Failed to delete sanction.');
    }
  };

  const toggleSelect = (id: string) => {
    setConfirmBulkDelete(false);
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
    );
  };

  const handleBulkDelete = async () => {
    if (selectedIds.length === 0) return;
    setBulkDeleting(true);
    try {
      const res = await api.bulkDeleteSanctions(selectedIds);
      setFeedback(
        `Deleted ${res.deletedCount} budget ${res.deletedCount === 1 ? 'sanction' : 'sanctions'}.`
      );
      setSelectedIds([]);
      setConfirmBulkDelete(false);
      await onRefresh();
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : 'Bulk delete failed.');
    } finally {
      setBulkDeleting(false);
    }
  };

  const handleOpenPdfPreview = async (sanction: BudgetSanctionEnriched) => {
    if (!sanction.attachment) return;
    if (previewBlobUrl) {
      URL.revokeObjectURL(previewBlobUrl);
      setPreviewBlobUrl(null);
    }
    setPreviewTitle(`${sanction.sanctionOrderNo} — ${sanction.budgetHeadName}`);
    setPreviewFileName(sanction.attachment.fileName);
    setPreviewError(null);
    setPreviewLoading(true);
    setPreviewOpen(true);

    try {
      const blob = await api.fetchSanctionPdfBlob(sanction.id);
      const url = URL.createObjectURL(blob);
      setPreviewBlobUrl(url);
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : 'Failed to load PDF document.');
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleDirectDownloadPdf = async (sanction: BudgetSanctionEnriched) => {
    if (!sanction.attachment) return;
    try {
      const blob = await api.fetchSanctionPdfBlob(sanction.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = sanction.attachment.fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : 'Unable to download PDF.');
    }
  };

  const availableYears = useMemo(() => {
    const set = new Set<string>();
    sanctions.forEach((s) => set.add(s.financialYear));
    return Array.from(set).sort().reverse();
  }, [sanctions]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = sanctions.filter((s) => {
      if (selectedFy !== 'all' && s.financialYear !== selectedFy) return false;
      if (selectedHeadId !== 'all' && s.budgetHeadId !== selectedHeadId) return false;
      if (!q) return true;
      return (
        s.budgetHeadName.toLowerCase().includes(q) ||
        s.sanctionOrderNo.toLowerCase().includes(q) ||
        s.sanctionedBy.toLowerCase().includes(q) ||
        s.financialYear.toLowerCase().includes(q) ||
        s.notes.toLowerCase().includes(q)
      );
    });
    // Sort pending submissions to the top so admins and submitters see them immediately
    return [...list].sort((a, b) => {
      const aPending = a.approvalStatus === 'pending' ? 0 : 1;
      const bPending = b.approvalStatus === 'pending' ? 0 : 1;
      if (aPending !== bPending) return aPending - bPending;
      return b.sanctionDate.localeCompare(a.sanctionDate);
    });
  }, [sanctions, selectedFy, selectedHeadId, search]);

  const approvedFiltered = useMemo(
    () => filtered.filter((s) => s.approvalStatus === 'approved'),
    [filtered]
  );
  const pendingCount = useMemo(
    () => sanctions.filter((s) => s.approvalStatus === 'pending').length,
    [sanctions]
  );
  const totalSanctioned = approvedFiltered.reduce((sum, s) => sum + s.sanctionAmount, 0);
  const attachedDocsCount = filtered.filter((s) => Boolean(s.attachment)).length;
  const distinctHeads = new Set(approvedFiltered.map((s) => s.budgetHeadId)).size;

  const allFilteredSelected =
    filtered.length > 0 && filtered.every((s) => selectedIds.includes(s.id));

  const toggleSelectAllFiltered = () => {
    setConfirmBulkDelete(false);
    if (allFilteredSelected) {
      const filteredSet = new Set(filtered.map((s) => s.id));
      setSelectedIds((prev) => prev.filter((id) => !filteredSet.has(id)));
    } else {
      const merged = new Set([...selectedIds, ...filtered.map((s) => s.id)]);
      setSelectedIds(Array.from(merged));
    }
  };

  return (
    <div className="space-y-6">
      {/* KPI Strip */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-white border border-slate-200 rounded-2xl p-5">
          <p className="text-xs font-medium text-slate-500">Approved Sanctioned Amount</p>
          <p className="mt-1.5 font-mono tabular-nums text-2xl font-semibold text-teal-800">
            {formatCurrency(totalSanctioned)}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            {approvedFiltered.length} approved {approvedFiltered.length === 1 ? 'order' : 'orders'}
            {selectedFy !== 'all' ? ` in ${selectedFy}` : ' across all years'}
          </p>
        </div>

        <div className="bg-white border border-slate-200 rounded-2xl p-5">
          <p className="text-xs font-medium text-slate-500">Funded Budget Heads</p>
          <p className="mt-1.5 font-mono tabular-nums text-2xl font-semibold text-slate-900">
            {distinctHeads} / {budgetHeads.length}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            Heads with approved sanction entries
          </p>
        </div>

        <div className="bg-white border border-slate-200 rounded-2xl p-5">
          <p className="text-xs font-medium text-slate-500">Sanction Order PDFs</p>
          <p className="mt-1.5 font-mono tabular-nums text-2xl font-semibold text-slate-900">
            {attachedDocsCount}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            Uploaded or camera-scanned PDF attachments
          </p>
        </div>
      </div>

      {pendingCount > 0 && (
        <div className="px-4 py-3 rounded-xl bg-amber-50 border border-amber-200 text-xs sm:text-sm text-amber-900">
          {isAdmin ? (
            <>
              <span className="font-semibold">
                {pendingCount} user sanction {pendingCount === 1 ? 'entry is' : 'entries are'} awaiting your approval.
              </span>{' '}
              Review and click <span className="font-semibold">Approve</span> to add them to main budget totals and the ledger.
            </>
          ) : (
            <>
              <span className="font-semibold">
                {pendingCount} submitted sanction {pendingCount === 1 ? 'entry is' : 'entries are'} pending Admin approval.
              </span>{' '}
              Pending submissions are excluded from budget totals and the passbook until approved by an Administrator.
            </>
          )}
        </div>
      )}

      {feedback && (
        <div className="px-4 py-3 rounded-xl bg-slate-900 text-white text-xs sm:text-sm flex items-center justify-between gap-3">
          <span>{feedback}</span>
          <button
            type="button"
            onClick={() => setFeedback(null)}
            className="text-slate-300 hover:text-white text-xs font-medium px-2 py-1 cursor-pointer"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Search, Financial Year Filter, Budget Head Filter & Actions */}
      <div className="bg-white border border-slate-200 rounded-2xl p-4 space-y-3">
        <div className="flex flex-col lg:flex-row lg:items-center gap-3">
          <div className="relative flex-1">
            <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search budget head, sanction order no, authority, or notes..."
              className="w-full h-11 pl-10 pr-4 rounded-xl border border-slate-200 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-teal-700"
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <select
              aria-label="Filter by budget head"
              value={selectedHeadId}
              onChange={(e) => setSelectedHeadId(e.target.value)}
              className="h-11 px-3 rounded-xl border border-slate-200 bg-white text-xs font-medium text-slate-700 focus:outline-none focus:border-teal-700"
            >
              <option value="all">All Budget Heads</option>
              {budgetHeads.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.name}
                </option>
              ))}
            </select>

            {isAdmin && (
              <button
                type="button"
                onClick={onOpenImport}
                className="min-h-[44px] px-3.5 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 text-slate-800 text-xs font-semibold inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
              >
                <FileSpreadsheet className="w-4 h-4 text-teal-700" />
                <span>Import Excel</span>
              </button>
            )}
            <button
              type="button"
              onClick={() => openCreate()}
              disabled={budgetHeads.length === 0}
              className="min-h-[44px] px-4 rounded-xl bg-teal-700 hover:bg-teal-800 disabled:opacity-50 text-white text-xs font-semibold inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
            >
              <Plus className="w-4 h-4" />
              <span>{isAdmin ? 'Enter Sanction Amount' : 'Submit Sanction Entry'}</span>
            </button>
          </div>
        </div>

        {/* Financial Year Filter Bar */}
        <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-slate-100">
          <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-xl overflow-x-auto">
            <button
              type="button"
              onClick={() => setSelectedFy('all')}
              className={`px-3 min-h-[34px] text-xs font-medium rounded-lg whitespace-nowrap shrink-0 cursor-pointer transition-colors ${
                selectedFy === 'all'
                  ? 'bg-white text-slate-900 shadow-xs font-semibold'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              All Financial Years
            </button>
            {availableYears.map((fy) => (
              <button
                key={fy}
                type="button"
                onClick={() => setSelectedFy(fy)}
                className={`px-3 min-h-[34px] text-xs font-medium rounded-lg whitespace-nowrap shrink-0 cursor-pointer transition-colors ${
                  selectedFy === fy
                    ? 'bg-white text-slate-900 shadow-xs font-semibold'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {fy}
              </button>
            ))}
          </div>

          <p className="text-xs text-slate-500">
            Financial year automatically derived from sanction date (Apr – Mar)
          </p>
        </div>
      </div>

      {/* Admin Multi-Select Bulk Delete Bar */}
      {isAdmin && filtered.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 rounded-xl bg-white border border-slate-200">
          <label className="inline-flex items-center gap-2.5 text-xs font-medium text-slate-700 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={allFilteredSelected}
              onChange={toggleSelectAllFiltered}
              className="w-4 h-4 rounded border-slate-300 text-teal-700 focus:ring-teal-700 cursor-pointer"
            />
            <span>
              Select All ({filtered.length})
              {selectedIds.length > 0 ? ` · ${selectedIds.length} selected` : ''}
            </span>
          </label>

          {selectedIds.length > 0 && (
            <div className="flex items-center gap-2">
              {confirmBulkDelete ? (
                <>
                  <button
                    type="button"
                    disabled={bulkDeleting}
                    onClick={handleBulkDelete}
                    className="min-h-[34px] px-3 rounded-lg bg-red-700 hover:bg-red-800 disabled:opacity-60 text-white text-xs font-semibold cursor-pointer"
                  >
                    {bulkDeleting ? 'Deleting...' : `Confirm Delete (${selectedIds.length})`}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmBulkDelete(false)}
                    className="min-h-[34px] px-2.5 rounded-lg border border-slate-200 text-xs font-medium text-slate-600 hover:text-slate-900 cursor-pointer"
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmBulkDelete(true)}
                  className="min-h-[34px] px-3 rounded-lg bg-red-50 border border-red-200 hover:bg-red-100 text-red-700 text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>Delete Selected ({selectedIds.length})</span>
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* Sanctions List */}
      {filtered.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-2xl p-10 text-center">
          <p className="text-sm font-semibold text-slate-800">No budget sanctions recorded yet</p>
          <p className="text-xs text-slate-500 mt-1">
            {budgetHeads.length === 0
              ? 'An administrator must create at least one budget head before sanction entries can be submitted.'
              : isAdmin
                ? 'Enter a sanction amount for any budget head and attach or camera-scan the sanction order PDF.'
                : 'Submit a sanction entry for Administrator review and approval.'}
          </p>
          {budgetHeads.length > 0 && (
            <button
              type="button"
              onClick={() => openCreate()}
              className="mt-4 px-4 py-2.5 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded-xl cursor-pointer"
            >
              {isAdmin ? 'Enter First Sanction' : 'Submit Sanction Entry'}
            </button>
          )}
        </div>
      ) : (
        <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden divide-y divide-slate-100">
          {filtered.map((s) => {
            const isSelected = selectedIds.includes(s.id);
            const isConfirmingDelete = confirmDeleteId === s.id;
            const isPending = s.approvalStatus === 'pending';
            const isRejected = s.approvalStatus === 'rejected';

            return (
              <div
                key={s.id}
                className={`p-5 transition-colors flex flex-col lg:flex-row lg:items-center justify-between gap-4 ${
                  isPending
                    ? 'bg-amber-50/40 hover:bg-amber-50/70'
                    : isRejected
                      ? 'bg-red-50/30 hover:bg-red-50/50'
                      : 'hover:bg-slate-50/60'
                }`}
              >
                <div className="flex items-start gap-3 min-w-0 flex-1">
                  {isAdmin && (
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggleSelect(s.id)}
                      aria-label={`Select sanction ${s.sanctionOrderNo}`}
                      className="mt-1 w-4 h-4 rounded border-slate-300 text-teal-700 focus:ring-teal-700 cursor-pointer shrink-0"
                    />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                      <span
                        className="w-2.5 h-2.5 rounded-xs shrink-0"
                        style={{ backgroundColor: s.budgetHeadColor }}
                        aria-hidden="true"
                      />
                      <span className="font-mono font-semibold text-teal-800">{s.financialYear}</span>
                      <span aria-hidden="true">·</span>
                      <span className="font-mono text-slate-700">{s.sanctionOrderNo}</span>
                      <span aria-hidden="true">·</span>
                      <span>{formatShortDate(s.sanctionDate)}</span>
                      {isPending && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="inline-flex items-center gap-1 font-semibold text-amber-800">
                            <Clock className="w-3 h-3" />
                            Pending Admin Approval
                          </span>
                        </>
                      )}
                      {isRejected && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="font-semibold text-red-700">Rejected</span>
                        </>
                      )}
                    </div>

                    <h3 className="mt-1 text-base font-semibold text-slate-900">
                      {s.budgetHeadName}
                    </h3>

                    <p className="text-xs text-slate-500 mt-0.5">
                      Sanctioned by {s.sanctionedBy}
                      {s.notes ? ` · ${s.notes}` : ''}
                    </p>

                    {s.attachment && (
                      <div className="mt-2.5 flex flex-wrap items-center gap-3 text-xs">
                        <span className="inline-flex items-center gap-1.5 text-slate-700 font-medium">
                          <FileText className="w-3.5 h-3.5 text-teal-700" />
                          <span className="truncate max-w-[220px]">{s.attachment.fileName}</span>
                        </span>
                        <span className="text-slate-400">
                          {formatFileSize(s.attachment.sizeBytes)} ·{' '}
                          {s.attachment.source === 'camera-scan' ? 'Camera Scan PDF' : 'Uploaded PDF'}
                        </span>
                      </div>
                    )}
                  </div>
                </div>

                <div className="flex flex-wrap sm:flex-nowrap items-center justify-between lg:justify-end gap-4 shrink-0">
                  <div className="text-left sm:text-right">
                    <p className="text-xs text-slate-400">
                      {isPending ? 'Submitted Amount' : 'Sanction Amount'}
                    </p>
                    <p
                      className={`font-mono tabular-nums text-lg font-semibold mt-0.5 ${
                        isRejected ? 'text-slate-400 line-through' : 'text-slate-900'
                      }`}
                    >
                      {formatCurrency(s.sanctionAmount)}
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-1.5">
                    {isAdmin && s.approvalStatus !== 'approved' && (
                      <button
                        type="button"
                        disabled={approvingId === s.id}
                        onClick={() => handleApprovalChange(s, 'approved')}
                        className="min-h-[40px] px-3 rounded-xl bg-emerald-700 hover:bg-emerald-800 disabled:opacity-60 text-white text-xs font-semibold inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
                      >
                        <Check className="w-3.5 h-3.5" />
                        <span>Approve</span>
                      </button>
                    )}
                    {isAdmin && isPending && (
                      <button
                        type="button"
                        disabled={approvingId === s.id}
                        onClick={() => handleApprovalChange(s, 'rejected')}
                        className="min-h-[40px] px-3 rounded-xl border border-red-200 bg-white hover:bg-red-50 disabled:opacity-60 text-red-700 text-xs font-semibold inline-flex items-center gap-1 whitespace-nowrap cursor-pointer"
                      >
                        <X className="w-3.5 h-3.5" />
                        <span>Reject</span>
                      </button>
                    )}

                    {s.attachment && (
                      <>
                        <button
                          type="button"
                          onClick={() => handleOpenPdfPreview(s)}
                          className="min-h-[40px] px-3 rounded-xl border border-slate-200 hover:bg-slate-100 text-xs font-medium text-slate-700 inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
                        >
                          <Eye className="w-3.5 h-3.5 text-teal-700" />
                          <span>View PDF</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDirectDownloadPdf(s)}
                          aria-label={`Download PDF for ${s.sanctionOrderNo}`}
                          className="min-w-[40px] min-h-[40px] flex items-center justify-center rounded-xl border border-slate-200 text-slate-600 hover:text-slate-900 hover:bg-slate-100 cursor-pointer"
                        >
                          <Download className="w-4 h-4" />
                        </button>
                      </>
                    )}
                    {isAdmin && (
                      <>
                        <button
                          type="button"
                          onClick={() => openEdit(s)}
                          aria-label={`Edit sanction ${s.sanctionOrderNo}`}
                          className="min-w-[40px] min-h-[40px] flex items-center justify-center rounded-xl border border-slate-200 text-slate-600 hover:text-slate-900 hover:bg-slate-100 cursor-pointer"
                        >
                          <Pencil className="w-4 h-4" />
                        </button>
                        {isConfirmingDelete ? (
                          <div className="inline-flex items-center gap-1 bg-red-50 border border-red-200 rounded-xl px-2 py-1">
                            <button
                              type="button"
                              onClick={() => handleDelete(s)}
                              className="px-2 py-1 rounded-lg bg-red-700 text-white text-xs font-semibold cursor-pointer"
                            >
                              Delete
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmDeleteId(null)}
                              className="px-2 py-1 rounded-lg text-xs text-slate-600 cursor-pointer"
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteId(s.id)}
                            aria-label={`Delete sanction ${s.sanctionOrderNo}`}
                            className="min-w-[40px] min-h-[40px] flex items-center justify-center rounded-xl border border-slate-200 text-slate-600 hover:text-red-700 hover:bg-red-50 cursor-pointer"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Enter / Edit Sanction Modal (Admins: Create & Edit; Standard Users: Submit for Approval) */}
      <BottomSheetModal
        open={modalOpen && (isAdmin || !editing)}
        onClose={closeModal}
        title={
          editing
            ? 'Edit Budget Sanction'
            : isAdmin
              ? 'Enter Budget Sanction Amount'
              : 'Submit Budget Sanction for Approval'
        }
        subtitle={
          isAdmin
            ? 'Financial year updates automatically from the sanction date. Attach or camera-scan the sanction PDF.'
            : 'Submit sanction details with PDF order. An Administrator must approve it before it is added to the main budget.'
        }
      >
        <form onSubmit={handleSave} className="space-y-4">
          {!isAdmin && (
            <div className="px-3.5 py-2.5 rounded-xl bg-amber-50 border border-amber-200 text-xs text-amber-900">
              Submitted sanction entries require Administrator approval before being added to the main budget totals and ledger.
            </div>
          )}
          {formError && (
            <div className="px-3.5 py-2.5 rounded-xl bg-red-50 border border-red-200 text-xs text-red-700">
              {formError}
            </div>
          )}

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1.5">Budget Head</label>
              <select
                required
                value={budgetHeadId}
                onChange={(e) => setBudgetHeadId(e.target.value)}
                className="w-full h-11 px-3 rounded-xl border border-slate-200 bg-white text-sm text-slate-900 focus:outline-none focus:border-teal-700"
              >
                {budgetHeads.map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.name} (Sanctioned so far: {formatCurrency(h.sanctionedTotal)})
                  </option>
                ))}
              </select>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1.5">
                  Sanction Amount (₹ INR)
                </label>
                <input
                  type="number"
                  step="0.01"
                  min="1"
                  required
                  value={sanctionAmount}
                  onChange={(e) => setSanctionAmount(e.target.value)}
                  placeholder="150000"
                  className="w-full h-11 px-3.5 rounded-xl border border-slate-200 font-mono tabular-nums text-sm text-slate-900 focus:outline-none focus:border-teal-700"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1.5">
                  Sanction Date
                </label>
                <input
                  type="date"
                  required
                  value={sanctionDate}
                  onChange={(e) => setSanctionDate(e.target.value)}
                  className="w-full h-11 px-3.5 rounded-xl border border-slate-200 font-mono text-sm text-slate-900 focus:outline-none focus:border-teal-700"
                />
              </div>
            </div>

            {/* Auto-Computed Financial Year Display */}
            <div className="px-3.5 py-3 rounded-xl bg-teal-50/70 border border-teal-200/80 flex items-center justify-between gap-3">
              <div>
                <p className="text-xs font-medium text-teal-900">
                  Financial Year (Auto-calculated from Sanction Date)
                </p>
                <p className="text-[11px] text-teal-700 mt-0.5">
                  {formatFinancialYearRange(autoFinancialYear)}
                </p>
              </div>
              <span className="font-mono text-sm font-semibold text-teal-900 shrink-0">
                {autoFinancialYear}
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1.5">
                  Sanction Order / Letter No
                </label>
                <input
                  type="text"
                  value={sanctionOrderNo}
                  onChange={(e) => setSanctionOrderNo(e.target.value)}
                  placeholder="SO/2026-27/INF-014"
                  className="w-full h-11 px-3.5 rounded-xl border border-slate-200 font-mono text-sm text-slate-900 focus:outline-none focus:border-teal-700"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1.5">
                  Sanctioning Authority
                </label>
                <input
                  type="text"
                  value={sanctionedBy}
                  onChange={(e) => setSanctionedBy(e.target.value)}
                  placeholder="Technical Director RISL"
                  className="w-full h-11 px-3.5 rounded-xl border border-slate-200 text-sm text-slate-900 focus:outline-none focus:border-teal-700"
                />
              </div>
            </div>

            {/* Sanction Document Section: Upload PDF OR Scan from Camera */}
            <div className="space-y-3 pt-1">
              <label className="block text-xs font-medium text-slate-700">
                Sanction Order PDF Document
              </label>

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

              <div className="grid grid-cols-2 gap-2.5">
                <button
                  type="button"
                  onClick={() => pdfInputRef.current?.click()}
                  className="min-h-[44px] px-3 rounded-xl border border-slate-200 hover:border-teal-700 hover:bg-teal-50/30 text-xs font-semibold text-slate-800 flex items-center justify-center gap-2 cursor-pointer transition-colors"
                >
                  <Upload className="w-4 h-4 text-teal-700 shrink-0" />
                  <span>Attach PDF File</span>
                </button>
                <button
                  type="button"
                  onClick={startCamera}
                  className="min-h-[44px] px-3 rounded-xl border border-slate-200 hover:border-teal-700 hover:bg-teal-50/30 text-xs font-semibold text-slate-800 flex items-center justify-center gap-2 cursor-pointer transition-colors"
                >
                  <Camera className="w-4 h-4 text-teal-700 shrink-0" />
                  <span>Scan from Camera</span>
                </button>
              </div>

              {/* Active Pending PDF Attachment Preview */}
              {pendingPdf && (
                <div className="p-3 rounded-xl bg-emerald-50 border border-emerald-200 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0" />
                    <div className="min-w-0">
                      <p className="text-xs font-semibold text-emerald-900 truncate">
                        {pendingPdf.fileName}
                      </p>
                      <p className="text-[11px] text-emerald-700">
                        {formatFileSize(pendingPdf.sizeBytes)} ·{' '}
                        {pendingPdf.source === 'camera-scan' ? 'Scanned to PDF' : 'Ready to upload'}
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setPendingPdf(null)}
                    aria-label="Remove attached PDF"
                    className="min-w-[34px] min-h-[34px] flex items-center justify-center rounded-lg text-emerald-800 hover:bg-emerald-100 cursor-pointer"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              )}

              {/* Existing Attachment Indicator when Editing */}
              {!pendingPdf && editing?.attachment && !removeExistingPdf && (
                <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <FileText className="w-4 h-4 text-teal-700 shrink-0" />
                    <div className="min-w-0">
                      <p className="text-xs font-medium text-slate-900 truncate">
                        {editing.attachment.fileName}
                      </p>
                      <p className="text-[11px] text-slate-500">
                        Currently attached · {formatFileSize(editing.attachment.sizeBytes)}
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setRemoveExistingPdf(true)}
                    className="text-xs font-medium text-red-700 hover:underline px-2 py-1 cursor-pointer shrink-0"
                  >
                    Remove
                  </button>
                </div>
              )}

              {/* Live Camera Document Scanner Panel */}
              {cameraOpen && (
                <div className="p-3.5 rounded-xl bg-slate-900 text-white space-y-3">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-semibold">Camera Document Scanner</p>
                    <button
                      type="button"
                      onClick={() => {
                        stopCameraStream();
                        setCameraOpen(false);
                      }}
                      className="text-xs text-slate-300 hover:text-white px-2 py-1 cursor-pointer"
                    >
                      Close Camera
                    </button>
                  </div>

                  {cameraError ? (
                    <div className="space-y-2.5">
                      <p className="text-xs text-amber-300 leading-relaxed">{cameraError}</p>
                      <button
                        type="button"
                        onClick={() => fallbackCameraInputRef.current?.click()}
                        className="w-full min-h-[42px] rounded-xl bg-teal-600 hover:bg-teal-500 text-xs font-semibold text-white flex items-center justify-center gap-2 cursor-pointer"
                      >
                        <Camera className="w-4 h-4" />
                        <span>Capture Photo / Choose Scan Image</span>
                      </button>
                    </div>
                  ) : (
                    <div className="space-y-2.5">
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
                          className="flex-1 min-h-[42px] rounded-xl bg-teal-600 hover:bg-teal-500 text-xs font-semibold text-white flex items-center justify-center gap-1.5 cursor-pointer"
                        >
                          <Camera className="w-4 h-4" />
                          <span>Capture Page ({capturedPages.length + 1})</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => fallbackCameraInputRef.current?.click()}
                          className="min-h-[42px] px-3 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-medium text-slate-200 cursor-pointer whitespace-nowrap"
                        >
                          Photo File
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Captured Scanned Pages Thumbnails */}
                  {capturedPages.length > 0 && (
                    <div className="pt-2 border-t border-white/10 space-y-2.5">
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
                          <div key={idx} className="relative shrink-0 w-16 h-20 rounded-md overflow-hidden border border-white/20">
                            <img
                              src={src}
                              alt={`Scanned page ${idx + 1}`}
                              className="w-full h-full object-cover"
                            />
                            <button
                              type="button"
                              onClick={() =>
                                setCapturedPages((prev) => prev.filter((_, i) => i !== idx))
                              }
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
                        className="w-full min-h-[42px] rounded-xl bg-white text-slate-900 hover:bg-slate-100 disabled:opacity-60 text-xs font-semibold cursor-pointer"
                      >
                        {buildingPdf
                          ? 'Generating PDF...'
                          : `Save ${capturedPages.length} ${capturedPages.length === 1 ? 'Page' : 'Pages'} as Sanction PDF`}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1.5">
                Sanction Remarks / Notes
              </label>
              <textarea
                rows={2}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Approved utilization scope, phase details, or conditions..."
                className="w-full px-3.5 py-2.5 rounded-xl border border-slate-200 text-sm text-slate-900 focus:outline-none focus:border-teal-700 resize-none"
              />
            </div>

            <div className="pt-2 flex items-center justify-end gap-2.5">
              <button
                type="button"
                onClick={closeModal}
                className="min-h-[44px] px-4 rounded-xl border border-slate-200 text-sm font-medium text-slate-700 hover:bg-slate-50 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={submitting}
                className="min-h-[44px] px-5 rounded-xl bg-teal-700 hover:bg-teal-800 disabled:opacity-60 text-white text-sm font-semibold cursor-pointer"
              >
                {submitting
                  ? 'Submitting...'
                  : editing
                    ? 'Save Sanction'
                    : isAdmin
                      ? 'Save Sanction Amount'
                      : 'Submit for Admin Approval'}
              </button>
            </div>
          </form>
        </BottomSheetModal>

      {/* Inline PDF Viewer Modal */}
      <BottomSheetModal
        open={previewOpen}
        onClose={() => {
          setPreviewOpen(false);
          if (previewBlobUrl) {
            URL.revokeObjectURL(previewBlobUrl);
            setPreviewBlobUrl(null);
          }
        }}
        title={previewTitle || 'Sanction Order PDF'}
        subtitle={previewFileName}
      >
        <div className="space-y-4">
          {previewLoading && (
            <div className="h-80 rounded-xl bg-slate-100 animate-pulse flex items-center justify-center text-xs text-slate-500">
              Loading PDF preview...
            </div>
          )}
          {previewError && (
            <div className="p-4 rounded-xl bg-red-50 border border-red-200 text-xs text-red-700">
              {previewError}
            </div>
          )}
          {previewBlobUrl && !previewLoading && (
            <>
              <iframe
                src={previewBlobUrl}
                title={previewTitle}
                className="w-full h-[55vh] rounded-xl border border-slate-200 bg-slate-50"
              />
              <div className="flex justify-end">
                <a
                  href={previewBlobUrl}
                  download={previewFileName}
                  className="min-h-[42px] px-4 rounded-xl bg-teal-700 hover:bg-teal-800 text-white text-xs font-semibold inline-flex items-center gap-1.5"
                >
                  <Download className="w-4 h-4" />
                  <span>Download PDF</span>
                </a>
              </div>
            </>
          )}
        </div>
      </BottomSheetModal>
    </div>
  );
}
