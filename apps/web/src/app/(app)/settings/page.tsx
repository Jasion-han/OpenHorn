'use client';

import { Container, Title, Tabs } from '@mantine/core';
import { ChannelSettings } from '@/components/settings/ChannelSettings';
import { GeneralSettings } from '@/components/settings/GeneralSettings';
import { AgentSettings } from '@/components/settings/AgentSettings';
import { AppShellSlot } from '@/components/app/AppShellSlot';

export default function SettingsPage() {
  return (
    <>
      <AppShellSlot title="Settings" />
      <Container size="md" py="xl">
      <Title order={1} mb="xl">Settings</Title>
      
      <Tabs defaultValue="channels">
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
