import { Container, Title, Text, Button, Group, Stack, Card, SimpleGrid } from '@mantine/core';
import { IconMessage, IconRobot, IconSettings } from '@tabler/icons-react';
import Link from 'next/link';

export default function Home() {
  return (
    <Container size="sm" py={100}>
      <Stack align="center" gap="xl">
        <Title order={1}>Welcome to OpenHorn</Title>
        <Text c="dimmed" size="lg" ta="center">
          Your AI Assistant with Agent capabilities
        </Text>
        
        <Group>
          <Button 
            variant="filled" 
            size="lg" 
            component={Link}
            href="/chat"
            leftSection={<IconMessage size={20} />}
          >
            Chat
          </Button>
          <Button 
            variant="filled" 
            size="lg" 
            component={Link}
            href="/agent"
            leftSection={<IconRobot size={20} />}
          >
            Agent
          </Button>
          <Button 
            variant="outline" 
            size="lg" 
            component={Link}
            href="/settings"
            leftSection={<IconSettings size={20} />}
          >
            Settings
          </Button>
        </Group>

        <SimpleGrid cols={{ base: 1, sm: 3 }} w="100%" mt="xl">
          <Card withBorder padding="lg" radius="md">
            <Title order={3} mb="sm">Chat</Title>
            <Text size="sm" c="dimmed">
              Multi-model AI chat with streaming responses. Supports OpenAI, Anthropic, DeepSeek, and Google.
            </Text>
          </Card>
          
          <Card withBorder padding="lg" radius="md">
            <Title order={3} mb="sm">Agent</Title>
            <Text size="sm" c="dimmed">
              AI-powered automation with tool execution. Build workflows and automate tasks.
            </Text>
          </Card>
          
          <Card withBorder padding="lg" radius="md">
            <Title order={3} mb="sm">Workspaces</Title>
            <Text size="sm" c="dimmed">
              Manage multiple workspaces with MCP integrations. Keep your projects organized.
            </Text>
          </Card>
        </SimpleGrid>
      </Stack>
    </Container>
  );
}
