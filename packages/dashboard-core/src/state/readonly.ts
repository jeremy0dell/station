type Primitive = null | undefined | string | number | boolean | bigint | symbol;

/**
 * Preserve primitive and branded scalar identities while recursively sealing
 * object properties and collection mutation methods at the type boundary.
 */
export type ReadonlyDeep<T> = T extends Primitive
  ? T
  : T extends (...arguments_: never[]) => unknown
    ? T
    : T extends ReadonlyMap<infer TKey, infer TValue>
      ? ReadonlyMap<ReadonlyDeep<TKey>, ReadonlyDeep<TValue>>
      : T extends ReadonlySet<infer TValue>
        ? ReadonlySet<ReadonlyDeep<TValue>>
        : T extends readonly unknown[]
          ? { readonly [TIndex in keyof T]: ReadonlyDeep<T[TIndex]> }
          : T extends object
            ? { readonly [TKey in keyof T]: ReadonlyDeep<T[TKey]> }
            : T;
