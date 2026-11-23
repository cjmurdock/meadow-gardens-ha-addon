import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { format, parseISO } from "date-fns";
import {
  CheckCircle,
  XCircle,
  PauseCircle,
  AlertTriangle,
  Cookie,
  Upload,
} from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import type { AppSetting, SessionState } from "@shared/schema";
import { useState, useEffect } from "react";

function SettingInput({
  label,
  settingKey,
  settings,
  type = "text",
}: {
  label: string;
  settingKey: string;
  settings: AppSetting[] | undefined;
  type?: string;
}) {
  const { toast } = useToast();
  const current = settings?.find((s) => s.key === settingKey)?.value ?? "";
  const [value, setValue] = useState(current);

  useEffect(() => {
    setValue(current);
  }, [current]);

  const mutation = useMutation({
    mutationFn: async () => {
      await apiRequest("PATCH", "/api/settings", {
        key: settingKey,
        value,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/settings"] });
      toast({ title: "Setting updated" });
    },
    onError: (err: Error) => {
      toast({
        title: "Failed to update",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  return (
    <div className="space-y-1.5">
      <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
        {label}
      </label>
      <div className="flex gap-2">
        <Input
          type={type}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          data-testid={`input-setting-${settingKey}`}
        />
        <Button
          size="sm"
          variant="outline"
          onClick={() => mutation.mutate()}
          disabled={mutation.isPending || value === current}
          data-testid={`button-save-${settingKey}`}
        >
          Save
        </Button>
      </div>
    </div>
  );
}

function CookieUploadCard() {
  const { toast } = useToast();
  const [cookieText, setCookieText] = useState("");

  const { data: status, refetch } = useQuery<{
    exists: boolean;
    count?: number;
    updated_at?: string;
    auth_cookie_count?: number;
  }>({
    queryKey: ["/api/cookies/status"],
  });

  const uploadMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", "/api/cookies", { cookies: cookieText });
    },
    onSuccess: () => {
      toast({ title: "Cookies saved", description: "The automation will use these on the next run." });
      setCookieText("");
      refetch();
    },
    onError: (err: Error) => {
      toast({ title: "Invalid cookies", description: err.message, variant: "destructive" });
    },
  });

  return (
    <Card>
      <CardContent className="p-5 space-y-4">
        <div className="flex items-center gap-2">
          <Cookie className="w-4 h-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Browser Cookies
          </h2>
        </div>

        <p className="text-xs text-muted-foreground leading-relaxed">
          After signing in and completing any verification yourself, paste your Chronogolf session export below. If the site requests verification again, the booking worker stops.
          In Chrome, open DevTools on <code className="bg-muted px-1 rounded">chronogolf.com</code> while signed in, pick any request in the Network tab,
          and copy the <code className="bg-muted px-1 rounded">cookie</code> request header. A JSON export from a cookie extension also works.
        </p>

        {status?.exists && (
          <div className="flex items-center gap-2 text-xs text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/30 rounded-md px-3 py-2">
            <CheckCircle className="w-3.5 h-3.5 flex-shrink-0" />
            <span>
              {status.count} cookies saved
              {status.updated_at ? ` · updated ${new Date(status.updated_at).toLocaleDateString()}` : ""}
            </span>
          </div>
        )}

        <Textarea
          placeholder='Paste the "cookie:" request header from Chrome DevTools (Network tab), or a JSON cookie export'
          value={cookieText}
          onChange={(e) => setCookieText(e.target.value)}
          className="font-mono text-xs min-h-[100px] resize-y"
          data-testid="input-cookies"
        />

        <Button
          size="sm"
          onClick={() => uploadMutation.mutate()}
          disabled={uploadMutation.isPending || !cookieText.trim()}
          className="w-full"
          data-testid="button-upload-cookies"
        >
          <Upload className="w-3.5 h-3.5 mr-1.5" />
          {uploadMutation.isPending ? "Saving..." : "Save Cookies"}
        </Button>
      </CardContent>
    </Card>
  );
}

export default function SettingsPage() {
  const { toast } = useToast();

  const { data: settings, isLoading: settingsLoading } = useQuery<
    AppSetting[]
  >({
    queryKey: ["/api/settings"],
  });

  const { data: session, isLoading: sessionLoading } =
    useQuery<SessionState | null>({
      queryKey: ["/api/session"],
    });

  const markHealthyMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("PATCH", "/api/session", { is_healthy: true });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/session"] });
      toast({ title: "Session marked healthy" });
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

  return (
    <div className="p-4 md:p-6 max-w-2xl mx-auto space-y-6">
      <div>
        <h1
          className="text-xl font-bold tracking-tight"
          data-testid="text-page-title"
        >
          Settings
        </h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Configure booking defaults and session management
        </p>
      </div>

      {/* Booking Defaults */}
      <Card>
        <CardContent className="p-5 space-y-4">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Booking Defaults
          </h2>
          {settingsLoading ? (
            <div className="space-y-3">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3">
                <SettingInput
                  label="Default Start Time"
                  settingKey="default_time_start"
                  settings={settings}
                  type="time"
                />
                <SettingInput
                  label="Default End Time"
                  settingKey="default_time_end"
                  settings={settings}
                  type="time"
                />
              </div>
              <SettingInput
                label="Default Player Count"
                settingKey="default_player_count"
                settings={settings}
                type="number"
              />
            </>
          )}
        </CardContent>
      </Card>

      {/* Notifications (read-only for now) */}
      <Card>
        <CardContent className="p-5 space-y-4">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Notifications
          </h2>
          {settingsLoading ? (
            <Skeleton className="h-10 w-full" />
          ) : (
            <>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  ntfy Topic
                </label>
                <div className="text-sm text-foreground bg-muted/50 rounded-md px-3 py-2">
                  {settings?.find((s) => s.key === "ntfy_topic")?.value || (
                    <span className="text-muted-foreground">Not configured</span>
                  )}
                </div>
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Email
                </label>
                <div className="text-sm text-foreground bg-muted/50 rounded-md px-3 py-2">
                  {settings?.find((s) => s.key === "email")?.value || (
                    <span className="text-muted-foreground">Not configured</span>
                  )}
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Cookie Upload */}
      <CookieUploadCard />

      {/* Session Management */}
      <Card>
        <CardContent className="p-5 space-y-4">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Session Management
          </h2>
          {sessionLoading ? (
            <Skeleton className="h-20 w-full" />
          ) : session ? (
            <div className="space-y-4">
              {/* Health status */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  {session.is_paused ? (
                    <PauseCircle className="w-5 h-5 text-red-500" />
                  ) : session.is_healthy ? (
                    <CheckCircle className="w-5 h-5 text-emerald-500" />
                  ) : (
                    <AlertTriangle className="w-5 h-5 text-amber-500" />
                  )}
                  <div>
                    <div className="text-sm font-medium">
                      {session.is_paused
                        ? "Paused"
                        : session.is_healthy
                          ? "Healthy"
                          : "Unhealthy"}
                    </div>
                    {session.pause_reason && (
                      <div className="text-xs text-muted-foreground">
                        {session.pause_reason}
                      </div>
                    )}
                  </div>
                </div>
                <div className="flex gap-2">
                  {!session.is_healthy && !session.is_paused && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => markHealthyMutation.mutate()}
                      disabled={markHealthyMutation.isPending}
                      data-testid="button-mark-healthy"
                    >
                      Mark Healthy
                    </Button>
                  )}
                  {session.is_paused && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => unpauseMutation.mutate()}
                      disabled={unpauseMutation.isPending}
                      data-testid="button-settings-unpause"
                    >
                      Unpause
                    </Button>
                  )}
                </div>
              </div>

              {/* Times */}
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <div className="text-xs text-muted-foreground uppercase tracking-wider mb-0.5">
                    Last Login
                  </div>
                  <div data-testid="text-last-login">
                    {session.last_login
                      ? format(parseISO(session.last_login), "MMM d, h:mm a")
                      : "Never"}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground uppercase tracking-wider mb-0.5">
                    Last Failure
                  </div>
                  <div data-testid="text-last-failure">
                    {session.last_failure ? (
                      <span className="text-red-500 dark:text-red-400">
                        {format(
                          parseISO(session.last_failure),
                          "MMM d, h:mm a"
                        )}
                      </span>
                    ) : (
                      "None"
                    )}
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <XCircle className="w-4 h-4" />
              No session data available
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
