import { expect, test } from "bun:test";
import { useBackendStatusStore } from "../stores/backendStatusStore";
import { BackupSizeLimitError, dataTransferErrorMessage } from "./dataTransferError";
import { getDataTransferLabel } from "./i18n/agent";
import { createServerApi } from "./serverApi";

test("backup export turns a typed capacity response into actionable localized feedback", async () => {
  const previous = useBackendStatusStore.getState();
  try {
    const api = createServerApi({
      baseUrl: "http://synthetic.invalid",
      fetch: (async () =>
        Response.json({ errorCode: "backup_size_limit" }, { status: 413 })) as typeof fetch,
    });
    let error: unknown;
    try {
      await api.dataTransfer.exportBackup("/synthetic");
    } catch (caught) {
      error = caught;
    }
    expect(error instanceof BackupSizeLimitError).toBe(true);
    expect(dataTransferErrorMessage(error)).toBe(
      getDataTransferLabel("settings.data.export.sizeLimit"),
    );
    expect(dataTransferErrorMessage(new Error("Synthetic failure"))).toBe("Synthetic failure");
  } finally {
    useBackendStatusStore.setState(previous, true);
  }
});
