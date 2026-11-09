import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "ui";
import { getWorkbenchLabel as label } from "../../lib/i18n/agent";

export function DiscardChangesDialog({
  open,
  onKeep,
  onDiscard,
}: {
  open: boolean;
  onKeep(): void;
  onDiscard(): void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onKeep();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{label("workbench.edit.discardTitle")}</DialogTitle>
          <DialogDescription>{label("workbench.edit.discardHint")}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onKeep} autoFocus>
            {label("workbench.edit.keep")}
          </Button>
          <Button variant="destructive" onClick={onDiscard}>
            {label("workbench.edit.discard")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
