import { create } from 'zustand';

export interface AgentSession {
  id: string;
  title: string;
  channelId?: string;
  status: 'active' | 'completed' | 'cancelled';
  createdAt: Date;
}

export interface AgentEvent {
  // 'user' is a local-only event to show what the user just ran.
  // 'meta' is a server-originated keepalive/progress signal. UI will ignore it.
  id?: string;
  type: 'user' | 'meta' | 'text' | 'tool_start' | 'tool_result' | 'done' | 'error';
  content?: string;
  toolName?: string;
  toolInput?: unknown;
  streamTail?: string;
  streamPulseKey?: number;
}

const STREAM_TAIL_WINDOW = 18;

function getRollingTail(text: string, size = STREAM_TAIL_WINDOW) {
  const chars = Array.from(text);
  return chars.slice(Math.max(0, chars.length - size)).join('');
}

interface AgentState {
  sessions: AgentSession[];
  currentSession: AgentSession | null;
  events: AgentEvent[];
  isRunning: boolean;

  setSessions: (sessions: AgentSession[]) => void;
  addSession: (session: AgentSession) => void;
  setCurrentSession: (session: AgentSession | null) => void;
  patchCurrentSession: (updates: Partial<AgentSession>) => void;

  addEvent: (event: AgentEvent) => void;
  removeEvent: (id: string) => void;
  clearEvents: () => void;
  setEvents: (events: AgentEvent[]) => void;
  setIsRunning: (running: boolean) => void;
}

export const useAgentStore = create<AgentState>((set) => ({
  sessions: [],
  currentSession: null,
  events: [],
  isRunning: false,

  setSessions: (sessions) => set({ sessions }),
  addSession: (session) => set((state) => ({
    sessions: [session, ...state.sessions],
  })),
  setCurrentSession: (session) => set({ currentSession: session, events: [] }),
  patchCurrentSession: (updates) => set((state) => ({
    currentSession: state.currentSession ? { ...state.currentSession, ...updates } : null,
  })),

  addEvent: (event: AgentEvent) => set((state) => {
    // Streaming: append text content to the last text event instead of creating a new card.
    if (event.type === 'text' && event.content) {
      const last = state.events[state.events.length - 1];
      if (last && last.type === 'text') {
        const updated = [...state.events];
        updated[updated.length - 1] = {
          ...last,
          content: (last.content ?? '') + event.content,
          streamTail: getRollingTail(`${last.content ?? ''}${event.content}`),
          streamPulseKey: (last.streamPulseKey ?? 0) + 1,
        };
        return { events: updated };
      }
    }
    return { events: [...state.events, event] };
  }),
  removeEvent: (id: string) => set((state) => ({ events: state.events.filter((e) => e.id !== id) })),
  clearEvents: () => set({ events: [] }),
  setEvents: (events) => set({ events }),
  setIsRunning: (running) => set({ isRunning: running }),
}));
