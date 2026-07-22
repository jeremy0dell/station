import { useEffect, useRef, useState } from "react";
import { useTweenAmount } from "./useTweenAmount.js";

export type TweenedOptionalValue<T> = {
  value: T | undefined;
  amount: number;
};

/** Retains outgoing values and swaps replacements only at the tween's hidden boundary. */
export function useTweenedOptionalValue<T>(
  value: T | undefined,
  entranceEnabled: boolean = true,
): TweenedOptionalValue<T> {
  const incomingValue = useRef(value);
  const [heldValue, setHeldValue] = useState(value);
  const [target, setTarget] = useState(value === undefined || !entranceEnabled ? 0 : 1);
  const amount = useTweenAmount(target, target === 0 || entranceEnabled);

  useEffect(() => {
    if (Object.is(incomingValue.current, value)) {
      return;
    }
    incomingValue.current = value;
    if (value === undefined) {
      setTarget(0);
    } else if (Object.is(heldValue, value)) {
      // A value returning during its exit reverses from the current amount.
      setTarget(1);
    } else if (amount === 0) {
      setHeldValue(value);
      setTarget(1);
    } else {
      setTarget(0);
    }
  }, [amount, heldValue, value]);

  useEffect(() => {
    if (amount !== 0 || target !== 0) {
      return;
    }
    const incoming = incomingValue.current;
    if (incoming === undefined) {
      setHeldValue(undefined);
      return;
    }
    setHeldValue(incoming);
    setTarget(1);
  }, [amount, target]);

  return { value: heldValue, amount };
}
