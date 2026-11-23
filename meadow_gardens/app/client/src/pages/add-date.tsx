import { useState, useEffect } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useLocation } from "wouter";
import { Calendar } from "@/components/ui/calendar";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { format, isBefore, startOfDay } from "date-fns";
import type { BookingQueue } from "@shared/schema";

export default function AddDatePage() {
  const [selectedDate, setSelectedDate] = useState<Date | undefined>(undefined);
  const [timeStart, setTimeStart] = useState("12:00");
  const [timeEnd, setTimeEnd] = useState("14:00");
  const [playerCount, setPlayerCount] = useState(2);
  const [defaultsLoaded, setDefaultsLoaded] = useState(false);
  const [notes, setNotes] = useState("");
  const [, navigate] = useLocation();
  const { toast } = useToast();

  const { data: existingQueue } = useQuery<BookingQueue[]>({
    queryKey: ["/api/queue"],
  });

  // Load defaults from settings
  const { data: settingsRaw } = useQuery<{ key: string; value: string }[]>({
    queryKey: ["/api/settings"],
  });

  useEffect(() => {
    if (settingsRaw && !defaultsLoaded) {
      const s: Record<string, string> = {};
      settingsRaw.forEach(({ key, value }) => { s[key] = value; });
      if (s.default_time_start) setTimeStart(s.default_time_start);
      if (s.default_time_end) setTimeEnd(s.default_time_end);
      if (s.default_player_count) setPlayerCount(parseInt(s.default_player_count, 10));
      setDefaultsLoaded(true);
    }
  }, [settingsRaw, defaultsLoaded]);

  const existingDates = new Set(
    existingQueue?.map((b) => b.play_date) ?? []
  );

  const addMutation = useMutation({
    mutationFn: async () => {
      if (!selectedDate) throw new Error("Select a date");
      const playDate = format(selectedDate, "yyyy-MM-dd");
      await apiRequest("POST", "/api/queue", {
        play_date: playDate,
        time_window_start: timeStart,
        time_window_end: timeEnd,
        player_count: playerCount,
        notes: notes.trim() || null,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/queue"] });
      toast({ title: "Date added to queue" });
      navigate("/dashboard");
    },
    onError: (err: Error) => {
      toast({
        title: "Failed to add date",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  const today = startOfDay(new Date());

  const isDateDisabled = (date: Date) => {
    if (isBefore(date, today)) return true;
    const formatted = format(date, "yyyy-MM-dd");
    return existingDates.has(formatted);
  };

  const canSubmit =
    selectedDate &&
    !isBefore(selectedDate, today) &&
    timeStart &&
    timeEnd &&
    !addMutation.isPending;

  return (
    <div className="p-4 md:p-6 max-w-2xl mx-auto space-y-6">
      <div>
        <h1 className="text-xl font-bold tracking-tight" data-testid="text-page-title">
          Add Date
        </h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Schedule a new tee time booking
        </p>
      </div>

      <div className="grid md:grid-cols-2 gap-6">
        {/* Calendar */}
        <Card>
          <CardContent className="p-4 flex justify-center">
            <Calendar
              mode="single"
              selected={selectedDate}
              onSelect={setSelectedDate}
              disabled={isDateDisabled}
              data-testid="calendar-picker"
            />
          </CardContent>
        </Card>

        {/* Options */}
        <div className="space-y-5">
          {selectedDate && (
            <div
              className="p-3 rounded-lg bg-primary/5 border border-primary/10"
              data-testid="text-selected-date"
            >
              <div className="text-xs text-muted-foreground uppercase tracking-wider mb-0.5">
                Selected Date
              </div>
              <div className="font-semibold text-sm">
                {format(selectedDate, "EEEE, MMMM d, yyyy")}
              </div>
            </div>
          )}

          {/* Time window */}
          <div className="space-y-2">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              Time Window
            </label>
            <div className="flex items-center gap-2">
              <Input
                type="time"
                value={timeStart}
                onChange={(e) => setTimeStart(e.target.value)}
                data-testid="input-time-start"
              />
              <span className="text-muted-foreground text-sm">to</span>
              <Input
                type="time"
                value={timeEnd}
                onChange={(e) => setTimeEnd(e.target.value)}
                data-testid="input-time-end"
              />
            </div>
          </div>

          {/* Player count */}
          <div className="space-y-2">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              Players
            </label>
            <div className="flex gap-2">
              {[1, 2, 3, 4].map((n) => (
                <Button
                  key={n}
                  variant={playerCount === n ? "default" : "outline"}
                  size="sm"
                  onClick={() => setPlayerCount(n)}
                  data-testid={`button-player-${n}`}
                  className="flex-1"
                >
                  {n}
                </Button>
              ))}
            </div>
          </div>

          {/* Notes */}
          <div className="space-y-2">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              Notes (optional)
            </label>
            <Textarea
              placeholder="Any special requests..."
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              data-testid="input-notes"
            />
          </div>

          <Button
            className="w-full"
            onClick={() => addMutation.mutate()}
            disabled={!canSubmit}
            data-testid="button-add-to-queue"
          >
            {addMutation.isPending ? "Adding..." : "Add to Queue"}
          </Button>
        </div>
      </div>
    </div>
  );
}
