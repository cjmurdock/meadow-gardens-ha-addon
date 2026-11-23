import { createContext, useContext, useState, useCallback, useEffect } from "react";
import { setAppPassword, clearAppPassword, queryClient } from "./queryClient";

// Works at "/" and under Home Assistant Ingress ("/api/hassio_ingress/<token>/").
const API_BASE = window.location.pathname.replace(/\/index\.html$/, "").replace(/\/+$/, "");

interface AuthContextType {
  isAuthenticated: boolean;
  login: (password: string) => Promise<boolean>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [isAuthenticated, setIsAuthenticated] = useState(false);

  // Inside Home Assistant the sidebar login already covers this app.
  useEffect(() => {
    fetch(`${API_BASE}/api/auth/session`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d?.authenticated) setIsAuthenticated(true); })
      .catch(() => {});
  }, []);

  const login = useCallback(async (password: string): Promise<boolean> => {
    try {
      const res = await fetch(`${API_BASE}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (res.ok) {
        setAppPassword(password);
        setIsAuthenticated(true);
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }, []);

  const logout = useCallback(() => {
    clearAppPassword();
    setIsAuthenticated(false);
    queryClient.clear();
  }, []);

  return (
    <AuthContext.Provider value={{ isAuthenticated, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
