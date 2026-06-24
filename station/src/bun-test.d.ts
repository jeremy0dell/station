declare module "bun:test" {
  type AsyncExpectation = {
    toEqual(expected: unknown): void | Promise<void>;
    toMatchObject(expected: unknown): void | Promise<void>;
  };

  type Matchers = {
    toBe(expected: unknown): void;
    toBeGreaterThan(expected: number): void;
    toBeGreaterThanOrEqual(expected: number): void;
    toBeLessThan(expected: number): void;
    toBeLessThanOrEqual(expected: number): void;
    toBeDefined(): void;
    toBeNull(): void;
    toBeUndefined(): void;
    toContain(expected: unknown): void;
    toEqual(expected: unknown): void;
    toHaveLength(expected: number): void;
    toHaveProperty(property: string): void;
    toMatchObject(expected: unknown): void;
    toMatch(expected: RegExp | string): void;
    toMatchSnapshot(): void;
    toThrow(expected?: RegExp): void;
  };

  // `not` mirrors the full matcher set so any assertion can be negated.
  type Expectation = Matchers & {
    not: Matchers;
    resolves: AsyncExpectation;
    rejects: AsyncExpectation;
  };

  export function afterEach(callback: () => void | Promise<void>): void;
  export function beforeEach(callback: () => void | Promise<void>): void;
  export function describe(name: string, callback: () => void): void;
  export function expect(actual: unknown): Expectation;
  export function it(
    name: string,
    callback: () => void | Promise<void>,
    timeoutMs?: number,
  ): void;
}
