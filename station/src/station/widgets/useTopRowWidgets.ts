import { createUseTopRowWidgets } from "@station/dashboard-core/widgets";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export const useTopRowWidgets = createUseTopRowWidgets({
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
});
