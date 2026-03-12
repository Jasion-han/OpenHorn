'use client';

import { Container, Title, Tabs } from '@mantine/core';
import { ChannelSettings } from '@/components/settings/ChannelSettings';
import { GeneralSettings } from '@/components/settings/GeneralSettings';
import { AgentSettings } from '@/components/settings/AgentSettings';
import { AppShellSlot } from '@/components/app/AppShellSlot';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';

export default function SettingsPage() {
  const search = useSearchParams();
  const [tab, setTab] = useState<'general' | 'channels' | 'agent'>('channels');

  useEffect(() => {
    const raw = search.get('tab');
    if (raw === 'general' || raw === 'channels' || raw === 'agent') {
      setTab(raw);
      return;
    }
    if (raw) {
      setTab('channels');
    }
  }, [search]);

  return (
    <>
      <AppShellSlot title="Settings" />
      <Container size="md" py="xl">
      <Title order={1} mb="xl">Settings</Title>
      
      <Tabs value={tab} onChange={(value) => setTab((value as typeof tab) || 'channels')}>
        <Tabs.List>
          <Tabs.Tab value="general">General</Tabs.Tab>
          <Tabs.Tab value="channels">Channels</Tabs.Tab>
          <Tabs.Tab value="agent">Agent</Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="general" pt="md">
          <GeneralSettings />
        </Tabs.Panel>

        <Tabs.Panel value="channels" pt="md">
          <ChannelSettings />
        </Tabs.Panel>

        <Tabs.Panel value="agent" pt="md">
          <AgentSettings />
        </Tabs.Panel>
      </Tabs>
      </Container>
    </>
  );
}
