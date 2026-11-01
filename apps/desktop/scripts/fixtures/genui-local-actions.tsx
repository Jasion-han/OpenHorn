import { MORTGAGE_EXAMPLE } from "../../src/lib/genui/mortgageExample";
import { useGenUiStore } from "../../src/stores/genUiStore";
import "./genui-controls";

/** Reuse actual Chat/Agent bubbles, state reconciliation and persistence. */
Object.assign(window, {
  genUiLocalActions: {
    mortgage: MORTGAGE_EXAMPLE,
    seedDraft: (text: string) => useGenUiStore.getState().requestComposerText(text),
    disclosure: `root = Col([Text($count), Button("Local action", @Set($count, $count + 1)), Button("Reset action", @Reset($count)), Button("Copy action", @CopyToClipboard("local copy")), Button("Link action", @OpenUrl("https://example.com/local-actions")), Button("Explicit follow-up", @ToAssistant("Explain current data", {count:$count})), Button("Implicit follow-up"), Button("Legacy follow-up", {type:"continue_conversation",context:"legacy context"}), Button("Mixed follow-up", Action([@Set($count, $count + 1), @ToAssistant("Mixed request", {source:"mixed"})])), Button("Empty legacy follow-up", {})])
$count = 0`,
  },
});
