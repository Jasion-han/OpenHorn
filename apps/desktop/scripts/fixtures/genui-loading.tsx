import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { LazyGenUiBlock, loadCurrentGenUiSection } from "../../src/components/chat/genui/lazy";
import { useGenUiStore } from "../../src/stores/genUiStore";

const root = createRoot(document.getElementById("root") as HTMLElement);
const api = {
  policy: loadCurrentGenUiSection,
  isAuto: () => useGenUiStore.getState().enabled,
  setAuto: (enabled: boolean) => useGenUiStore.getState().setEnabled(enabled),
  render(programs: string[]) {
    flushSync(() =>
      root.render(
        programs.map((code) => (
          <LazyGenUiBlock
            key={code}
            code={code}
            streaming={false}
            stateKey={null}
            fallback={<pre data-testid="source">{code}</pre>}
          />
        )),
      ),
    );
  },
  clear() {
    flushSync(() => root.render(<p>Ordinary reply.</p>));
  },
};
Object.assign(window, { genUiLoadTest: api });
api.clear();
