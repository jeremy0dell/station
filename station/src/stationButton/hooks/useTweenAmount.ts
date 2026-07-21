import { useRenderer } from "@opentui/react";
import { useEffect, useRef, useState } from "react";
import { ANIM_MS, easeInOutCubic, FRAME_MS } from "../layout.js";

/**
 * Tweens a scalar target through a manual interval because Station does not attach OpenTUI's
 * Timeline engine to the renderer.
 */
export function useTweenAmount(target: number): number {
  const renderer = useRenderer();
  const [amount, setAmount] = useState(target);
  const fromRef = useRef(target);
  const mounted = useRef(false);

  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true; // First paint sits at the target, with no entrance animation.
      fromRef.current = target;
      return;
    }
    const from = fromRef.current;
    // OpenTUI is on-demand; without requesting "live" it won't paint the
    // in-between frames of this timer-driven tween (it would snap to the end).
    renderer.requestLive();
    let live = true;
    const dropLive = (): void => {
      if (live) {
        live = false;
        renderer.dropLive();
      }
    };
    let elapsed = 0;
    const id = setInterval(() => {
      elapsed += FRAME_MS;
      const t = Math.min(1, elapsed / ANIM_MS);
      if (t >= 1) {
        clearInterval(id);
        fromRef.current = target;
        setAmount(target);
        dropLive();
        return;
      }
      const value = from + (target - from) * easeInOutCubic(t);
      fromRef.current = value;
      setAmount(value);
    }, FRAME_MS);
    return () => {
      clearInterval(id);
      dropLive();
    };
  }, [target, renderer]);

  return amount;
}

