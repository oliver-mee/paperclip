import { useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { INBOX_MINE_ISSUE_STATUS_FILTER, type Issue } from "@paperclipai/shared";
import { ShieldCheck, UserPlus, XCircle } from "lucide-react";
import { accessApi } from "@/api/access";
import { agentsApi } from "@/api/agents";
import { approvalsApi } from "@/api/approvals";
import { authApi } from "@/api/auth";
import { ApiError } from "@/api/client";
import { heartbeatsApi } from "@/api/heartbeats";
import { issuesApi } from "@/api/issues";
import { approvalLabel } from "@/components/ApprovalPayload";
import { StatusIcon } from "@/components/StatusIcon";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { useSidebar } from "@/context/SidebarContext";
import { useInboxDismissals, useReadInboxItems } from "@/hooks/useInboxBadge";
import {
  buildGroupedInboxSections,
  buildInboxKeyboardNavEntries,
  getApprovalsForTab,
  getInboxWorkItemKey,
  getInboxWorkItems,
  getLatestFailedRunsByAgent,
  getRecentTouchedIssues,
  isInboxEntityDismissed,
  loadCollapsedInboxParentIds,
  loadInboxNesting,
  loadInboxWorkItemGroupBy,
  resolveInboxNestingEnabled,
  type InboxWorkItem,
} from "@/lib/inbox";
import { filterLocalInboxArchivedIssues, useLocalInboxArchiveIssueIds } from "@/lib/inboxArchiveCache";
import { applyIssueFilters } from "@/lib/issue-filters";
import { createIssueDetailPath } from "@/lib/issueDetailBreadcrumb";
import { queryKeys } from "@/lib/queryKeys";
import { Link } from "@/lib/router";
import { cn } from "@/lib/utils";
import { formatJoinRequestInboxLabel, loadInboxCollectionPreferences } from "@/pages/Inbox";

export const INBOX_PEEK_LIMIT = 5;
/** Long enough that sweeping the cursor down the sidebar never opens it. */
export const INBOX_PEEK_OPEN_DELAY_MS = 450;
// Must match the Inbox page's list queries so the popover reads the same cache.
const INBOX_ISSUE_LIST_LIMIT = 500;
const INBOX_HEARTBEAT_RUN_LIMIT = 200;

export interface InboxPeekRow {
  key: string;
  href: string;
  title: string;
  identifier: string | null;
  unread: boolean;
  item: InboxWorkItem;
}

/**
 * The Inbox page's default ("Mine") view, first rows only: same sources, saved
 * filters, grouping, nesting and collapsed parents, in the same order.
 */
export function selectInboxPeekRows({
  items,
  groupBy,
  nestingEnabled,
  collapsedParentIds,
  readItems,
  agentNameById,
  limit = INBOX_PEEK_LIMIT,
}: {
  items: InboxWorkItem[];
  groupBy: ReturnType<typeof loadInboxWorkItemGroupBy>;
  nestingEnabled: boolean;
  collapsedParentIds: ReadonlySet<string>;
  readItems: ReadonlySet<string>;
  agentNameById: ReadonlyMap<string, string>;
  limit?: number;
}): InboxPeekRow[] {
  const sections = buildGroupedInboxSections(items, groupBy, {}, { nestingEnabled });
  const entries = buildInboxKeyboardNavEntries(sections, new Set(), collapsedParentIds);
  const rows: InboxPeekRow[] = [];
  for (const entry of entries) {
    if (rows.length >= limit) break;
    const item: InboxWorkItem | null = entry.type === "top"
      ? entry.item
      : entry.type === "child" ? { kind: "issue", timestamp: 0, issue: entry.issue } : null;
    if (!item) continue;
    rows.push(toPeekRow(item, readItems, agentNameById));
  }
  return rows;
}

function toPeekRow(
  item: InboxWorkItem,
  readItems: ReadonlySet<string>,
  agentNameById: ReadonlyMap<string, string>,
): InboxPeekRow {
  const key = getInboxWorkItemKey(item);
  if (item.kind === "issue") {
    const { issue } = item;
    return {
      key,
      href: createIssueDetailPath(issue.identifier ?? issue.id),
      title: issue.title,
      identifier: issue.identifier ?? null,
      unread: issue.isUnreadForMe === true,
      item,
    };
  }
  const unread = !readItems.has(key);
  if (item.kind === "approval") {
    return {
      key,
      href: `/approvals/${item.approval.id}`,
      title: approvalLabel(item.approval.type, item.approval.payload as Record<string, unknown> | null),
      identifier: null,
      unread,
      item,
    };
  }
  if (item.kind === "failed_run") {
    const agentName = agentNameById.get(item.run.agentId);
    return {
      key,
      href: `/agents/${item.run.agentId}/runs/${item.run.id}`,
      title: `Failed run${agentName ? ` — ${agentName}` : ""}`,
      identifier: null,
      unread,
      item,
    };
  }
  return {
    key,
    // Join requests have no page of their own; they are approved from the Inbox.
    href: "/inbox",
    title: formatJoinRequestInboxLabel(item.joinRequest),
    identifier: null,
    unread,
    item,
  };
}

function useInboxPeekRows(companyId: string | null | undefined, enabled: boolean) {
  const active = enabled && !!companyId;
  const locallyArchivedIssueIds = useLocalInboxArchiveIssueIds(companyId);
  const { dismissedAtByKey } = useInboxDismissals(companyId);
  const { readItems } = useReadInboxItems();
  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    enabled: active,
  });
  const currentUserId = session?.user.id ?? session?.session.userId ?? null;

  const mineIssuesQuery = useQuery({
    queryKey: [...queryKeys.issues.listMineByMe(companyId!), "compact", "with-routine-executions", "live-descendant-summary", INBOX_ISSUE_LIST_LIMIT] as const,
    queryFn: () =>
      issuesApi.listCompact(companyId!, {
        touchedByUserId: "me",
        inboxArchivedByUserId: "me",
        status: INBOX_MINE_ISSUE_STATUS_FILTER,
        includeRoutineExecutions: true,
        includeLiveDescendantSummary: true,
        limit: INBOX_ISSUE_LIST_LIMIT,
      }).then((rows) => rows as Issue[]),
    enabled: active,
    refetchOnWindowFocus: false,
    staleTime: 30_000,
  });
  const { data: approvals = [] } = useQuery({
    queryKey: queryKeys.approvals.list(companyId!),
    queryFn: () => approvalsApi.list(companyId!),
    enabled: active,
  });
  const { data: joinRequests = [] } = useQuery({
    queryKey: queryKeys.access.joinRequests(companyId!),
    queryFn: async () => {
      try {
        return await accessApi.listJoinRequests(companyId!, "pending_approval");
      } catch (err) {
        if (err instanceof ApiError && (err.status === 401 || err.status === 403)) return [];
        throw err;
      }
    },
    enabled: active,
    retry: false,
  });
  const { data: heartbeatRuns = [] } = useQuery({
    queryKey: [...queryKeys.heartbeats(companyId!), "limit", INBOX_HEARTBEAT_RUN_LIMIT],
    queryFn: () => heartbeatsApi.list(companyId!, undefined, INBOX_HEARTBEAT_RUN_LIMIT, { summary: true }),
    enabled: active,
    refetchOnWindowFocus: false,
    staleTime: 30_000,
  });
  const { data: agents = [] } = useQuery({
    queryKey: queryKeys.agents.list(companyId!),
    queryFn: () => agentsApi.list(companyId!),
    enabled: active,
  });

  const rows = useMemo(() => {
    if (!active) return [];
    const { viewState } = loadInboxCollectionPreferences(companyId);
    const mineIssues = getRecentTouchedIssues(
      filterLocalInboxArchivedIssues(companyId, mineIssuesQuery.data ?? []),
    );
    const issues = applyIssueFilters(mineIssues, viewState.issueFilters, currentUserId, true);
    const approvalsForMine = getApprovalsForTab(approvals, "mine", viewState.allApprovalFilter, currentUserId)
      .filter((a) => !isInboxEntityDismissed(dismissedAtByKey, `approval:${a.id}`, a.updatedAt));
    const failedRuns = getLatestFailedRunsByAgent(heartbeatRuns)
      .filter((r) => !isInboxEntityDismissed(dismissedAtByKey, `run:${r.id}`, r.createdAt));
    const visibleJoinRequests = joinRequests
      .filter((jr) => !isInboxEntityDismissed(dismissedAtByKey, `join:${jr.id}`, jr.updatedAt ?? jr.createdAt));
    return selectInboxPeekRows({
      items: getInboxWorkItems({
        issues,
        approvals: approvalsForMine,
        failedRuns,
        joinRequests: visibleJoinRequests,
      }),
      groupBy: loadInboxWorkItemGroupBy(),
      nestingEnabled: resolveInboxNestingEnabled(loadInboxNesting(), false),
      collapsedParentIds: loadCollapsedInboxParentIds(companyId),
      readItems,
      agentNameById: new Map(agents.map((agent) => [agent.id, agent.name])),
    });
    // locallyArchivedIssueIds re-runs the filter when a local archive lands.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, companyId, mineIssuesQuery.data, approvals, joinRequests, heartbeatRuns, agents, currentUserId, dismissedAtByKey, readItems, locallyArchivedIssueIds]);

  return { rows, loading: active && mineIssuesQuery.isPending };
}

function PeekRowIcon({ row }: { row: InboxPeekRow }) {
  if (row.item.kind === "issue") {
    return <StatusIcon status={row.item.issue.status} blockerAttention={row.item.issue.blockerAttention} size="md" />;
  }
  if (row.item.kind === "approval") return <ShieldCheck className="h-4 w-4 text-muted-foreground" />;
  if (row.item.kind === "failed_run") return <XCircle className="h-4 w-4 text-red-600 dark:text-red-400" />;
  return <UserPlus className="h-4 w-4 text-muted-foreground" />;
}

export function InboxPeekList({
  rows,
  loading,
  onNavigate,
}: {
  rows: InboxPeekRow[];
  loading: boolean;
  onNavigate: () => void;
}) {
  return (
    <div data-testid="inbox-peek" className="flex flex-col">
      <div className="px-3 pb-1 pt-2.5 text-xs font-medium text-muted-foreground">Inbox</div>
      {rows.length > 0 ? (
        <ul className="flex flex-col px-1">
          {rows.map((row) => (
            <li key={row.key}>
              <Link
                to={row.href}
                disableIssueQuicklook
                onClick={onNavigate}
                data-testid="inbox-peek-row"
                className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-sm no-underline text-inherit hover:bg-accent/60"
              >
                <span className="flex h-2 w-2 shrink-0 items-center justify-center" aria-hidden="true">
                  {row.unread ? <span className="h-2 w-2 rounded-full bg-blue-600 dark:bg-blue-400" /> : null}
                </span>
                <span className="flex shrink-0 items-center"><PeekRowIcon row={row} /></span>
                <span className={cn("min-w-0 flex-1 truncate", row.unread ? "font-medium" : "text-foreground/80")}>
                  {row.identifier ? (
                    <span className="mr-1.5 font-mono text-xs text-muted-foreground">{row.identifier}</span>
                  ) : null}
                  {row.title}
                </span>
                {row.unread ? <span className="sr-only">(unread)</span> : null}
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <div className="px-3 py-3 text-sm text-muted-foreground">
          {loading ? "Loading…" : "Inbox is clear"}
        </div>
      )}
      <div className="mt-1 border-t border-border p-1">
        <Link
          to="/inbox"
          onClick={onNavigate}
          className="flex items-center justify-center rounded-md px-2 py-1.5 text-xs font-medium text-muted-foreground no-underline hover:bg-accent/60 hover:text-foreground"
        >
          Open inbox
        </Link>
      </div>
    </div>
  );
}

function InboxPeekContent({ companyId, onNavigate }: { companyId: string | null | undefined; onNavigate: () => void }) {
  const { rows, loading } = useInboxPeekRows(companyId, true);
  return <InboxPeekList rows={rows} loading={loading} onNavigate={onNavigate} />;
}

/**
 * Fork (MAG-482): hovering the sidebar Inbox item previews the top of the
 * inbox. The nav item's own click is untouched. Radix HoverCard ignores touch
 * pointers, and mobile renders the item bare.
 */
export function InboxNavPeek({ companyId, children }: { companyId: string | null | undefined; children: ReactNode }) {
  const { isMobile } = useSidebar();
  const [open, setOpen] = useState(false);
  if (isMobile || !companyId) return <>{children}</>;
  return (
    <HoverCard open={open} onOpenChange={setOpen} openDelay={INBOX_PEEK_OPEN_DELAY_MS} closeDelay={150}>
      <HoverCardTrigger asChild>
        <div>{children}</div>
      </HoverCardTrigger>
      <HoverCardContent side="right" align="start" sideOffset={6} className="w-80 p-0">
        {open ? <InboxPeekContent companyId={companyId} onNavigate={() => setOpen(false)} /> : null}
      </HoverCardContent>
    </HoverCard>
  );
}
