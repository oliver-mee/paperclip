import { useEffect, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Archive, ExternalLink } from "lucide-react";
import { Link, Route, Routes } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { PROPERTIES_PANE_HEADER_SLOT_ID } from "@/components/PropertiesPanel";
import { IsolatedBreadcrumbProvider } from "@/context/BreadcrumbContext";
import { IsolatedPanelProvider } from "@/context/PanelContext";
import { useStreamlinedUiEnabled } from "@/hooks/useStreamlinedUiEnabled";
import { createIssueDetailPath } from "@/lib/issueDetailBreadcrumb";
import { cn } from "@/lib/utils";
import { IssueDetail } from "@/pages/IssueDetail";

export interface InboxIssuePanelViewProps {
  companyPrefix: string;
  issuePathId: string;
  identifier: string | null;
  title: string;
  /** Location state the row link would have carried (source breadcrumb "Inbox"). */
  linkState?: unknown;
  onArchive?: () => void;
  archivePending?: boolean;
}

/** The pane header slot mounts in the same commit as this content, so resolve it after mount. */
function usePaneHeaderSlot(): HTMLElement | null {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setSlot(document.getElementById(PROPERTIES_PANE_HEADER_SLOT_ID));
  }, []);
  return slot;
}

export function InboxIssuePanelHeader({
  issuePathId,
  identifier,
  title,
  linkState,
  onArchive,
  archivePending,
}: Omit<InboxIssuePanelViewProps, "companyPrefix">) {
  return (
    <div data-testid="inbox-panel-header" className="flex min-w-0 flex-1 items-center gap-2 pl-3 pr-1">
      {/* The embedded page already leads with the title; the header only anchors which row this is. */}
      <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground" title={title}>
        {identifier ?? "Task"}
      </span>
      {onArchive ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 shrink-0 gap-1.5 px-2"
          disabled={archivePending}
          onClick={onArchive}
        >
          <Archive className="h-3.5 w-3.5" />
          Archive
        </Button>
      ) : null}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button asChild variant="ghost" size="icon-xs" className="size-7 shrink-0">
            <Link
              to={createIssueDetailPath(issuePathId)}
              state={linkState}
              disableIssueQuicklook
              aria-label="Open full page"
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </Link>
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Open full page</TooltipContent>
      </Tooltip>
    </div>
  );
}

/**
 * Fork (MAG-482): renders the real issue page inside the docked side panel.
 * The page reads its issue from route params, so it gets a synthetic
 * `issues/:issueId` location; its own properties panel and breadcrumbs are
 * sandboxed so they can't replace this panel or retitle the Inbox.
 */
export function InboxIssuePanelView(props: InboxIssuePanelViewProps): ReactNode {
  const { companyPrefix, issuePathId, linkState } = props;
  const headerSlot = usePaneHeaderSlot();
  const { enabled: streamlinedUiEnabled } = useStreamlinedUiEnabled();
  const location = useMemo(
    () => ({
      pathname: `/${companyPrefix}${createIssueDetailPath(issuePathId)}`,
      search: "",
      hash: "",
      state: linkState ?? null,
      key: `inbox-panel:${issuePathId}`,
    }),
    [companyPrefix, issuePathId, linkState],
  );

  return (
    <div data-testid="inbox-issue-panel" className="flex h-full min-h-0 flex-col">
      {headerSlot ? createPortal(<InboxIssuePanelHeader {...props} />, headerSlot) : null}
      <IsolatedPanelProvider>
        <IsolatedBreadcrumbProvider>
          {/* The page expects Layout's <main> gutters (it bleeds into them on the
          legacy shell), so mirror them here or the thread touches the panel edges. */}
          <div
            data-testid="inbox-issue-panel-body"
            className={cn(
              "flex min-h-0 flex-1 flex-col overflow-y-auto p-4 md:p-6",
              streamlinedUiEnabled && "pt-0 md:pt-0",
            )}
          >
            <Routes location={location}>
              <Route path="issues/:issueId" element={<IssueDetail key={issuePathId} />} />
            </Routes>
          </div>
        </IsolatedBreadcrumbProvider>
      </IsolatedPanelProvider>
    </div>
  );
}
