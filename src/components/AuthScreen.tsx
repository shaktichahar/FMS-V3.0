import React, { useEffect, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Clock,
  Eye,
  EyeOff,
  KeyRound,
  Lock,
  Mail,
  Phone,
  RefreshCw,
  User,
} from 'lucide-react';
import {
  api,
  isAndroidEmailOtpReady,
  isStandaloneAndroidRuntime,
  setSessionToken,
} from '../lib/api';
import type { OtpChallengeResponse, SafeUser } from '../types/finance';

const APP_VERSION = '2.0.0';

interface AuthScreenProps {
  onAuthenticated: (user: SafeUser, loginAt?: string) => void;
  sessionMessage?: string | null;
}

type AuthTab = 'login' | 'register';
type SignInMethod = 'password-otp' | 'direct-otp';

export function AuthScreen({ onAuthenticated, sessionMessage }: AuthScreenProps) {
  const isStandalonePasswordOnly = isStandaloneAndroidRuntime() && !isAndroidEmailOtpReady();
  const [mode, setMode] = useState<AuthTab>('login');
  const [signInMethod, setSignInMethod] = useState<SignInMethod>('password-otp');

  // Credentials / Registration fields
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [identifier, setIdentifier] = useState('');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [mobile, setMobile] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  // OTP Step state
  const [otpChallenge, setOtpChallenge] = useState<OtpChallengeResponse | null>(null);
  const [otpCode, setOtpCode] = useState('');
  const [expiresLeft, setExpiresLeft] = useState(0);
  const [resendLeft, setResendLeft] = useState(0);

  // Pending administrator approval confirmation state
  const [pendingApproval, setPendingApproval] = useState<{
    message: string;
    user: SafeUser;
  } | null>(null);

  const [loading, setLoading] = useState(false);
  const [resending, setResending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!otpChallenge) return;
    setExpiresLeft(otpChallenge.expiresInSeconds);
    setResendLeft(otpChallenge.resendCooldownSeconds);
  }, [otpChallenge]);

  useEffect(() => {
    if (!otpChallenge) return;
    const timer = window.setInterval(() => {
      setExpiresLeft((prev) => (prev > 0 ? prev - 1 : 0));
      setResendLeft((prev) => (prev > 0 ? prev - 1 : 0));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [otpChallenge]);

  const formatTimer = (sec: number) => {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  };

  const handlePrimarySubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setPendingApproval(null);
    setLoading(true);
    try {
      if (mode === 'login') {
        if (signInMethod === 'password-otp' || isStandalonePasswordOnly) {
          const res = await api.login(username.trim(), password);
          if (!res.otpRequired) {
            setSessionToken(res.token);
            onAuthenticated(res.user, res.loginAt);
            return;
          }
          setOtpChallenge(res);
          setOtpCode('');
        } else {
          const challenge = await api.requestDirectOtp(identifier.trim());
          setOtpChallenge(challenge);
          setOtpCode('');
        }
      } else {
        const res = await api.register({
          username: username.trim(),
          password,
          fullName: fullName.trim(),
          email: email.trim(),
          mobile: mobile.trim(),
        });
        if (!res.otpRequired) {
          setPendingApproval({ message: res.message, user: res.user });
          return;
        }
        setOtpChallenge(res);
        setOtpCode('');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to complete sign-in right now.');
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!otpChallenge) return;
    setError(null);
    setLoading(true);
    try {
      const res = await api.verifyLoginOtp(otpChallenge.challengeId, otpCode.trim());
      if (res.pendingApproval) {
        setSessionToken(null);
        setOtpChallenge(null);
        setOtpCode('');
        setPendingApproval({ message: res.message, user: res.user });
        return;
      }
      setSessionToken(res.token);
      onAuthenticated(res.user, res.loginAt);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid or expired OTP.');
    } finally {
      setLoading(false);
    }
  };

  const handleResendOtp = async () => {
    if (!otpChallenge || resendLeft > 0 || resending) return;
    setError(null);
    setResending(true);
    try {
      const refreshed = await api.resendLoginOtp(otpChallenge.challengeId);
      setOtpChallenge(refreshed);
      setOtpCode('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to resend OTP right now.');
    } finally {
      setResending(false);
    }
  };

  const isRegisterOtp = otpChallenge?.purpose === 'register';

  return (
    <div className="min-h-screen bg-[#0B1220] relative overflow-hidden flex items-center justify-center px-5 py-8 sm:px-8">
      {/* Subtle Architectural Radial Luminance */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,_rgba(59,91,219,0.22),_transparent_60%),radial-gradient(ellipse_at_bottom_right,_rgba(200,162,74,0.12),_transparent_50%)]"
      />

      <div className="relative z-10 w-full max-w-md">
        <div className="bg-white border border-slate-200/90 rounded-2xl shadow-[0_24px_64px_-20px_rgba(0,0,0,0.45)] p-6 sm:p-8">
          {pendingApproval ? (
            <div>
              <div className="w-12 h-12 rounded-2xl bg-amber-50 border border-amber-200 flex items-center justify-center mb-4">
                <Clock className="w-6 h-6 text-amber-700" />
              </div>

              <h2 className="text-xl font-semibold text-slate-900 tracking-tight">
                Awaiting Administrator Approval
              </h2>
              <p className="text-sm text-slate-600 mt-2 leading-relaxed">
                {pendingApproval.message}
              </p>

              <div className="mt-5 p-3.5 rounded-xl bg-slate-50 border border-slate-200 space-y-2 text-xs text-slate-700">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-slate-500">Account</span>
                  <span className="font-medium text-slate-900 truncate">
                    {pendingApproval.user.fullName}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-slate-500">Registered Email</span>
                  <span className="font-mono font-medium text-slate-900 truncate">
                    {pendingApproval.user.email}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2 pt-1.5 border-t border-slate-200/80">
                  <span className="text-slate-500">Status</span>
                  <span className="font-semibold text-amber-700">Pending Approval</span>
                </div>
              </div>

              <button
                type="button"
                onClick={() => {
                  setPendingApproval(null);
                  setMode('login');
                  setUsername(pendingApproval.user.email || pendingApproval.user.username);
                  setPassword('');
                  setError(null);
                }}
                className="mt-6 w-full h-11 rounded-xl bg-teal-700 hover:bg-teal-800 text-white text-sm font-semibold flex items-center justify-center gap-2 transition-colors cursor-pointer"
              >
                <ArrowLeft className="w-4 h-4" />
                <span>Back to Sign In</span>
              </button>
            </div>
          ) : otpChallenge ? (
            <div>
              <button
                type="button"
                onClick={() => {
                  setOtpChallenge(null);
                  setOtpCode('');
                  setError(null);
                }}
                className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-500 hover:text-slate-900 mb-5 cursor-pointer"
              >
                <ArrowLeft className="w-3.5 h-3.5" />
                <span>{isRegisterOtp ? 'Back to registration' : 'Back to sign in'}</span>
              </button>

              <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-10 rounded-xl bg-teal-50 border border-teal-100 flex items-center justify-center shrink-0">
                  <KeyRound className="w-5 h-5 text-teal-700" />
                </div>
                <div>
                  <h2 className="text-xl font-semibold text-slate-900 tracking-tight">
                    {isRegisterOtp ? 'Verify Registered Email' : 'Verify Login OTP'}
                  </h2>
                  <p className="text-xs text-slate-500 mt-0.5">
                    {isRegisterOtp
                      ? 'Enter the 6-digit verification code sent to your registered email address.'
                      : 'Enter the 6-digit verification code sent to your registered contacts.'}
                  </p>
                </div>
              </div>

              {/* Delivery Channels Summary */}
              <div className="mb-5 p-3.5 rounded-xl bg-slate-50 border border-slate-200 space-y-2 text-xs text-slate-700">
                {otpChallenge.maskedEmail && (
                  <div className="flex items-center justify-between gap-2">
                    <span className="inline-flex items-center gap-1.5 text-slate-500">
                      <Mail className="w-3.5 h-3.5 text-teal-700" />
                      <span>Registered Email</span>
                    </span>
                    <span className="font-mono font-medium text-slate-900 truncate">
                      {otpChallenge.maskedEmail}
                    </span>
                  </div>
                )}
                {otpChallenge.maskedMobile && (
                  <div className="flex items-center justify-between gap-2">
                    <span className="inline-flex items-center gap-1.5 text-slate-500">
                      <Phone className="w-3.5 h-3.5 text-teal-700" />
                      <span>Registered Mobile</span>
                    </span>
                    <span className="font-mono font-medium text-slate-900">
                      {otpChallenge.maskedMobile}
                    </span>
                  </div>
                )}
                <p className="pt-1.5 border-t border-slate-200/80 text-[11px] text-slate-500 leading-relaxed">
                  {otpChallenge.delivery.notice}
                </p>
              </div>

              {error && (
                <div
                  role="alert"
                  className="mb-4 px-3.5 py-3 rounded-xl bg-red-50 border border-red-200 text-xs sm:text-sm text-red-700"
                >
                  {error}
                </div>
              )}

              <form onSubmit={handleVerifyOtp} className="space-y-4">
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label htmlFor="auth-otp" className="text-xs font-medium text-slate-700">
                      6-Digit OTP
                    </label>
                    <span className="font-mono tabular-nums text-xs text-slate-500">
                      {expiresLeft > 0 ? `Expires in ${formatTimer(expiresLeft)}` : 'OTP expired'}
                    </span>
                  </div>
                  <input
                    id="auth-otp"
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    required
                    maxLength={6}
                    value={otpCode}
                    onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    placeholder="••••••"
                    className="w-full h-12 px-4 rounded-xl border border-slate-200 bg-white font-mono tabular-nums text-center text-xl font-semibold tracking-[0.45em] text-slate-900 placeholder:text-slate-300 focus:outline-none focus:border-teal-700 focus:ring-2 focus:ring-teal-700/15"
                  />
                </div>

                <button
                  type="submit"
                  disabled={loading || otpCode.length !== 6 || expiresLeft === 0}
                  className="w-full h-12 rounded-xl bg-teal-700 hover:bg-teal-800 active:scale-[0.99] disabled:opacity-60 text-white text-sm font-semibold flex items-center justify-center gap-2 transition-all cursor-pointer"
                >
                  <span>
                    {loading
                      ? 'Verifying OTP...'
                      : isRegisterOtp
                        ? 'Verify Email OTP'
                        : 'Verify & Sign In'}
                  </span>
                  {!loading && <ArrowRight className="w-4 h-4" />}
                </button>

                <div className="flex items-center justify-between pt-1 text-xs">
                  <span className="text-slate-500">Didn&apos;t receive the code?</span>
                  <button
                    type="button"
                    disabled={resendLeft > 0 || resending}
                    onClick={handleResendOtp}
                    className="inline-flex items-center gap-1.5 font-semibold text-teal-700 hover:text-teal-800 disabled:text-slate-400 cursor-pointer disabled:cursor-not-allowed"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${resending ? 'animate-spin' : ''}`} />
                    <span>
                      {resending
                        ? 'Resending...'
                        : resendLeft > 0
                          ? `Resend in ${resendLeft}s`
                          : 'Resend OTP'}
                    </span>
                  </button>
                </div>
              </form>
            </div>
          ) : (
            <div>
              {/* Mode Switcher */}
              <div className="grid grid-cols-2 p-1 bg-slate-100 rounded-xl mb-6">
                <button
                  type="button"
                  onClick={() => {
                    setMode('login');
                    setError(null);
                  }}
                  className={`min-h-[40px] text-sm font-medium rounded-lg transition-colors whitespace-nowrap cursor-pointer ${
                    mode === 'login'
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  Sign In
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setMode('register');
                    setError(null);
                  }}
                  className={`min-h-[40px] text-sm font-medium rounded-lg transition-colors whitespace-nowrap cursor-pointer ${
                    mode === 'register'
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  Create Account
                </button>
              </div>

              <div className="mb-5">
                <h2 className="text-xl font-semibold text-slate-900 tracking-tight">
                  {mode === 'login' ? 'Sign in to your account' : 'Create user account'}
                </h2>
                <p className="text-sm text-slate-500 mt-1">
                  {mode === 'login'
                    ? isStandalonePasswordOnly
                      ? 'Sign in with your registered email, username, and password.'
                      : 'An OTP will be sent to your registered email to verify your sign-in.'
                    : isStandalonePasswordOnly
                      ? 'Create your account. Administrator approval is required before signing in.'
                      : 'An OTP will be sent to your registered email. Administrator approval is required before signing in.'}
                </p>
              </div>

              {mode === 'login' && !isStandalonePasswordOnly && (
                <div className="flex items-center gap-2 mb-5">
                  <button
                    type="button"
                    onClick={() => {
                      setSignInMethod('password-otp');
                      setError(null);
                    }}
                    className={`flex-1 min-h-[38px] px-3 rounded-xl border text-xs font-medium transition-colors cursor-pointer ${
                      signInMethod === 'password-otp'
                        ? 'border-teal-700 bg-teal-50 text-teal-900'
                        : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                    }`}
                  >
                    Password + OTP
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setSignInMethod('direct-otp');
                      setError(null);
                    }}
                    className={`flex-1 min-h-[38px] px-3 rounded-xl border text-xs font-medium transition-colors cursor-pointer ${
                      signInMethod === 'direct-otp'
                        ? 'border-teal-700 bg-teal-50 text-teal-900'
                        : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                    }`}
                  >
                    Mobile / Email OTP
                  </button>
                </div>
              )}

              {sessionMessage && !error && (
                <div
                  role="status"
                  className="mb-5 px-3.5 py-3 rounded-xl bg-amber-50 border border-amber-200 text-xs sm:text-sm text-amber-900 flex items-center gap-2"
                >
                  <Clock className="w-4 h-4 text-amber-700 shrink-0" />
                  <span>{sessionMessage}</span>
                </div>
              )}

              {error && (
                <div
                  role="alert"
                  className="mb-5 px-3.5 py-3 rounded-xl bg-red-50 border border-red-200 text-xs sm:text-sm text-red-700"
                >
                  {error}
                </div>
              )}

              <form onSubmit={handlePrimarySubmit} className="space-y-4">
                {mode === 'register' && (
                  <>
                    <div>
                      <label
                        htmlFor="auth-fullname"
                        className="block text-xs font-medium text-slate-700 mb-1.5"
                      >
                        Full Name
                      </label>
                      <input
                        id="auth-fullname"
                        type="text"
                        required
                        value={fullName}
                        onChange={(e) => setFullName(e.target.value)}
                        placeholder="Rajesh Sharma"
                        className="w-full h-11 px-3.5 rounded-xl border border-slate-200 bg-white text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-teal-700 focus:ring-2 focus:ring-teal-700/15"
                      />
                    </div>

                    <div>
                      <label
                        htmlFor="auth-email"
                        className="block text-xs font-medium text-slate-700 mb-1.5"
                      >
                        Registered Email (for OTP)
                      </label>
                      <div className="relative">
                        <Mail className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                        <input
                          id="auth-email"
                          type="email"
                          required
                          autoComplete="email"
                          value={email}
                          onChange={(e) => setEmail(e.target.value)}
                          placeholder="name@example.com"
                          className="w-full h-11 pl-10 pr-3.5 rounded-xl border border-slate-200 bg-white text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-teal-700 focus:ring-2 focus:ring-teal-700/15"
                        />
                      </div>
                    </div>

                    <div>
                      <label
                        htmlFor="auth-mobile"
                        className="block text-xs font-medium text-slate-700 mb-1.5"
                      >
                        Registered Mobile Number
                      </label>
                      <div className="relative">
                        <Phone className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                        <input
                          id="auth-mobile"
                          type="tel"
                          required
                          autoComplete="tel"
                          value={mobile}
                          onChange={(e) => setMobile(e.target.value)}
                          placeholder="+91 98765 43210"
                          className="w-full h-11 pl-10 pr-3.5 rounded-xl border border-slate-200 bg-white text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-teal-700 focus:ring-2 focus:ring-teal-700/15"
                        />
                      </div>
                    </div>
                  </>
                )}

                {mode === 'login' && signInMethod === 'direct-otp' ? (
                  <div>
                    <label
                      htmlFor="auth-identifier"
                      className="block text-xs font-medium text-slate-700 mb-1.5"
                    >
                      Registered Mobile, Email, or Username
                    </label>
                    <div className="relative">
                      <Phone className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                      <input
                        id="auth-identifier"
                        type="text"
                        required
                        value={identifier}
                        onChange={(e) => setIdentifier(e.target.value)}
                        placeholder="Enter mobile number, email, or username"
                        className="w-full h-11 pl-10 pr-3.5 rounded-xl border border-slate-200 bg-white text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-teal-700 focus:ring-2 focus:ring-teal-700/15"
                      />
                    </div>
                  </div>
                ) : (
                  <>
                    <div>
                      <label
                        htmlFor="auth-username"
                        className="block text-xs font-medium text-slate-700 mb-1.5"
                      >
                        {mode === 'login' ? 'Gmail ID / Username / Mobile' : 'Username or Email ID'}
                      </label>
                      <div className="relative">
                        <User className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                        <input
                          id="auth-username"
                          type="text"
                          required
                          autoComplete="username"
                          value={username}
                          onChange={(e) => setUsername(e.target.value)}
                          placeholder={
                            mode === 'login'
                              ? 'Enter Gmail ID, username, or mobile'
                              : 'Enter username or email ID'
                          }
                          className="w-full h-11 pl-10 pr-3.5 rounded-xl border border-slate-200 bg-white text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-teal-700 focus:ring-2 focus:ring-teal-700/15"
                        />
                      </div>
                    </div>

                    <div>
                      <label
                        htmlFor="auth-password"
                        className="block text-xs font-medium text-slate-700 mb-1.5"
                      >
                        Password
                      </label>
                      <div className="relative">
                        <Lock className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                        <input
                          id="auth-password"
                          type={showPassword ? 'text' : 'password'}
                          required
                          autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                          value={password}
                          onChange={(e) => setPassword(e.target.value)}
                          placeholder="Enter password"
                          className="w-full h-11 pl-10 pr-11 rounded-xl border border-slate-200 bg-white text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-teal-700 focus:ring-2 focus:ring-teal-700/15"
                        />
                        <button
                          type="button"
                          onClick={() => setShowPassword((prev) => !prev)}
                          aria-label={showPassword ? 'Hide password' : 'Show password'}
                          className="absolute right-1 top-1/2 -translate-y-1/2 min-w-[40px] min-h-[40px] flex items-center justify-center text-slate-400 hover:text-slate-700 rounded-lg cursor-pointer"
                        >
                          {showPassword ? (
                            <EyeOff className="w-4 h-4" />
                          ) : (
                            <Eye className="w-4 h-4" />
                          )}
                        </button>
                      </div>
                    </div>
                  </>
                )}

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full h-12 rounded-xl bg-teal-700 hover:bg-teal-800 active:scale-[0.99] disabled:opacity-60 text-white text-sm font-semibold flex items-center justify-center gap-2 transition-all cursor-pointer shadow-[0_6px_18px_-6px_rgba(29,53,143,0.45)]"
                >
                  <span>
                    {loading
                      ? isStandalonePasswordOnly
                        ? mode === 'login'
                          ? 'Signing In...'
                          : 'Creating Account...'
                        : 'Sending OTP...'
                      : isStandalonePasswordOnly
                        ? mode === 'login'
                          ? 'Sign In'
                          : 'Create Account'
                        : mode === 'login'
                          ? 'Send Verification OTP'
                          : 'Create Account & Send Email OTP'}
                  </span>
                  {!loading && <ArrowRight className="w-4 h-4" />}
                </button>
              </form>
            </div>
          )}
        </div>

        <footer className="mt-6 text-center space-y-1">
          <p className="text-xs font-medium text-slate-300 tracking-wide">
            App Developed by <span className="text-[#E5C675] font-semibold">Shakti Chahar</span>
          </p>
          <p className="text-[11px] font-mono text-slate-400">
            Version {APP_VERSION}
          </p>
        </footer>
      </div>
    </div>
  );
}
