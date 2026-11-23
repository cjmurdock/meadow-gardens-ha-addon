import type { Express, Request, Response, NextFunction } from "express";
import { createServer, type Server } from "http";
import fs from "fs";
import path from "path";
import {
  insertBookingSchema,
  updateBookingSchema,
  upsertSettingSchema,
  updateSessionSchema,
} from "@shared/schema";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const APP_PASSWORD = process.env.APP_PASSWORD;
if (!APP_PASSWORD || !SUPABASE_URL || !SUPABASE_KEY || !process.env.CHRONOGOLF_COOKIES_FILE) {
  throw new Error("Configure APP_PASSWORD, SUPABASE_URL, SUPABASE_KEY and CHRONOGOLF_COOKIES_FILE");
}
const supabaseAuth: Record<string, string> = SUPABASE_KEY.startsWith("sb_") ? {} : { Authorization: `Bearer ${SUPABASE_KEY}` };

// --- Supabase REST helpers ---

async function supabaseGet(table: string, params: Record<string, string> = {}) {
  const url = new URL(`${SUPABASE_URL}/rest/v1/${table}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString(), {
    headers: {
      apikey: SUPABASE_KEY!,
      ...supabaseAuth,
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase GET ${table}: ${res.status} ${text}`);
  }
  return res.json();
}

