import { createContext } from "react";

/** A numeric input's publication, valid only through its next committed effects. */
export interface ControlEdit {
  owner: symbol;
  value: unknown;
  normalize: (value: number) => void;
}

// Each rendered program owns its edits. Equal $variable names in other blocks
// cannot preserve or interrupt this program's input draft.
export const ControlEditContext = createContext<Map<string, ControlEdit> | null>(null);
