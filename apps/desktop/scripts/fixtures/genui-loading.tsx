import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { LazyGenUiBlock } from "../../src/components/chat/genui/lazy";

const root = createRoot(document.getElementById("root") as HTMLElement);
const api = {
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
