import { z } from "zod";

// Types for booking_queue table (exists in Supabase)
export interface BookingQueue {
  id: string;
  play_date: string;
  status: "pending" | "processing" | "booked" | "failed" | "cancelled";
  time_window_start: string;
  time_window_end: string;
  player_count: number;
  notes: string | null;
  created_at: string;
  processed_at: string | null;
  booked_time: string | null;
  booked_ref: string | null;
  failure_reason: string | null;
}

export const insertBookingSchema = z.object({
  play_date: z.string(),
  time_window_start: z.string().default("12:00"),
  time_window_end: z.string().default("14:00"),
  player_count: z.number().min(1).max(4).default(2),
  notes: z.string().nullable().optional(),
});

export type InsertBooking = z.infer<typeof insertBookingSchema>;

export const updateBookingSchema = z.object({
  status: z
    .enum(["pending", "processing", "booked", "failed", "cancelled"])
    .optional(),
  notes: z.string().nullable().optional(),
  time_window_start: z.string().optional(),
  time_window_end: z.string().optional(),
  player_count: z.number().min(1).max(4).optional(),
});

export type UpdateBooking = z.infer<typeof updateBookingSchema>;

// Types for app_settings table
export interface AppSetting {
  key: string;
  value: string;
  updated_at: string;
}

export const upsertSettingSchema = z.object({
  key: z.string(),
  value: z.string(),
});

export type UpsertSetting = z.infer<typeof upsertSettingSchema>;

// Types for session_state table
export interface SessionState {
  id: number;
  is_healthy: boolean;
  is_paused: boolean;
  last_login: string | null;
  last_failure: string | null;
  pause_reason: string | null;
  updated_at: string;
}

export const updateSessionSchema = z.object({
  is_healthy: z.boolean().optional(),
  is_paused: z.boolean().optional(),
  pause_reason: z.string().nullable().optional(),
});

export type UpdateSession = z.infer<typeof updateSessionSchema>;
