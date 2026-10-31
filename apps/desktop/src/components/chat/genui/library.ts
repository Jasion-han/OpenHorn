import { createLibrary } from "@openuidev/react-lang";
import { genUiFunctions } from "../../../lib/genui/functions";
import { CopyToClipboard, genUiComponentGroups, genUiComponents } from "./components";

export const genUiLibrary = createLibrary({
  root: "Col",
  components: genUiComponents,
  componentGroups: genUiComponentGroups,
  functions: genUiFunctions,
  actions: [CopyToClipboard],
});
