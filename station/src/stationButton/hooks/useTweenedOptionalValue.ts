import { useEffect, useState } from "react";
import { useTweenAmount } from "./useTweenAmount.js";

export type TweenedOptionalValue<T> = {
  value: T | undefined;
  amount: number;
};

/** Retains an outgoing optional value until its reversible tween finishes. */
export function useTweenedOptionalValue<T>(value: T | undefined): TweenedOptionalValue<T> {
  const [heldValue, setHeldValue] = useState(value);
  const amount = useTweenAmount(value === undefined ? 0 : 1);

  useEffect(() => {
    if (value !== undefined) {
      setHeldValue(value);
    } else if (amount === 0) {
      setHeldValue(undefined);
    }
  }, [amount, value]);

  return { value: value === undefined ? heldValue : value, amount };
}
