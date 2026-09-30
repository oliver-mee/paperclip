import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import type { SidePanelContentMode } from "@/components/side-panel";

const STORAGE_KEY = "paperclip:panel-visible";

interface PanelContextValue {
  panelContent: ReactNode | null;
  panelContentMode: SidePanelContentMode;
  panelVisible: boolean;
  openPanel: (content: ReactNode, options?: { contentMode?: SidePanelContentMode }) => void;
  closePanel: () => void;
  setPanelVisible: (visible: boolean) => void;
  togglePanelVisible: () => void;
  /**
   * One-shot maximize request (LOOA-2181): deep links with `viewer=full` ask
   * the resizable panel host to open maximized. The request stays pending
   * until the host consumes it (the panel may not be mounted yet when the
   * deep link routes), so consumers must clear it after acting.
   */
  panelMaximizeRequested: boolean;
  requestPanelMaximize: () => void;
  clearPanelMaximizeRequest: () => void;
}

const PanelContext = createContext<PanelContextValue | null>(null);

function readPreference(): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw === null ? true : raw === "true";
  } catch {
    return true;
  }
}

function writePreference(visible: boolean) {
  try {
    localStorage.setItem(STORAGE_KEY, String(visible));
  } catch {
    // Ignore storage failures.
  }
}

export function PanelProvider({ children }: { children: ReactNode }) {
  const [panelContent, setPanelContent] = useState<ReactNode | null>(null);
  const [panelContentMode, setPanelContentMode] = useState<SidePanelContentMode>("padded");
  const [panelVisible, setPanelVisibleState] = useState(readPreference);
  const [panelMaximizeRequested, setPanelMaximizeRequested] = useState(false);

  const requestPanelMaximize = useCallback(() => {
    setPanelMaximizeRequested(true);
  }, []);

  const clearPanelMaximizeRequest = useCallback(() => {
    setPanelMaximizeRequested(false);
  }, []);

  const openPanel = useCallback((content: ReactNode, options?: { contentMode?: SidePanelContentMode }) => {
    setPanelContent(content);
    setPanelContentMode(options?.contentMode ?? "padded");
  }, []);

  const closePanel = useCallback(() => {
    setPanelContent(null);
    setPanelContentMode("padded");
  }, []);

  const setPanelVisible = useCallback((visible: boolean) => {
    setPanelVisibleState(visible);
    writePreference(visible);
  }, []);

  const togglePanelVisible = useCallback(() => {
    setPanelVisibleState((prev) => {
      const next = !prev;
      writePreference(next);
      return next;
    });
  }, []);

  return (
    <PanelContext.Provider
      value={{
        panelContent,
        panelContentMode,
        panelVisible,
        openPanel,
        closePanel,
        setPanelVisible,
        togglePanelVisible,
        panelMaximizeRequested,
        requestPanelMaximize,
        clearPanelMaximizeRequest,
      }}
    >
      {children}
    </PanelContext.Provider>
  );
}

export function usePanel() {
  const ctx = useContext(PanelContext);
  if (!ctx) {
    throw new Error("usePanel must be used within PanelProvider");
  }
  return ctx;
}

/**
 * Fork (MAG-482): a sandboxed panel context for a page rendered *inside* the
 * side panel (Inbox quick triage). The embedded page can open/close its own
 * properties panel without replacing the host panel's content or writing the
 * shared visibility preference; nothing renders what it opens here.
 */
export function IsolatedPanelProvider({ children }: { children: ReactNode }) {
  const [panelContent, setPanelContent] = useState<ReactNode | null>(null);
  const [panelContentMode, setPanelContentMode] = useState<SidePanelContentMode>("padded");
  const [panelVisible, setPanelVisibleState] = useState(false);
  const openPanel = useCallback((content: ReactNode, options?: { contentMode?: SidePanelContentMode }) => {
    setPanelContent(content);
    setPanelContentMode(options?.contentMode ?? "padded");
  }, []);
  const closePanel = useCallback(() => setPanelContent(null), []);
  const togglePanelVisible = useCallback(() => setPanelVisibleState((prev) => !prev), []);
  const noop = useCallback(() => {}, []);

  return (
    <PanelContext.Provider
      value={{
        panelContent,
        panelContentMode,
        panelVisible,
        openPanel,
        closePanel,
        setPanelVisible: setPanelVisibleState,
        togglePanelVisible,
        panelMaximizeRequested: false,
        requestPanelMaximize: noop,
        clearPanelMaximizeRequest: noop,
      }}
    >
      {children}
    </PanelContext.Provider>
  );
}

/** Fork (MAG-482): null outside a PanelProvider, for features that are optional without a panel host. */
export function useOptionalPanel() {
  return useContext(PanelContext);
}
