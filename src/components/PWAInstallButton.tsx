import React, { useState } from 'react';
import { Check, Copy, Download, Share, Smartphone, WifiOff, X } from 'lucide-react';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import { usePWAInstall } from '../hooks/usePWAInstall';

interface PWAInstallButtonProps {
  variant?: 'sidebar' | 'mobile-sheet' | 'auth' | 'header';
  onAction?: () => void;
}

export function PWAInstallButton({ variant = 'sidebar', onAction }: PWAInstallButtonProps) {
  const { canInstallNative, isInstalled, isIOS, promptInstall } = usePWAInstall();
  const [guideOpen, setGuideOpen] = useState(false);
  const [copiedUrl, setCopiedUrl] = useState(false);

  if (isInstalled) return null;

  const appUrl =
    typeof window !== 'undefined' ? window.location.origin : '';

  const handleClick = async () => {
    if (canInstallNative) {
      const accepted = await promptInstall();
      if (accepted) {
        onAction?.();
        return;
      }
    }
    setGuideOpen(true);
  };

  const handleCopyUrl = async () => {
    if (!appUrl) return;
    try {
      await navigator.clipboard.writeText(appUrl);
      setCopiedUrl(true);
      window.setTimeout(() => setCopiedUrl(false), 2000);
    } catch {
      // Ignore clipboard permission denials in restricted frames
    }
  };

  let triggerButton: React.ReactNode;
  if (variant === 'mobile-sheet') {
    triggerButton = (
      <button
        type="button"
        onClick={handleClick}
        className="w-full min-h-[48px] px-4 rounded-xl border border-teal-200 bg-teal-50/70 hover:bg-teal-100/70 text-sm font-medium text-teal-900 flex items-center justify-between cursor-pointer"
      >
        <span className="inline-flex items-center gap-2.5">
          <Smartphone className="w-4 h-4 text-teal-700" />
          <span>Install Android / Mobile App</span>
        </span>
        <Download className="w-4 h-4 text-teal-700" />
      </button>
    );
  } else if (variant === 'header') {
    triggerButton = (
      <button
        type="button"
        onClick={handleClick}
        aria-label="Install App"
        className="inline-flex min-h-[40px] px-3 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 text-xs font-semibold items-center gap-1.5 transition-colors whitespace-nowrap cursor-pointer"
      >
        <Download className="w-3.5 h-3.5 text-teal-700" />
        <span className="hidden md:inline">Install App</span>
      </button>
    );
  } else if (variant === 'auth') {
    triggerButton = (
      <button
        type="button"
        onClick={handleClick}
        className="mt-4 w-full min-h-[42px] px-4 rounded-xl border border-white/15 bg-white/[0.06] hover:bg-white/[0.11] text-xs font-semibold text-slate-200 flex items-center justify-center gap-2 transition-colors cursor-pointer"
      >
        <Smartphone className="w-4 h-4 text-[#E5C675]" />
        <span>Install LedgerFlow on Android / Mobile</span>
      </button>
    );
  } else {
    triggerButton = (
      <button
        type="button"
        onClick={handleClick}
        className="w-full min-h-[42px] px-3.5 rounded-xl flex items-center gap-3 text-sm font-medium text-slate-200 bg-white/[0.05] border border-white/12 hover:bg-white/[0.10] hover:text-white transition-colors cursor-pointer whitespace-nowrap"
      >
        <Smartphone className="w-4 h-4 shrink-0 text-[#E5C675]" />
        <span className="truncate">Install Mobile App</span>
      </button>
    );
  }

  return (
    <>
      {triggerButton}

      {guideOpen && (
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-900/50 backdrop-blur-xs p-0 sm:p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="pwa-install-title"
          onClick={() => setGuideOpen(false)}
        >
          <div
            className="w-full sm:max-w-md bg-white rounded-t-2xl sm:rounded-2xl border border-slate-200 p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-teal-50 border border-teal-100 flex items-center justify-center shrink-0">
                  <Smartphone className="w-5 h-5 text-teal-700" />
                </div>
                <div>
                  <h3
                    id="pwa-install-title"
                    className="text-base font-semibold text-slate-900 tracking-tight"
                  >
                    Install LedgerFlow App
                  </h3>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Run fullscreen with a home-screen icon on Android &amp; iOS
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setGuideOpen(false)}
                aria-label="Close install instructions"
                className="min-w-[36px] min-h-[36px] rounded-lg flex items-center justify-center text-slate-400 hover:text-slate-700 hover:bg-slate-100 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="mt-5 space-y-4 text-xs sm:text-sm text-slate-700">
              {isIOS ? (
                <ol className="space-y-2.5 list-decimal list-inside">
                  <li>
                    Open this page in <strong>Safari</strong> on your iPhone or iPad.
                  </li>
                  <li className="inline-flex items-center gap-1 flex-wrap">
                    <span>Tap the</span>
                    <Share className="w-3.5 h-3.5 text-teal-700 inline" />
                    <strong>Share</strong>
                    <span>button at the bottom of Safari.</span>
                  </li>
                  <li>
                    Select <strong>Add to Home Screen</strong>, then tap <strong>Add</strong>.
                  </li>
                </ol>
              ) : (
                <ol className="space-y-2.5 list-decimal list-inside">
                  <li>
                    Open LedgerFlow directly in <strong>Google Chrome</strong> on your Android phone.
                  </li>
                  <li>
                    Tap the <strong>⋮ Menu</strong> button in the top-right corner of Chrome.
                  </li>
                  <li>
                    Tap <strong>Add to Home screen</strong> → <strong>Install app</strong>. Chrome
                    installs LedgerFlow as a native standalone Android app (WebAPK).
                  </li>
                </ol>
              )}

              {appUrl && (
                <div className="pt-3 border-t border-slate-100">
                  <p className="text-xs font-medium text-slate-500 mb-1.5">App URL</p>
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      readOnly
                      value={appUrl}
                      className="flex-1 min-w-0 h-10 px-3 rounded-xl border border-slate-200 bg-slate-50 font-mono text-xs text-slate-700 focus:outline-none"
                    />
                    <button
                      type="button"
                      onClick={handleCopyUrl}
                      className="h-10 px-3 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 text-xs font-semibold text-slate-700 inline-flex items-center gap-1.5 cursor-pointer shrink-0"
                    >
                      {copiedUrl ? (
                        <>
                          <Check className="w-3.5 h-3.5 text-teal-700" />
                          <span>Copied</span>
                        </>
                      ) : (
                        <>
                          <Copy className="w-3.5 h-3.5" />
                          <span>Copy</span>
                        </>
                      )}
                    </button>
                  </div>
                </div>
              )}
            </div>

            <div className="mt-5">
              <button
                type="button"
                onClick={() => setGuideOpen(false)}
                className="w-full h-11 rounded-xl bg-teal-700 hover:bg-teal-800 text-white text-sm font-semibold cursor-pointer"
              >
                Got it
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export function OfflineIndicator() {
  const isOnline = useOnlineStatus();
  if (isOnline) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-20 lg:bottom-4 left-1/2 -translate-x-1/2 z-50 bg-slate-900 text-white px-4 py-2 rounded-full text-xs font-medium shadow-lg flex items-center gap-2"
    >
      <WifiOff className="w-3.5 h-3.5 text-amber-400" />
      <span>You are offline. Reconnect to sync changes.</span>
    </div>
  );
}
