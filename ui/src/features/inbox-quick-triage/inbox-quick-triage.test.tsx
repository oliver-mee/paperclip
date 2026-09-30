// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Issue } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PanelProvider, usePanel } from "@/context/PanelContext";
import type { InboxWorkItem } from "@/lib/inbox";

vi.mock("@/lib/router", () => ({
  Link: ({
    children,
    to,
    disableIssueQuicklook: _disableIssueQuicklook,
    ...props
  }: React.ComponentProps<"a"> & { to: string; disableIssueQuicklook?: boolean }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

// The real panel view mounts the full issue page; the hook only needs its props.
vi.mock("./InboxIssuePanelView", () => ({
  InboxIssuePanelView: ({ issuePathId, onArchive }: { issuePathId: string; onArchive?: () => void }) => (
    <div data-testid="panel-view" data-issue={issuePathId}>
      {onArchive ? <button type="button" data-testid="panel-archive" onClick={onArchive}>Archive</button> : null}
    </div>
  ),
}));

vi.mock("@/pages/Inbox", () => ({
  formatJoinRequestInboxLabel: () => "Join request",
  loadInboxCollectionPreferences: () => ({ viewState: {} }),
}));

vi.mock("@/components/StatusIcon", () => ({
  StatusIcon: ({ status }: { status: string }) => <span data-status={status} />,
}));

const { findNextIssue, isPlainPrimaryClick, issuePathIdFromHref, useInboxQuickTriage } = await import("./useInboxQuickTriage");
const { InboxPeekList, selectInboxPeekRows } = await import("./InboxNavPeek");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function makeIssue(n: number, overrides: Partial<Issue> = {}): Issue {
  return {
    id: `id-${n}`,
    identifier: `TRI-${n}`,
    title: `Issue ${n}`,
    status: "todo",
    parentId: null,
    isUnreadForMe: false,
    updatedAt: new Date(Date.UTC(2026, 8, 30, 0, 0, 100 - n)).toISOString(),
    createdAt: new Date(Date.UTC(2026, 8, 30)).toISOString(),
    ...overrides,
  } as Issue;
}

function issueItem(issue: Issue): InboxWorkItem {
  return { kind: "issue", timestamp: Date.parse(String(issue.updatedAt)), issue };
}

describe("quick-triage helpers", () => {
  it("only takes over plain primary clicks", () => {
    const base = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false };
    expect(isPlainPrimaryClick(base)).toBe(true);
    expect(isPlainPrimaryClick({ ...base, metaKey: true })).toBe(false);
    expect(isPlainPrimaryClick({ ...base, ctrlKey: true })).toBe(false);
    expect(isPlainPrimaryClick({ ...base, shiftKey: true })).toBe(false);
    expect(isPlainPrimaryClick({ ...base, button: 1 })).toBe(false);
  });

  it("reads the issue path id from a row href", () => {
    expect(issuePathIdFromHref("/MAG/issues/MAG-482")).toBe("MAG-482");
    expect(issuePathIdFromHref("/issues/abc?x=1#c")).toBe("abc");
    expect(issuePathIdFromHref("/MAG/inbox")).toBeNull();
    expect(issuePathIdFromHref(null)).toBeNull();
  });

  it("finds the next row, skipping rows already archiving", () => {
    const issues = [1, 2, 3, 4].map((n) => makeIssue(n));
    expect(findNextIssue(issues, "id-1", () => false)?.id).toBe("id-2");
    expect(findNextIssue(issues, "id-1", (id) => id === "id-2")?.id).toBe("id-3");
    expect(findNextIssue(issues, "id-4", () => false)).toBeNull();
    expect(findNextIssue(issues, "missing", () => false)).toBeNull();
  });
});

describe("selectInboxPeekRows", () => {
  const baseArgs = {
    groupBy: "none" as const,
    nestingEnabled: false,
    collapsedParentIds: new Set<string>(),
    readItems: new Set<string>(),
    agentNameById: new Map<string, string>(),
  };

  it("returns the first five rows in inbox order with unread state", () => {
    const issues = [3, 1, 6, 2, 5, 4, 7].map((n) => makeIssue(n, { isUnreadForMe: n === 2 }));
    const rows = selectInboxPeekRows({
      ...baseArgs,
      items: issues.map(issueItem).sort((a, b) => b.timestamp - a.timestamp),
    });
    expect(rows.map((row) => row.identifier)).toEqual(["TRI-1", "TRI-2", "TRI-3", "TRI-4", "TRI-5"]);
    expect(rows.find((row) => row.identifier === "TRI-2")?.unread).toBe(true);
    expect(rows[0]?.href).toBe("/issues/TRI-1");
  });

  it("follows nesting: children sit under their parent, collapsed parents hide them", () => {
    const parent = makeIssue(1);
    const child = makeIssue(9, { parentId: "id-1" });
    const other = makeIssue(2);
    const items = [parent, other, child].map(issueItem).sort((a, b) => b.timestamp - a.timestamp);
    const expanded = selectInboxPeekRows({ ...baseArgs, items, nestingEnabled: true });
    expect(expanded.map((row) => row.identifier)).toEqual(["TRI-1", "TRI-9", "TRI-2"]);
    const collapsed = selectInboxPeekRows({
      ...baseArgs,
      items,
      nestingEnabled: true,
      collapsedParentIds: new Set(["id-1"]),
    });
    expect(collapsed.map((row) => row.identifier)).toEqual(["TRI-1", "TRI-2"]);
  });
});

describe("InboxPeekList", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("shows the empty state and the Open inbox footer", () => {
    act(() => root.render(<InboxPeekList rows={[]} loading={false} onNavigate={() => {}} />));
    expect(container.textContent).toContain("Inbox is clear");
    expect(container.querySelector('a[href="/inbox"]')?.textContent).toBe("Open inbox");
  });

  it("renders each row with identifier, title and unread marker", () => {
    const rows = selectInboxPeekRows({
      items: [issueItem(makeIssue(1, { isUnreadForMe: true }))],
      groupBy: "none",
      nestingEnabled: false,
      collapsedParentIds: new Set(),
      readItems: new Set(),
      agentNameById: new Map(),
    });
    const onNavigate = vi.fn();
    act(() => root.render(<InboxPeekList rows={rows} loading={false} onNavigate={onNavigate} />));
    const row = container.querySelector<HTMLAnchorElement>("[data-testid=inbox-peek-row]");
    expect(row?.getAttribute("href")).toBe("/issues/TRI-1");
    expect(row?.textContent).toContain("TRI-1");
    expect(row?.textContent).toContain("Issue 1");
    expect(row?.textContent).toContain("(unread)");
    act(() => row?.click());
    expect(onNavigate).toHaveBeenCalled();
  });
});

describe("useInboxQuickTriage", () => {
  let container: HTMLDivElement;
  let root: Root;
  const issues = [1, 2, 3].map((n) => makeIssue(n));
  let archived: string[];

  function PanelProbe() {
    const { panelContent, panelVisible } = usePanel();
    return <div data-testid="probe" data-visible={String(panelVisible)}>{panelContent as ReactNode}</div>;
  }

  function Harness({ enabled = true }: { enabled?: boolean }) {
    const { previewIssueId, onListClickCapture } = useInboxQuickTriage({
      enabled,
      companyPrefix: "TRI",
      orderedIssues: issues.filter((issue) => !archived.includes(issue.id)),
      canArchive: true,
      archiveIssue: (id) => archived.push(id),
      isArchiving: (id) => archived.includes(id),
      linkStateFor: () => null,
      keyboardShortcutsEnabled: true,
    });
    return (
      <div data-testid="list" data-preview={previewIssueId ?? ""} onClickCapture={onListClickCapture}>
        {issues.map((issue) => (
          <div key={issue.id}>
            <a data-inbox-issue-link href={`/TRI/issues/${issue.identifier}`}>{issue.title}</a>
            <button type="button" data-testid={`mark-${issue.id}`}>mark read</button>
          </div>
        ))}
      </div>
    );
  }

  function render(enabled = true) {
    act(() => root.render(
      <PanelProvider>
        <Harness enabled={enabled} />
        <PanelProbe />
      </PanelProvider>,
    ));
  }

  const panelIssue = () => container.querySelector("[data-testid=panel-view]")?.getAttribute("data-issue") ?? null;
  const clickRow = (n: number, init: MouseEventInit = {}) => {
    const anchor = container.querySelector(`a[href="/TRI/issues/TRI-${n}"]`)!;
    const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init });
    act(() => { anchor.dispatchEvent(event); });
    return event;
  };

  beforeEach(() => {
    archived = [];
    localStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("opens a plainly clicked row in the panel instead of navigating", () => {
    render();
    const event = clickRow(2);
    expect(event.defaultPrevented).toBe(true);
    expect(panelIssue()).toBe("TRI-2");
    expect(container.querySelector("[data-testid=list]")?.getAttribute("data-preview")).toBe("id-2");
  });

  it("leaves modifier clicks and row buttons alone", () => {
    render();
    expect(clickRow(2, { metaKey: true }).defaultPrevented).toBe(false);
    expect(clickRow(2, { ctrlKey: true }).defaultPrevented).toBe(false);
    act(() => (container.querySelector("[data-testid=mark-id-2]") as HTMLButtonElement).click());
    expect(panelIssue()).toBeNull();
  });

  it("does nothing when disabled (mobile)", () => {
    render(false);
    expect(clickRow(1).defaultPrevented).toBe(false);
    expect(panelIssue()).toBeNull();
  });

  it("archive opens the next row, and archiving the last row closes the panel", () => {
    render();
    clickRow(2);
    act(() => (container.querySelector("[data-testid=panel-archive]") as HTMLButtonElement).click());
    expect(archived).toEqual(["id-2"]);
    expect(panelIssue()).toBe("TRI-3");
    act(() => (container.querySelector("[data-testid=panel-archive]") as HTMLButtonElement).click());
    expect(archived).toEqual(["id-2", "id-3"]);
    expect(panelIssue()).toBeNull();
  });

  it("Escape closes the panel and restores the visibility preference", () => {
    localStorage.setItem("paperclip:panel-visible", "false");
    render();
    clickRow(1);
    expect(container.querySelector("[data-testid=probe]")?.getAttribute("data-visible")).toBe("true");
    act(() => { document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(panelIssue()).toBeNull();
    expect(localStorage.getItem("paperclip:panel-visible")).toBe("false");
  });

  it("y archives the previewed row and advances", () => {
    render();
    clickRow(1);
    act(() => { document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "y", bubbles: true, cancelable: true })); });
    expect(archived).toEqual(["id-1"]);
    expect(panelIssue()).toBe("TRI-2");
  });
});
