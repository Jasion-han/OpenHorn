declare module "bun:test" {
  export function describe(label: string, callback: () => void): void;
  export function test(label: string, callback: () => void | Promise<void>): void;
  export function expect<T>(value: T): {
    toBe(expected: unknown): void;
    toBeDefined(): void;
    toBeInstanceOf(expected: abstract new (...args: never[]) => unknown): void;
    toEqual(expected: unknown): void;
    toHaveLength(expected: number): void;
    toMatchObject(expected: Record<string, unknown>): void;
  };
}
