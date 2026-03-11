'use client';

import Link from 'next/link';
import { Stack, NavLink } from '@mantine/core';
import { usePathname } from 'next/navigation';
import { IconMessage, IconRobot, IconSettings } from '@tabler/icons-react';

const NAV_ITEMS = [
  { href: '/chat', label: 'Chat', icon: IconMessage },
  { href: '/agent', label: 'Agent', icon: IconRobot },
  { href: '/settings', label: 'Settings', icon: IconSettings },
] as const;

export function AppNav() {
  const pathname = usePathname();

  return (
    <Stack gap={4}>
      {NAV_ITEMS.map((item) => (
        <NavLink
          key={item.href}
          component={Link}
          href={item.href}
          label={item.label}
          leftSection={<item.icon size={18} />}
          active={pathname === item.href || pathname.startsWith(`${item.href}/`)}
          variant="subtle"
        />
      ))}
    </Stack>
  );
}

