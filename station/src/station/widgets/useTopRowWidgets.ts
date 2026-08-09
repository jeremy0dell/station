import { createUseTopRowWidgets } from "@station/dashboard-core/widgets";
import { useFocus } from "@opentui/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const useTopRowWidgetsCore = createUseTopRowWidgets({
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
});

export function useTopRowWidgets(
  widgets: Parameters<typeof useTopRowWidgetsCore>[0],
  deps?: Parameters<typeof useTopRowWidgetsCore>[1],
  surfaceVisible = true,
): ReturnType<typeof useTopRowWidgetsCore> {
  const [focusEpoch, setFocusEpoch] = useState(0);
  useFocus(() => setFocusEpoch((previous) => previous + 1));
  return useTopRowWidgetsCore(widgets, deps, `${focusEpoch}:${surfaceVisible ? 1 : 0}`);
}
