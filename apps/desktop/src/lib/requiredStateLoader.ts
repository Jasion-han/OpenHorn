interface RequiredLoad {
  key: string;
  load(): Promise<void>;
}

/** Keep successful groups only during one interrupted load, never across identities or clean reloads. */
export function createRequiredStateLoader(options: {
  identity(): Promise<string>;
  owner(): string | null;
  groups: RequiredLoad[];
}) {
  let scope: string | null = null;
  const completed = new Set<string>();
  let inflight: Promise<void> | null = null;
  return () => {
    if (inflight) return inflight;
    inflight = (async () => {
      const owner = await options.identity();
      if (scope !== owner) {
        scope = owner;
        completed.clear();
      }
      const current = () => options.owner() === owner;
      const results = await Promise.allSettled(
        options.groups.map(async (group) => {
          if (completed.has(group.key)) return;
          await group.load();
          if (!current()) throw new Error("server_state_identity_changed");
          completed.add(group.key);
        }),
      );
      if (!current() || results.some((result) => result.status === "rejected")) {
        if (!current()) {
          completed.clear();
          scope = null;
        }
        throw new Error("server_state_incomplete");
      }
      completed.clear();
      scope = null;
    })().finally(() => {
      inflight = null;
    });
    return inflight;
  };
}
