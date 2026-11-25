export function formatCurrency(value: number, compact = false): string {
  if (!Number.isFinite(value)) return '₹0.00';
  if (compact) {
    const abs = Math.abs(value);
    const sign = value < 0 ? '-' : '';
    if (abs >= 10000000) {
      return `${sign}₹${(abs / 10000000).toFixed(1).replace(/\.0$/, '')}Cr`;
    }
    if (abs >= 100000) {
      return `${sign}₹${(abs / 100000).toFixed(1).replace(/\.0$/, '')}L`;
    }
    if (abs >= 1000) {
      return `${sign}₹${(abs / 1000).toFixed(1).replace(/\.0$/, '')}k`;
    }
    return `${sign}₹${Math.round(abs)}`;
  }
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

export function formatAxisCurrency(value: number): string {
  if (!Number.isFinite(value)) return '₹0';
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (abs >= 10000000) {
    return `${sign}₹${(abs / 10000000).toFixed(1).replace(/\.0$/, '')}Cr`;
  }
  if (abs >= 100000) {
    return `${sign}₹${(abs / 100000).toFixed(1).replace(/\.0$/, '')}L`;
  }
  if (abs >= 1000) {
    return `${sign}₹${Math.round(abs / 1000)}k`;
  }
  return `${sign}₹${Math.round(abs)}`;
}

/**
 * Computes Indian Financial Year (April 1 – March 31) from a YYYY-MM-DD date string.
 * Example: 2026-04-01 -> "FY 2026-27", 2026-03-31 -> "FY 2025-26".
 */
export function computeFinancialYear(isoDate: string): string {
  const match = String(isoDate || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) {
    const now = new Date();
    const yr = now.getFullYear();
    const mo = now.getMonth() + 1;
    const startYear = mo >= 4 ? yr : yr - 1;
    return `FY ${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const startYear = month >= 4 ? year : year - 1;
  const endShort = String((startYear + 1) % 100).padStart(2, '0');
  return `FY ${startYear}-${endShort}`;
}

export function formatFinancialYearRange(fy: string): string {
  const match = fy.match(/FY\s+(\d{4})-(\d{2})/);
  if (!match) return fy;
  const startYear = Number(match[1]);
  return `Apr ${startYear} – Mar ${startYear + 1}`;
}

export function formatShortDate(isoDate: string): string {
  if (!isoDate) return '—';
  const parts = isoDate.slice(0, 10).split('-');
  if (parts.length !== 3) return isoDate;
  const dt = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  if (Number.isNaN(dt.getTime())) return isoDate;
  return new Intl.DateTimeFormat('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(dt);
}

export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB';
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function formatPct(pct: number): string {
  if (!Number.isFinite(pct)) return '0%';
  return `${pct.toFixed(1).replace(/\.0$/, '')}%`;
}

export function exportToCsv(filename: string, headers: string[], rows: Array<Array<string | number>>) {
  const escapeCell = (val: string | number) => {
    const str = String(val ?? '');
    if (/[",\n]/.test(str)) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const csvLines = [
    headers.map(escapeCell).join(','),
    ...rows.map((r) => r.map(escapeCell).join(',')),
  ];

  const blob = new Blob([csvLines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.setAttribute('download', filename);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
