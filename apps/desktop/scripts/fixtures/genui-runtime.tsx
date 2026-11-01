import { createRoot } from "react-dom/client";
import { GenUiBlock } from "../../src/components/chat/genui/GenUiBlock";
import { blockStateKey, loadBlockState } from "../../src/lib/genui/blockState";
import { useGenUiStore } from "../../src/stores/genUiStore";

const root = createRoot(document.getElementById("root") as HTMLElement);

const api = {
  render(code: string, streaming = false, scope: string | null = null) {
    root.render(
      <GenUiBlock
        code={code}
        streaming={streaming}
        stateKey={scope ? blockStateKey(scope, 0, streaming ? "" : code) : null}
        fallback={<pre data-testid="source">{code}</pre>}
      />,
    );
  },
  unmount() {
    root.render(null);
  },
  request: () => useGenUiStore.getState().composerRequest,
  state: (scope: string, code: string) => loadBlockState(blockStateKey(scope, 0, code)),
};

Object.assign(window, { genUiTest: api });
api.render('root = Text("Ready")');
