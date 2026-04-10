import { useEffect, useMemo, useState } from "react";
import { useReducedMotion } from "framer-motion";

const STORAGE_KEY = "omni:motion:mode";
const MODES = {
  system: "system",
  on: "on",
  off: "off",
};

function readStoredMode() {
  if (typeof window === "undefined") {
    return MODES.system;
  }

  const value = String(localStorage.getItem(STORAGE_KEY) || "").toLowerCase();
  if (value === MODES.on || value === MODES.off || value === MODES.system) {
    return value;
  }

  return MODES.system;
}

export default function useMotionPreferences() {
  const prefersReducedMotion = useReducedMotion();
  const [motionMode, setMotionMode] = useState(() => readStoredMode());

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    localStorage.setItem(STORAGE_KEY, motionMode);
  }, [motionMode]);

  const motionEnabled = useMemo(() => {
    if (motionMode === MODES.on) {
      return true;
    }

    if (motionMode === MODES.off) {
      return false;
    }

    return !prefersReducedMotion;
  }, [motionMode, prefersReducedMotion]);

  const motionModeLabel = useMemo(() => {
    if (motionMode === MODES.on) {
      return "Motion On";
    }

    if (motionMode === MODES.off) {
      return "Motion Off";
    }

    return motionEnabled ? "Motion Auto" : "Motion Auto (Reduced)";
  }, [motionEnabled, motionMode]);

  const toggleMotionMode = () => {
    setMotionMode((prev) => {
      if (prev === MODES.system) {
        return MODES.on;
      }

      if (prev === MODES.on) {
        return MODES.off;
      }

      return MODES.system;
    });
  };

  return {
    motionEnabled,
    motionMode,
    motionModeLabel,
    toggleMotionMode,
  };
}
