import type { Dispatch, SetStateAction } from "react";
import { useCallback, useEffect } from "react";
import { create } from "zustand";
import { getDesktopBackendBase } from "../lib/backendBase";
import { useAuthStore } from "./authStore";

export interface ConversationDraft {
  text: string;
  files: File[];
}
interface DraftLease {
  generation: number;
  revision: number;
}
interface DraftState {
  owner: string | null;
  drafts: Record<string, ConversationDraft>;
  generation: number;
  revisions: Record<string, number>;
  discard(owner: string | null, id: string, generation?: number): void;
  bind(owner: string | null): void;
  update(
    owner: string | null,
    id: string | null,
    change: (draft: ConversationDraft) => ConversationDraft,
    lease?: DraftLease,
  ): void;
}
const EMPTY: ConversationDraft = { text: "", files: [] };
const emptyDrafts = (): Record<string, ConversationDraft> => Object.create(null);

export function mergeComposerHandoff(
  current: ConversationDraft,
  incoming: ConversationDraft & { autoSend?: boolean },
) {
  const collision = !!current.text.trim() && current.text !== incoming.text;
  const autoCollision =
    incoming.autoSend !== false &&
    (collision || current.files.some((file) => !incoming.files.includes(file)));
  return {
    text:
      incoming.autoSend === false && current.text.trim()
        ? current.text
        : autoCollision && collision
          ? `${current.text.trimEnd()}\n\n${incoming.text}`
          : incoming.text,
    files: [...new Set([...current.files, ...incoming.files])],
    autoSend: incoming.autoSend !== false && !autoCollision,
    needsReview: autoCollision,
  };
}

export function createConversationDraftStore(owner: string | null = null) {
  return create<DraftState>((set) => ({
    owner,
    drafts: emptyDrafts(),
    generation: 1,
    revisions: Object.create(null),
    discard: (owner, id, generation) =>
      set((state) => {
        if (
          !owner ||
          owner !== state.owner ||
          (generation !== undefined && generation !== state.generation)
        )
          return state;
        const drafts = Object.assign(emptyDrafts(), state.drafts);
        delete drafts[id];
        return {
          drafts,
          revisions: {
            ...state.revisions,
            [id]: (Object.hasOwn(state.revisions, id) ? state.revisions[id] : 0) + 1,
          },
        };
      }),
    bind: (owner) =>
      set((state) =>
        state.owner === owner
          ? state
          : {
              owner,
              drafts: emptyDrafts(),
              generation: state.generation + 1,
              revisions: Object.create(null),
            },
      ),
    update: (owner, id, change, lease) =>
      set((state) => {
        if (!owner || !id || state.owner !== owner) return state;
        if (
          lease &&
          (lease.generation !== state.generation ||
            lease.revision !== (Object.hasOwn(state.revisions, id) ? state.revisions[id] : 0))
        )
          return state;
        const next = change(state.drafts[id] ?? EMPTY);
        const drafts: Record<string, ConversationDraft> = Object.assign(
          emptyDrafts(),
          state.drafts,
        );
        if (!next.text && next.files.length === 0) delete drafts[id];
        else drafts[id] = { text: next.text, files: [...next.files] };
        return { drafts };
      }),
  }));
}
const ownerKey = () => {
  const id = useAuthStore.getState().user?.id;
  return id ? `${getDesktopBackendBase()}:${id}` : null;
};
/** No disk persistence and no automatic send: these are unfinished composer contents only. */
export const useConversationDraftStore = createConversationDraftStore(ownerKey());
useAuthStore.subscribe(() => useConversationDraftStore.getState().bind(ownerKey()));

export function useConversationDraft(id: string | null) {
  const owner = ownerKey();
  useEffect(() => useConversationDraftStore.getState().bind(owner), [owner]);
  const generation = useConversationDraftStore((state) => state.generation);
  const revision = useConversationDraftStore((state) =>
    id ? (Object.hasOwn(state.revisions, id) ? state.revisions[id] : 0) : 0,
  );
  const draft = useConversationDraftStore((state) =>
    state.owner === owner && id ? (state.drafts[id] ?? EMPTY) : EMPTY,
  );
  const setText: Dispatch<SetStateAction<string>> = useCallback(
    (value) => {
      useConversationDraftStore.getState().update(
        owner,
        id,
        (current) => ({
          ...current,
          text: typeof value === "function" ? value(current.text) : value,
        }),
        { generation, revision },
      );
    },
    [owner, id, generation, revision],
  );
  const setFiles: Dispatch<SetStateAction<File[]>> = useCallback(
    (value) => {
      useConversationDraftStore.getState().update(
        owner,
        id,
        (current) => ({
          ...current,
          files: typeof value === "function" ? value(current.files) : value,
        }),
        { generation, revision },
      );
    },
    [owner, id, generation, revision],
  );
  return { draft, setText, setFiles };
}
