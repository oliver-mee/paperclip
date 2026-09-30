import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import { useParams } from "react-router-dom";
import type { Issue } from "@paperclipai/shared";
import { useOptionalPanel } from "@/context/PanelContext";
import {
  hasBlockingShortcutDialog,
  isKeyboardShortcutTextInputTarget,
  resolveInboxQuickArchiveKeyAction,
} from "@/lib/keyboardShortcuts";
import { InboxIssuePanelView } from "./InboxIssuePanelView";

export interface UseInboxQuickTriageOptions {
  /** Off on mobile/touch: rows keep navigating to the full page. */
  enabled: boolean;
  /** Defaults to the `:companyPrefix` route param the Inbox renders under. */
  companyPrefix?: string | null;
  /** Issue rows in on-screen order; "next" after an archive follows this order. */
  orderedIssues: readonly Issue[];
  canArchive: boolean;
  archiveIssue: (issueId: string) => void;
  isArchiving: (issueId: string) => boolean;
  linkStateFor: (issue: Issue) => unknown;
  keyboardShortcutsEnabled: boolean;
}

/** Plain primary click with no modifier: the only click the panel takes over. */
export function isPlainPrimaryClick(event: Pick<MouseEvent, "button" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">) {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

export function issuePathIdFromHref(href: string | null): string | null {
  if (!href) return null;
  const match = /\/issues\/([^/?#]+)/.exec(href);
  return match ? decodeURIComponent(match[1]) : null;
}

/** The issue after `currentId` in list order, skipping rows already on their way out. */
export function findNextIssue(
  orderedIssues: readonly Issue[],
  currentId: string,
  isArchiving: (issueId: string) => boolean,
): Issue | null {
  const index = orderedIssues.findIndex((issue) => issue.id === currentId);
  if (index < 0) return null;
  for (const issue of orderedIssues.slice(index + 1)) {
    if (issue.id !== currentId && !isArchiving(issue.id)) return issue;
  }
  return null;
}

/**
 * Fork (MAG-482): Inbox quick triage. A plain click on an issue row opens it
 * in the docked side panel instead of navigating; Archive in the panel header
 * archives it and opens the next row. Cmd/Ctrl/middle-click keep the link.
 */
export function useInboxQuickTriage(options: UseInboxQuickTriageOptions) {
  const { companyPrefix: routeCompanyPrefix } = useParams<{ companyPrefix?: string }>();
  // Harnesses without a panel host get a disabled hook rather than a crash.
  const panel = useOptionalPanel();
  const noop = useCallback(() => {}, []);
  const openPanel = panel?.openPanel ?? noop;
  const closePanel = panel?.closePanel ?? noop;
  const setPanelVisible = panel?.setPanelVisible ?? noop;
  const panelVisible = panel?.panelVisible ?? false;
  const hasPanelHost = panel !== null;
  const [preview, setPreview] = useState<Issue | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const previewRef = useRef(preview);
  previewRef.current = preview;
  // Visibility preference before we forced the panel open, restored on close so
  // triage never changes whether issue pages open with their properties panel.
  const priorVisibleRef = useRef<boolean | null>(null);

  const open = useCallback((issue: Issue) => {
    if (priorVisibleRef.current === null) priorVisibleRef.current = panelVisible;
    setPanelVisible(true);
    setPreview(issue);
  }, [panelVisible, setPanelVisible]);

  const close = useCallback(() => {
    if (!previewRef.current) return;
    setPreview(null);
    closePanel();
    if (priorVisibleRef.current !== null) {
      setPanelVisible(priorVisibleRef.current);
      priorVisibleRef.current = null;
    }
  }, [closePanel, setPanelVisible]);

  const archiveCurrent = useCallback(() => {
    const current = previewRef.current;
    if (!current) return;
    const { orderedIssues, isArchiving, archiveIssue } = optionsRef.current;
    const next = findNextIssue(orderedIssues, current.id, isArchiving);
    archiveIssue(current.id);
    if (next) setPreview(next);
    else close();
  }, [close]);

  const previewId = preview?.id ?? null;
  const archivePending = preview ? options.isArchiving(preview.id) : false;
  const showArchive = options.canArchive;
  const companyPrefix = options.companyPrefix ?? routeCompanyPrefix ?? null;
  const companyPrefixRef = useRef(companyPrefix);
  companyPrefixRef.current = companyPrefix;
  const hasPanelHostRef = useRef(hasPanelHost);
  hasPanelHostRef.current = hasPanelHost;

  useEffect(() => {
    if (!preview || !companyPrefix) return;
    const pathId = preview.identifier ?? preview.id;
    openPanel(
      <InboxIssuePanelView
        key={preview.id}
        companyPrefix={companyPrefix}
        issuePathId={pathId}
        identifier={preview.identifier ?? null}
        title={preview.title}
        linkState={optionsRef.current.linkStateFor(preview)}
        onArchive={showArchive ? archiveCurrent : undefined}
        archivePending={archivePending}
      />,
      { contentMode: "full-bleed" },
    );
    // Title/identifier come from the snapshot taken on open; the embedded page
    // renders live data, so only identity and archive state re-open the panel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewId, companyPrefix, showArchive, archivePending, archiveCurrent, openPanel]);

  // The panel's own hide control closes triage too.
  useEffect(() => {
    if (preview && !panelVisible) close();
  }, [preview, panelVisible, close]);

  // Leaving the Inbox (including "Open full page") hands the panel back.
  useEffect(() => () => {
    if (!previewRef.current) return;
    closePanel();
    if (priorVisibleRef.current !== null) setPanelVisible(priorVisibleRef.current);
  }, [closePanel, setPanelVisible]);

  useEffect(() => {
    if (!preview) return;
    // Capture phase, registered before the embedded page's listener, so "y"
    // archives-and-advances here rather than the page's archive-and-navigate.
    const handleArchiveKey = (event: KeyboardEvent) => {
      const { keyboardShortcutsEnabled, canArchive } = optionsRef.current;
      if (!keyboardShortcutsEnabled || !canArchive) return;
      const action = resolveInboxQuickArchiveKeyAction({
        armed: true,
        defaultPrevented: event.defaultPrevented,
        key: event.key,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        target: event.target,
        hasOpenDialog: hasBlockingShortcutDialog(document),
      });
      if (action !== "archive") return;
      event.preventDefault();
      event.stopPropagation();
      archiveCurrent();
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (isKeyboardShortcutTextInputTarget(event.target) || hasBlockingShortcutDialog(document)) return;
      event.preventDefault();
      close();
    };
    document.addEventListener("keydown", handleArchiveKey, true);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("keydown", handleArchiveKey, true);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [preview, archiveCurrent, close]);

  const onListClickCapture = useCallback((event: MouseEvent<HTMLElement>) => {
    const { enabled, orderedIssues } = optionsRef.current;
    if (!enabled || !hasPanelHostRef.current || !companyPrefixRef.current || !isPlainPrimaryClick(event)) return;
    const target = event.target instanceof Element ? event.target : null;
    const anchor = target?.closest<HTMLAnchorElement>("a[data-inbox-issue-link]");
    if (!anchor || !event.currentTarget.contains(anchor)) return;
    const pathId = issuePathIdFromHref(anchor.getAttribute("href"));
    const issue = pathId
      ? orderedIssues.find((candidate) => candidate.identifier === pathId || candidate.id === pathId)
      : undefined;
    if (!issue) return;
    event.preventDefault();
    open(issue);
  }, [open]);

  return { previewIssueId: previewId, onListClickCapture, closePreview: close };
}
