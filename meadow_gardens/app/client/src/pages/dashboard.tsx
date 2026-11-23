import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Link } from "wouter";
import { PlusCircle, CalendarDays, Users, AlertTriangle, X, Pencil } from "lucide-react";
import { format, parseISO, differenceInDays, isToday, isTomorrow, startOfMonth, endOfMonth } from "date-fns";
import { useToast } from "@/hooks/use-toast";
import type { BookingQueue, SessionState } from "@shared/schema";

function StatusBadge({ status }: { status: BookingQueue["status"] }) {
  const variants: Record<string, string> = {
    pending: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
    processing: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
    booked: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400",
    failed: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
    cancelled: "bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400",
  };
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${variants[status] || ""}`}
      data-testid={`badge-status-${status}`}
    >
      {status}
    </span>
  );
}

function EligibilityCountdown({ playDate }: { playDate: string }) {
  const date = parseISO(playDate);
  const eligibleDate = new Date(date);
  eligibleDate.setDate(eligibleDate.getDate() - 10);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const daysUntilEligible = differenceInDays(eligibleDate, today);

  if (daysUntilEligible <= 0) {
    return (
      <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400">
        Eligible now
      </span>
    );
  }
  if (daysUntilEligible === 1) {
    return (
      <span className="text-xs font-medium text-amber-600 dark:text-amber-400">
        Eligible tomorrow
      </span>
    );
  }
  return (
    <span className="text-xs text-muted-foreground">
      Eligible in {daysUntilEligible} days
    </span>
  );
}

function formatPlayDate(dateStr: string): string {
  try {
    const d = parseISO(dateStr);
    if (isToday(d)) return "Today";
    if (isTomorrow(d)) return "Tomorrow";
    return format(d, "EEE, MMM d");
  } catch {
    return dateStr;
  }
}

export default function DashboardPage() {
  const { toast } = useToast();
  const [editingBooking, setEditingBooking] = useState<BookingQueue | null>(null);
  const [editTimeStart, setEditTimeStart] = useState("");
  const [editTimeEnd, setEditTimeEnd] = useState("");
  const [editPlayerCount, setEditPlayerCount] = useState(2);
  const [editNotes, setEditNotes] = useState("");

  const { data: queue, isLoading: queueLoading } = useQuery<BookingQueue[]>({
    queryKey: ["/api/queue"],
  });

  const { data: session } = useQuery<SessionState | null>({
    queryKey: ["/api/session"],
  });

  const { data: history } = useQuery<BookingQueue[]>({
    queryKey: ["/api/history"],
  });

  const openEdit = (booking: BookingQueue) => {
    setEditingBooking(booking);
    setEditTimeStart(booking.time_window_start);
    setEditTimeEnd(booking.time_window_end);
    setEditPlayerCount(booking.player_count);
    setEditNotes(booking.notes ?? "");
  };

  const editMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: object }) => {
      await apiRequest("PATCH", `/api/queue/${id}`, data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/queue"] });
      setEditingBooking(null);
      toast({ title: "Booking updated" });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to update", description: err.message, variant: "destructive" });
    },
  });

  const cancelMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("PATCH", `/api/queue/${id}`, { status: "cancelled" });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/queue"] });
      queryClient.invalidateQueries({ queryKey: ["/api/history"] });
      toast({ title: "Booking cancelled" });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to cancel", description: err.message, variant: "destructive" });
    },
  });

  const unpauseMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("PATCH", "/api/session", {
        is_paused: false,
        pause_reason: null,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/session"] });
      toast({ title: "Session unpaused" });
    },
  });

  const pendingCount = queue?.filter((b) => b.status === "pending").length ?? 0;
  const now = new Date();
  const bookedThisMonth =
    history?.filter((b) => {
      if (b.status !== "booked" || !b.processed_at) return false;
      const d = parseISO(b.processed_at);
      return d >= startOfMonth(now) && d <= endOfMonth(now);
    }).length ?? 0;

  const nextUp = queue?.find((b) => b.status === "pending");
  const recentActivity = history?.slice(0, 3) ?? [];

  // Session health
  const sessionHealthColor = !session
    ? "bg-gray-400"
    : session.is_paused
      ? "bg-red-500"
      : session.is_healthy
        ? "bg-emerald-500"
        : "bg-amber-500";

  const sessionHealthLabel = !session
    ? "Unknown"
    : session.is_paused
      ? "Paused"
      : session.is_healthy
        ? "Healthy"
        : "Stale";

  return (
    <div className="p-4 md:p-6 space-y-6 max-w-4xl mx-auto">
      {/* Paused banner */}
      {session?.is_paused && (
        <div
          className="flex items-center gap-3 p-3 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800"
          data-testid="banner-paused"
        >
          <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
          <div className="flex-1 text-sm text-amber-800 dark:text-amber-300">
            <span className="font-medium">Session paused</span>
            {session.pause_reason && (
              <span className="ml-1">— {session.pause_reason}</span>
            )}
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => unpauseMutation.mutate()}
            disabled={unpauseMutation.isPending}
            data-testid="button-unpause"
          >
            Unpause
          </Button>
        </div>
      )}

      {/* Header row */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold tracking-tight" data-testid="text-page-title">
            Dashboard
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Manage your upcoming tee times
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5" data-testid="status-session-health">
            <span className={`w-2 h-2 rounded-full ${sessionHealthColor}`} />
            <span className="text-xs text-muted-foreground">{sessionHealthLabel}</span>
          </div>
        </div>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-3 gap-3">
        <Card>
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground uppercase tracking-wider mb-1">
              Pending
            </div>
            <div className="text-2xl font-bold" data-testid="text-pending-count">
              {queueLoading ? <Skeleton className="h-8 w-10" /> : pendingCount}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground uppercase tracking-wider mb-1">
              Booked This Month
            </div>
            <div className="text-2xl font-bold" data-testid="text-booked-count">
              {queueLoading ? <Skeleton className="h-8 w-10" /> : bookedThisMonth}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground uppercase tracking-wider mb-1">
              Next Up
            </div>
            <div className="text-sm font-semibold" data-testid="text-next-up">
              {queueLoading ? (
                <Skeleton className="h-5 w-24" />
              ) : nextUp ? (
                formatPlayDate(nextUp.play_date)
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Queue section */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Queue
          </h2>
          <Link href="/add">
            <Button size="sm" data-testid="button-add-date">
              <PlusCircle className="w-4 h-4 mr-1.5" />
              Add Date
            </Button>
          </Link>
        </div>

        {queueLoading ? (
          <div className="space-y-2">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-20 w-full rounded-lg" />
            ))}
          </div>
        ) : !queue || queue.length === 0 ? (
          <Card>
            <CardContent className="p-8 text-center" data-testid="text-empty-queue">
              <CalendarDays className="w-10 h-10 text-muted-foreground/40 mx-auto mb-3" />
              <p className="text-sm text-muted-foreground">
                No upcoming bookings — add a date to get started
              </p>
              <Link href="/add">
                <Button size="sm" variant="outline" className="mt-4">
                  <PlusCircle className="w-4 h-4 mr-1.5" />
                  Add Date
                </Button>
              </Link>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-2">
            {queue.map((booking) => (
              <Card key={booking.id} data-testid={`card-booking-${booking.id}`}>
                <CardContent className="p-4">
                  <div className="flex items-start justify-between">
                    <div className="space-y-1.5">
                      <div className="flex items-center gap-2.5">
                        <span className="font-semibold text-sm">
                          {formatPlayDate(booking.play_date)}
                        </span>
                        <StatusBadge status={booking.status} />
                      </div>
                      <div className="flex items-center gap-3 text-xs text-muted-foreground">
                        <span>
                          {booking.time_window_start} – {booking.time_window_end}
                        </span>
                        <span className="flex items-center gap-1">
                          <Users className="w-3 h-3" />
                          {booking.player_count} player{booking.player_count > 1 ? "s" : ""}
                        </span>
                      </div>
                      <EligibilityCountdown playDate={booking.play_date} />
                      {booking.notes && (
                        <p className="text-xs text-muted-foreground italic">
                          {booking.notes}
                        </p>
                      )}
                    </div>
                    {booking.status === "pending" && (
                      <div className="flex items-center gap-1">
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => openEdit(booking)}
                          data-testid={`button-edit-${booking.id}`}
                        >
                          <Pencil className="w-4 h-4" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => cancelMutation.mutate(booking.id)}
                          disabled={cancelMutation.isPending}
                          data-testid={`button-cancel-${booking.id}`}
                        >
                          <X className="w-4 h-4" />
                        </Button>
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* Edit booking dialog */}
      <Dialog open={!!editingBooking} onOpenChange={(open) => !open && setEditingBooking(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Edit Booking — {editingBooking ? formatPlayDate(editingBooking.play_date) : ""}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="edit-time-start">From</Label>
                <Input
                  id="edit-time-start"
                  type="time"
                  value={editTimeStart}
                  onChange={(e) => setEditTimeStart(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="edit-time-end">To</Label>
                <Input
                  id="edit-time-end"
                  type="time"
                  value={editTimeEnd}
                  onChange={(e) => setEditTimeEnd(e.target.value)}
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Players</Label>
              <div className="flex gap-2">
                {[1, 2, 3, 4].map((n) => (
                  <Button
                    key={n}
                    type="button"
                    variant={editPlayerCount === n ? "default" : "outline"}
                    size="sm"
                    className="flex-1"
                    onClick={() => setEditPlayerCount(n)}
                  >
                    {n}
                  </Button>
                ))}
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-notes">Notes (optional)</Label>
              <Input
                id="edit-notes"
                value={editNotes}
                onChange={(e) => setEditNotes(e.target.value)}
                placeholder="Any special requests"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingBooking(null)}>
              Cancel
            </Button>
            <Button
              disabled={editMutation.isPending}
              onClick={() => {
                if (!editingBooking) return;
                editMutation.mutate({
                  id: editingBooking.id,
                  data: {
                    time_window_start: editTimeStart,
                    time_window_end: editTimeEnd,
                    player_count: editPlayerCount,
                    notes: editNotes || null,
                  },
                });
              }}
            >
              {editMutation.isPending ? "Saving..." : "Save Changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Recent activity */}
      {recentActivity.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Recent Activity
          </h2>
          <div className="space-y-2">
            {recentActivity.map((item) => (
              <div
                key={item.id}
                className="flex items-center justify-between py-2.5 px-3 rounded-lg bg-muted/50"
                data-testid={`activity-${item.id}`}
              >
                <div className="flex items-center gap-2.5">
                  <StatusBadge status={item.status} />
                  <span className="text-sm">
                    {formatPlayDate(item.play_date)}
                  </span>
                </div>
                <div className="text-xs text-muted-foreground">
                  {item.booked_time && (
                    <span className="mr-2">{item.booked_time}</span>
                  )}
                  {item.failure_reason && (
                    <span className="text-red-500">{item.failure_reason}</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
