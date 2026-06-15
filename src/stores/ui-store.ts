import { create } from "zustand";
import { safeGet, safeSet, safeGetBool, safeGetNum } from "@/lib/storage";

function getInitialTheme(): "light" | "dark" {
  const stored = safeGet("novel-reader-theme");
  if (stored === "dark" || stored === "light") return stored;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function getInitialFontSize(): number {
  return safeGetNum("novel-reader-font-size", 18);
}

function getInitialFontWeight(): number {
  return safeGetNum("novel-reader-font-weight", 400);
}

function getInitialDebugMode(): boolean {
  return safeGetBool("novel-reader-debug");
}

function getInitialLineHeight(): number {
  return safeGetNum("novel-reader-line-height", 1.8);
}

function getInitialParagraphSpacing(): number {
  return safeGetNum("novel-reader-para-spacing", 8);
}

function getInitialFontFamily(): string {
  return safeGet("novel-reader-font-family") || "system-ui";
}

function getInitialOfflineMode(): boolean {
  return safeGetBool("novel-reader-offline-mode");
}

function getInitialGraphCharacterLimit(): number {
  return safeGetNum("novel-reader-graph-char-limit", 50, (v) => v >= 10 && v <= 150);
}

function getInitialReadingMode(): "scroll" | "single" | "double" {
  const stored = safeGet("novel-reader-reading-mode");
  if (stored === "single" || stored === "double") return stored;
  return "scroll";
}

function getInitialAutoSwitchPageMode(): boolean {
  // Default true unless explicitly set to "false"
  return safeGet("novel-reader-auto-switch-page") !== "false";
}

interface UIState {
  theme: "light" | "dark";
  fontSize: number;
  fontWeight: number;
  debugMode: boolean;
  lineHeight: number;
  paragraphSpacing: number;
  fontFamily: string;
  offlineMode: boolean;
  graphCharacterLimit: number;
  readingMode: "scroll" | "single" | "double";
  autoSwitchPageMode: boolean;
  setTheme: (theme: "light" | "dark") => void;
  toggleTheme: () => void;
  setFontSize: (size: number) => void;
  setFontWeight: (weight: number) => void;
  setDebugMode: (v: boolean) => void;
  setLineHeight: (v: number) => void;
  setParagraphSpacing: (v: number) => void;
  setFontFamily: (v: string) => void;
  setOfflineMode: (v: boolean) => void;
  setGraphCharacterLimit: (v: number) => void;
  setReadingMode: (mode: "scroll" | "single" | "double") => void;
  setAutoSwitchPageMode: (auto: boolean) => void;
}

export const useUIStore = create<UIState>((set) => ({
  theme: getInitialTheme(),
  fontSize: getInitialFontSize(),
  fontWeight: getInitialFontWeight(),
  debugMode: getInitialDebugMode(),
  lineHeight: getInitialLineHeight(),
  paragraphSpacing: getInitialParagraphSpacing(),
  fontFamily: getInitialFontFamily(),
  offlineMode: getInitialOfflineMode(),
  graphCharacterLimit: getInitialGraphCharacterLimit(),
  readingMode: getInitialReadingMode(),
  autoSwitchPageMode: getInitialAutoSwitchPageMode(),

  setTheme: (theme) => {
    safeSet("novel-reader-theme", theme);
    set({ theme });
  },

  toggleTheme: () =>
    set((s) => {
      const next = s.theme === "light" ? "dark" : "light";
      safeSet("novel-reader-theme", next);
      return { theme: next };
    }),

  setFontSize: (size) => {
    const clamped = Math.max(8, Math.min(48, size));
    safeSet("novel-reader-font-size", String(clamped));
    set({ fontSize: clamped });
  },

  setFontWeight: (weight) => {
    const clamped = Math.max(100, Math.min(900, weight));
    safeSet("novel-reader-font-weight", String(clamped));
    set({ fontWeight: clamped });
  },

  setDebugMode: (v) => {
    safeSet("novel-reader-debug", String(v));
    set({ debugMode: v });
  },

  setLineHeight: (v) => {
    // 修正浮点精度：先取整到 1 位小数，再限制范围
    const rounded = Math.round(v * 10) / 10;
    const clamped = Math.max(1.2, Math.min(2.4, rounded));
    safeSet("novel-reader-line-height", String(clamped));
    set({ lineHeight: clamped });
  },

  setParagraphSpacing: (v) => {
    const clamped = Math.max(0, Math.min(20, v));
    safeSet("novel-reader-para-spacing", String(clamped));
    set({ paragraphSpacing: clamped });
  },

  setFontFamily: (v) => {
    safeSet("novel-reader-font-family", v);
    set({ fontFamily: v });
  },

  setOfflineMode: (v) => {
    safeSet("novel-reader-offline-mode", String(v));
    set({ offlineMode: v });
  },

  setGraphCharacterLimit: (v) => {
    const clamped = Math.max(10, Math.min(150, Math.round(v)));
    safeSet("novel-reader-graph-char-limit", String(clamped));
    set({ graphCharacterLimit: clamped });
  },

  setReadingMode: (mode) => {
    safeSet("novel-reader-reading-mode", mode);
    set({ readingMode: mode });
  },

  setAutoSwitchPageMode: (auto) => {
    safeSet("novel-reader-auto-switch-page", String(auto));
    set({ autoSwitchPageMode: auto });
  },
}));
