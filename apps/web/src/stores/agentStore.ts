import { create } from 'zustand';

export interface Workspace {
  id: string;
  name: string;
  slug: string;
  description?: string;
  cwd?: string;
}

export interface AgentSession {
  id: string;
  title: string;
  workspaceId?: string;
  channelId?: string;
  status: 'active' | 'completed' | 'cancelled';
  createdAt: Date;
}

export interface AgentEvent {
  type: 'text' | 'tool_start' | 'tool_result' | 'done' | 'error';
  content?: string;
  toolName?: string;
  toolInput?: unknown;
}

interface AgentState {
  workspaces: Workspace[];
  sessions: AgentSession[];
  currentSession: AgentSession | null;
  events: AgentEvent[];
  isRunning: boolean;
  selectedWorkspaceId: string | null;
  
  setWorkspaces: (workspaces: Workspace[]) => void;
  addWorkspace: (workspace: Workspace) => void;
  removeWorkspace: (id: string) => void;
  
  setSessions: (sessions: AgentSession[]) => void;
  addSession: (session: AgentSession) => void;
  setCurrentSession: (session: AgentSession | null) => void;
  setSelectedWorkspaceId: (id: string | null) => void;
  
  addEvent: (event: AgentEvent) => void;
  clearEvents: () => void;
  setIsRunning: (running: boolean) => void;
}

export const useAgentStore = create<AgentState>((set) => ({
  workspaces: [],
  sessions: [],
  currentSession: null,
  events: [],
  isRunning: false,
  selectedWorkspaceId: null,
  
  setWorkspaces: (workspaces) => set({ workspaces }),
  addWorkspace: (workspace) => set((state) => ({ 
    workspaces: [...state.workspaces, workspace] 
  })),
  removeWorkspace: (id) => set((state) => ({ 
    workspaces: state.workspaces.filter((w) => w.id !== id) 
  })),
  
  setSessions: (sessions) => set({ sessions }),
  addSession: (session) => set((state) => ({ 
    sessions: [session, ...state.sessions] 
  })),
  setCurrentSession: (session) => set({ currentSession: session, events: [] }),
  setSelectedWorkspaceId: (id) => set({ selectedWorkspaceId: id }),
  
  addEvent: (event) => set((state) => ({ 
    events: [...state.events, event] 
  })),
  clearEvents: () => set({ events: [] }),
  setIsRunning: (running) => set({ isRunning: running }),
}));
