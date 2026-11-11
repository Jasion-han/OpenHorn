import { expect, test } from "bun:test";
import { useAuthStore } from "../stores/authStore";
import { useChatStore } from "../stores/chatStore";
import { useImportStore } from "../stores/importStore";
import { useProjectStore } from "../stores/projectStore";
import { useScheduledTaskStore } from "../stores/scheduledTaskStore";
import { useWelcomeSuggestionStore } from "../stores/welcomeSuggestionStore";
import { loadServerState } from "./serverState";
import { sidecarPersistence } from "./sidecarPersistence";

const recovery = sidecarPersistence as { recover?: () => Promise<void> };

test("startup loads identity before suggestions so its reset cannot erase fresh results", async () => {
  const auth = useAuthStore.getState(),
    chat = useChatStore.getState();
  const imported = useImportStore.getState(),
    project = useProjectStore.getState();
  const scheduled = useScheduledTaskStore.getState(),
    welcome = useWelcomeSuggestionStore.getState();
  const recover = recovery.recover;
  let release!: () => void;
  let identified = false,
    suggestionReads = 0;
  const noOp = async () => {};
  try {
    useAuthStore.setState({
      bootstrap: async () => {
        await new Promise<void>((done) => {
          release = done;
        });
        useWelcomeSuggestionStore.getState().reset();
        useAuthStore.setState({
          user: { id: "synthetic-startup", username: "Synthetic", email: "startup@test.invalid" },
          error: null,
        });
        identified = true;
      },
    });
    useChatStore.setState({ loadChannels: noOp, loadConversations: noOp });
    useImportStore.setState({ loadPromptTemplates: noOp });
    useProjectStore.setState({ loadProjects: noOp, error: null });
    useScheduledTaskStore.setState({ loadTasks: noOp, loadRuns: async () => true, error: null });
    useWelcomeSuggestionStore.setState({
      load: async () => {
        suggestionReads++;
        expect(identified).toBe(true);
        useWelcomeSuggestionStore.setState({ items: ["fresh recommendation"] });
      },
    });
    recovery.recover = noOp;
    const loading = loadServerState();
    expect(suggestionReads).toBe(0);
    release();
    await loading;
    expect(suggestionReads).toBe(1);
    expect(useWelcomeSuggestionStore.getState().items).toEqual(["fresh recommendation"]);
  } finally {
    useAuthStore.setState(auth);
    useChatStore.setState(chat);
    useImportStore.setState(imported);
    useProjectStore.setState(project);
    useScheduledTaskStore.setState(scheduled);
    useWelcomeSuggestionStore.setState(welcome);
    recovery.recover = recover;
  }
});

test("HTTP group failures block readiness and retry does not reload completed required groups", async () => {
  const { createBackendStatusStore, isServerReady } = await import("../stores/backendStatusStore");
  const auth = useAuthStore.getState(),
    chat = useChatStore.getState(),
    project = useProjectStore.getState();
  const scheduled = useScheduledTaskStore.getState(),
    imported = useImportStore.getState(),
    welcome = useWelcomeSuggestionStore.getState();
  const recover = recovery.recover;
  let fail = true,
    channels = 0,
    conversations = 0,
    recoveries = 0;
  const noop = async () => {};
  const connection = createBackendStatusStore({
    probe: async () => ({ ok: true }),
    setTimer: () => 1,
    clearTimer: () => {},
  });
  try {
    useAuthStore.setState({
      bootstrap: async () => {
        useAuthStore.setState({
          user: {
            id: "synthetic-readiness",
            username: "Synthetic",
            email: "readiness@test.invalid",
          },
          error: null,
        });
      },
    });
    useChatStore.setState({
      loadChannels: async () => {
        channels++;
        connection.getState().markUp();
        if (fail) throw new Error("Synthetic HTTP 500");
      },
      loadConversations: async () => {
        conversations++;
      },
    });
    useProjectStore.setState({ loadProjects: noop, error: null });
    useScheduledTaskStore.setState({ loadTasks: noop, loadRuns: async () => true, error: null });
    useImportStore.setState({ loadPromptTemplates: noop });
    useWelcomeSuggestionStore.setState({ load: noop });
    recovery.recover = async () => {
      recoveries++;
    };
    expect(await connection.getState().start({ loader: loadServerState })).toBe(false);
    expect(isServerReady(connection.getState())).toBe(false);
    expect(recoveries).toBe(0);
    fail = false;
    expect(await connection.getState().connect()).toBe(true);
    expect(isServerReady(connection.getState())).toBe(true);
    expect(channels).toBe(2);
    expect(conversations).toBe(1);
    expect(recoveries).toBe(1);
  } finally {
    connection.getState().stop();
    useAuthStore.setState(auth);
    useChatStore.setState(chat);
    useProjectStore.setState(project);
    useScheduledTaskStore.setState(scheduled);
    useImportStore.setState(imported);
    useWelcomeSuggestionStore.setState(welcome);
    recovery.recover = recover;
  }
});

test("a hanging optional request cannot hold the required ready gate", async () => {
  const auth = useAuthStore.getState(),
    chat = useChatStore.getState(),
    project = useProjectStore.getState();
  const scheduled = useScheduledTaskStore.getState(),
    imported = useImportStore.getState(),
    welcome = useWelcomeSuggestionStore.getState();
  const recover = recovery.recover;
  const noop = async () => {};
  let release!: () => void;
  const hanging = new Promise<void>((done) => {
    release = done;
  });
  try {
    useAuthStore.setState({
      bootstrap: async () => {
        useAuthStore.setState({
          user: { id: "synthetic-optional", username: "Synthetic", email: "optional@test.invalid" },
          error: null,
        });
      },
    });
    useChatStore.setState({ loadChannels: noop, loadConversations: noop });
    useProjectStore.setState({ loadProjects: noop, error: null });
    useScheduledTaskStore.setState({ loadTasks: noop, loadRuns: async () => true, error: null });
    useImportStore.setState({ loadPromptTemplates: () => hanging });
    useWelcomeSuggestionStore.setState({ load: () => hanging });
    recovery.recover = noop;
    const outcome = await Promise.race([
      loadServerState().then(() => "ready"),
      new Promise<string>((done) => setTimeout(() => done("blocked"), 250)),
    ]);
    expect(outcome).toBe("ready");
  } finally {
    release();
    useAuthStore.setState(auth);
    useChatStore.setState(chat);
    useProjectStore.setState(project);
    useScheduledTaskStore.setState(scheduled);
    useImportStore.setState(imported);
    useWelcomeSuggestionStore.setState(welcome);
    recovery.recover = recover;
  }
});