async function supabasePost(table: string, body: Record<string, unknown>) {
  const url = new URL(`${SUPABASE_URL}/rest/v1/${table}`);
  const res = await fetch(url.toString(), {
    method: "POST",
    headers: {
      apikey: SUPABASE_KEY!,
      ...supabaseAuth,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase POST ${table}: ${res.status} ${text}`);
  }
  return res.json();
}

async function supabasePatch(
  table: string,
  params: Record<string, string>,
  body: Record<string, unknown>
) {
  const url = new URL(`${SUPABASE_URL}/rest/v1/${table}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString(), {
    method: "PATCH",
    headers: {
      apikey: SUPABASE_KEY!,
      ...supabaseAuth,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase PATCH ${table}: ${res.status} ${text}`);
  }
  return res.json();
}

async function supabaseDelete(table: string, params: Record<string, string>) {
  const url = new URL(`${SUPABASE_URL}/rest/v1/${table}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString(), {
    method: "DELETE",
    headers: {
      apikey: SUPABASE_KEY!,
      ...supabaseAuth,
      Prefer: "return=representation",
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase DELETE ${table}: ${res.status} ${text}`);
  }
  return res.json();
}

// --- Auth middleware ---

// Home Assistant Ingress: the Supervisor proxy (172.30.32.2) has already
// authenticated the HA user. Only trusted when INGRESS_TRUST=1 (add-on mode).
function isTrustedIngress(req: Request) {
  if (process.env.INGRESS_TRUST !== "1") return false;
  const ip = (req.socket.remoteAddress || "").replace(/^::ffff:/, "");
  return ip === "172.30.32.2";
}

function authMiddleware(req: Request, res: Response, next: NextFunction) {
  if (isTrustedIngress(req)) return next();
  const password = req.headers["x-app-password"] as string;
  if (!password || password !== APP_PASSWORD) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  // --- Auth ---
  app.post("/api/auth/login", (req, res) => {
    const { password } = req.body;
    if (password === APP_PASSWORD) {
      return res.json({ authenticated: true });
    }
    return res.status(401).json({ error: "Invalid password" });
  });

  app.get("/api/auth/session", (req, res) => {
    res.json({ authenticated: isTrustedIngress(req) });
  });

  // All other API routes require auth
  app.use("/api", (req, res, next) => {
    if (req.path === "/auth/login" || req.path === "/auth/session") return next();
    authMiddleware(req, res, next);
  });

  // --- Queue ---
  app.get("/api/queue", async (_req, res) => {
    try {
      const data = await supabaseGet("booking_queue", {
        "status": "in.(pending,processing)",
        order: "play_date.asc",
      });
      res.json(data);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/queue", async (req, res) => {
    try {
      const parsed = insertBookingSchema.parse(req.body);
      const data = await supabasePost("booking_queue", {
        play_date: parsed.play_date,
        time_window_start: parsed.time_window_start,
        time_window_end: parsed.time_window_end,
        player_count: parsed.player_count,
        notes: parsed.notes || null,
        status: "pending",
      });
      res.json(data);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.patch("/api/queue/:id", async (req, res) => {
    try {
      const parsed = updateBookingSchema.parse(req.body);
      const data = await supabasePatch(
        "booking_queue",
        { id: `eq.${req.params.id}` },
        parsed as Record<string, unknown>
      );
      res.json(data);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.delete("/api/queue/:id", async (req, res) => {
    try {
      // First get the booking to check status
      const rows = await supabaseGet("booking_queue", {
        id: `eq.${req.params.id}`,
      });
      if (!rows || rows.length === 0) {
        return res.status(404).json({ error: "Booking not found" });
      }
      const booking = rows[0];
      if (booking.status !== "pending" && booking.status !== "cancelled") {
        return res
          .status(400)
          .json({ error: "Can only delete pending or cancelled bookings" });
      }
      const data = await supabaseDelete("booking_queue", {
        id: `eq.${req.params.id}`,
      });
      res.json(data);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- History ---
  app.get("/api/history", async (_req, res) => {
    try {
      const data = await supabaseGet("booking_queue", {
        "status": "in.(booked,failed,cancelled)",
        order: "processed_at.desc.nullslast,created_at.desc",
      });
      res.json(data);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Settings ---
  app.get("/api/settings", async (_req, res) => {
    try {
      const data = await supabaseGet("app_settings");
      res.json(data);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.patch("/api/settings", async (req, res) => {
    try {
      const parsed = upsertSettingSchema.parse(req.body);
      // Upsert: try patch, if nothing updated do post
      const url = new URL(`${SUPABASE_URL}/rest/v1/app_settings`);
      url.searchParams.set("key", `eq.${parsed.key}`);
      const patchRes = await fetch(url.toString(), {
        method: "PATCH",
        headers: {
          apikey: SUPABASE_KEY!,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          "Content-Type": "application/json",
          Prefer: "return=representation",
        },
        body: JSON.stringify({
          value: parsed.value,
          updated_at: new Date().toISOString(),
        }),
      });
      const patchData = await patchRes.json();
      if (Array.isArray(patchData) && patchData.length === 0) {
        // Key doesn't exist, insert
        const insertData = await supabasePost("app_settings", {
          key: parsed.key,
          value: parsed.value,
          updated_at: new Date().toISOString(),
        });
        return res.json(insertData);
      }
      res.json(patchData);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Session ---
  app.get("/api/session", async (_req, res) => {
    try {
      const data = await supabaseGet("session_state", {
        id: "eq.1",
      });
      res.json(data?.[0] || null);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.patch("/api/session", async (req, res) => {
    try {
      const parsed = updateSessionSchema.parse(req.body);
      const body: Record<string, unknown> = {
        ...parsed,
        updated_at: new Date().toISOString(),
      };
      const data = await supabasePatch(
        "session_state",
        { id: "eq.1" },
        body
      );
      res.json(data?.[0] || data);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Private session file shared with the worker ---
  const COOKIES_PATH = path.resolve(process.env.CHRONOGOLF_COOKIES_FILE!);

  app.get("/api/cookies/status", async (_req, res) => {
    try {
      const exists = fs.existsSync(COOKIES_PATH);
      if (!exists) return res.json({ exists: false });
      const stat = fs.statSync(COOKIES_PATH);
      const raw = fs.readFileSync(COOKIES_PATH, "utf8");
      const parsed = JSON.parse(raw);
      const cookies = Array.isArray(parsed) ? parsed : parsed.cookies || [];
      // Find the expiry of the soonest-expiring auth cookie
      const authCookies = cookies.filter((c: any) =>
        c.name?.includes("auth") || c.name?.includes("session") || c.name?.includes("token") || c.name?.includes("_cg")
      );
      return res.json({
        exists: true,
        count: cookies.length,
        updated_at: stat.mtime.toISOString(),
        auth_cookie_count: authCookies.length,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/cookies", async (req, res) => {
    try {
      const { cookies } = req.body;
      if (!cookies || typeof cookies !== "string") {
        return res.status(400).json({ error: "cookies field (JSON string) is required" });
      }
      // Accept a JSON cookie export, or a raw "Cookie:" request header copied
      // from the browser's DevTools Network tab ("name=value; name2=value2").
      let parsed: any;
      const text = cookies.trim();
      if (text.startsWith("[") || text.startsWith("{")) {
        parsed = JSON.parse(text);
      } else {
        const header = text.replace(/^cookie:\s*/i, "");
        parsed = header.split(";").map((part) => part.trim()).filter(Boolean).map((part) => {
          const i = part.indexOf("=");
          return i > 0
            ? { name: part.slice(0, i).trim(), value: part.slice(i + 1).trim(), domain: ".chronogolf.com", path: "/", secure: true }
            : null;
        }).filter(Boolean);
      }
      if (!Array.isArray(parsed) && !Array.isArray(parsed?.cookies)) {
        return res.status(400).json({ error: "cookies must be a JSON array" });
      }
      const arr = Array.isArray(parsed) ? parsed : parsed.cookies;
      const allowed = arr.filter((c: any) =>
        typeof c?.name === "string" && typeof c?.value === "string" &&
        /(^|\.)chronogolf\.com$/i.test(c.domain || "") &&
        !/^(cf_|__cf|_cfuvid)/i.test(c.name)
      );
      if (!allowed.length) return res.status(400).json({ error: "No Chronogolf session cookies found" });
      const temp = `${COOKIES_PATH}.${process.pid}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(allowed), { mode: 0o600 });
      fs.renameSync(temp, COOKIES_PATH);
      res.json({ success: true, count: allowed.length });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  return httpServer;
}
