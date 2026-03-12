'use client';

import type React from 'react';

export function IconActionButton({
  children,
  onClick,
  title,
  danger,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  title: string;
  danger?: boolean;
  disabled?: boolean;
}) {
  const baseColor = danger ? 'var(--mantine-color-red-5)' : 'var(--mantine-color-gray-5)';
  const hoverBg = danger ? 'var(--mantine-color-red-0)' : 'var(--mantine-color-gray-1)';
  const hoverColor = danger ? 'var(--mantine-color-red-7)' : 'var(--mantine-color-gray-8)';

  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      disabled={disabled}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 26,
        height: 22,
        padding: 0,
        border: '1px solid var(--mantine-color-gray-3)',
        borderRadius: 'var(--mantine-radius-sm)',
        background: 'transparent',
        color: baseColor,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.55 : 1,
        transition: 'background 0.12s, color 0.12s, opacity 0.12s',
        fontFamily: 'inherit',
      }}
      onMouseEnter={(e) => {
        if (disabled) return;
        (e.currentTarget as HTMLButtonElement).style.background = hoverBg;
        (e.currentTarget as HTMLButtonElement).style.color = hoverColor;
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
        (e.currentTarget as HTMLButtonElement).style.color = baseColor;
      }}
    >
      {children}
    </button>
  );
}

