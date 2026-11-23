import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Clock } from "lucide-react";
import { format, parseISO } from "date-fns";
import type { BookingQueue } from "@shared/schema";

function StatusBadge({ status }: { status: BookingQueue["status"] }) {
  const variants: Record<string, string> = {
    booked: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400",
    failed: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
    cancelled: "bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400",
  };
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${variants[status] || ""}`}
    >
      {status}
    </span>
  );
}

export default function HistoryPage() {
  const { data: history, isLoading } = useQuery<BookingQueue[]>({
    queryKey: ["/api/history"],
  });

  return (
    <div className="p-4 md:p-6 max-w-4xl mx-auto space-y-6">
      <div>
        <h1 className="text-xl font-bold tracking-tight" data-testid="text-page-title">
          History
        </h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Past booking attempts and results
        </p>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-16 w-full rounded-lg" />
          ))}
        </div>
      ) : !history || history.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center" data-testid="text-empty-history">
            <Clock className="w-10 h-10 text-muted-foreground/40 mx-auto mb-3" />
            <p className="text-sm text-muted-foreground">
              No booking history yet
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {history.map((item) => (
            <Card key={item.id} data-testid={`card-history-${item.id}`}>
              <CardContent className="p-4">
                <div className="flex items-start justify-between">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2.5">
                      <span className="font-semibold text-sm">
                        {format(parseISO(item.play_date), "EEE, MMM d, yyyy")}
                      </span>
                      <StatusBadge status={item.status} />
                    </div>
                    <div className="flex items-center gap-3 text-xs text-muted-foreground">
                      {item.booked_time && (
                        <span>Booked: {item.booked_time}</span>
                      )}
                      {item.booked_ref && (
                        <span>Ref: {item.booked_ref}</span>
                      )}
                      {item.processed_at && (
                        <span>
                          Processed: {format(parseISO(item.processed_at), "MMM d, h:mm a")}
                        </span>
                      )}
                    </div>
                    {item.failure_reason && (
                      <p className="text-xs text-red-500 dark:text-red-400">
                        {item.failure_reason}
                      </p>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
