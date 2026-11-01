/** Own a host approval resolver for exactly one live request. */
export function waitForApproval(
  pending: Map<string, (allow: boolean) => void>,
  id: string,
  signal: AbortSignal,
  publish: () => void,
): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve, reject) => {
    const settle = (allow: boolean) => {
      signal.removeEventListener("abort", cancel);
      pending.delete(id);
      resolve(allow);
    };
    const cancel = () => settle(false);
    pending.set(id, settle);
    signal.addEventListener("abort", cancel, { once: true });
    try {
      publish();
    } catch (error) {
      signal.removeEventListener("abort", cancel);
      pending.delete(id);
      reject(error);
    }
  });
}
