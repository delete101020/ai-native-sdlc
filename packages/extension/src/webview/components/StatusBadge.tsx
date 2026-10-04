import {
  Circle,
  CircleCheck,
  CircleDot,
  CircleX,
  Eye,
  Hourglass,
  RefreshCw,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { UiStatus } from '@/lib/types';

const statusConfig: Record<UiStatus, { label: string; className: string; icon: LucideIcon }> = {
  in_progress: {
    label: 'IN PROGRESS',
    className: 'bg-info/15 text-info border-info/30',
    icon: CircleDot,
  },
  done: {
    label: 'DONE',
    className: 'bg-success/15 text-success border-success/30',
    icon: CircleCheck,
  },
  rejected: {
    label: 'REJECTED',
    className: 'bg-destructive/15 text-destructive border-destructive/30',
    icon: CircleX,
  },
  pending: {
    label: 'PENDING',
    className: 'bg-muted text-muted-foreground border-border',
    icon: Circle,
  },
  awaiting_review: {
    label: 'AWAITING REVIEW',
    className: 'bg-warning/15 text-warning border-warning/30',
    icon: Eye,
  },
  awaiting_work: {
    label: 'AWAITING WORK',
    className: 'bg-primary/15 text-primary border-primary/30',
    icon: Hourglass,
  },
  awaiting_update: {
    label: 'AWAITING UPDATE',
    className: 'bg-warning/15 text-warning border-warning/30',
    icon: RefreshCw,
  },
};

/**
 * `collapsible` folds the badge to its icon when the nearest `@container` is
 * narrower than 28rem — the label is the widest thing in a card header, and
 * the colour plus the icon still say which state it is.
 */
export function StatusBadge({ status, collapsible = false }: { status: UiStatus; collapsible?: boolean }) {
  const config = statusConfig[status];
  const Icon = config.icon;
  return (
    <span
      className={cn(
        'inline-flex items-center rounded px-2 py-0.5 text-[10px] font-bold tracking-wider border',
        collapsible && 'px-1 py-1 @md:px-2 @md:py-0.5',
        config.className,
      )}
      title={collapsible ? config.label : undefined}
    >
      {collapsible ? (
        <>
          <Icon className="h-3 w-3 @md:hidden" aria-label={config.label} />
          <span className="hidden @md:inline">{config.label}</span>
        </>
      ) : (
        config.label
      )}
    </span>
  );
}
