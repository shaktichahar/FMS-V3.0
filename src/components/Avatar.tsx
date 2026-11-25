import { useState } from 'react';

interface AvatarProps {
  name: string;
  src?: string;
  size?: 'sm' | 'md' | 'lg';
}

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'U';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

export function Avatar({ name, src, size = 'md' }: AvatarProps) {
  const [imgFailed, setImgFailed] = useState(false);

  const sizeClass =
    size === 'sm'
      ? 'w-8 h-8 text-xs'
      : size === 'lg'
        ? 'w-11 h-11 text-sm'
        : 'w-9 h-9 text-xs';

  if (src && !imgFailed) {
    return (
      <img
        src={src}
        alt={`${name} profile`}
        referrerPolicy="no-referrer"
        onError={() => setImgFailed(true)}
        className={`${sizeClass} rounded-full object-cover border border-slate-200 shrink-0 bg-slate-100`}
      />
    );
  }

  return (
    <div
      aria-hidden="true"
      className={`${sizeClass} rounded-full bg-teal-50 text-teal-800 border border-teal-200/70 font-semibold flex items-center justify-center shrink-0 select-none`}
    >
      {getInitials(name)}
    </div>
  );
}
