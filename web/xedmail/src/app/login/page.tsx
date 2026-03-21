// web/xedmail/src/app/login/page.tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";

type Mode = "signin" | "signup" | "magic";

const inputStyle: React.CSSProperties = {
  padding: "10px 14px",
  borderRadius: "0.75rem",
  background: "#0E0E0E",
  border: "1px solid rgba(82,68,57,0.4)",
  color: "#E5E2E1",
  fontSize: 14,
  fontFamily: "'Inter', sans-serif",
  outline: "none",
  width: "100%",
  boxSizing: "border-box",
};

const submitStyle: React.CSSProperties = {
  padding: "10px 16px",
  borderRadius: "0.75rem",
  background: "linear-gradient(135deg, #FFB77B, #C8803F)",
  border: "none",
  color: "#4D2700",
  fontSize: 14,
  fontWeight: 600,
  cursor: "pointer",
  fontFamily: "'Inter', sans-serif",
  width: "100%",
};

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [magicSent, setMagicSent] = useState(false);
  const [loading, setLoading] = useState(false);

  const reset = (m: Mode) => {
    setMode(m);
    setError(null);
    setMagicSent(false);
  };

  const handleGoogle = async () => {
    setError(null);
    setLoading(true);
    try {
      const res = await authClient.signIn.social({ provider: "google", callbackURL: "/" });
      if (res?.error) setError(res.error.message ?? "Google sign-in failed");
    } catch {
      setError("Google sign-in failed");
    } finally {
      setLoading(false);
    }
  };

  const handleEmailPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      if (mode === "signup") {
        const res = await authClient.signUp.email({
          name,
          email,
          password,
          callbackURL: "/",
        });
        if (res.error) { setError(res.error.message ?? "Sign up failed"); return; }
      } else {
        const res = await authClient.signIn.email({
          email,
          password,
          callbackURL: "/",
        });
        if (res.error) { setError(res.error.message ?? "Sign in failed"); return; }
      }
      router.push("/");
    } finally {
      setLoading(false);
    }
  };

  const handleMagicLink = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      // magicLinkClient plugin adds signIn.magicLink at runtime
      const res = await (authClient.signIn as any).magicLink({
        email,
        callbackURL: "/",
      });
      if (res?.error) { setError(res.error.message ?? "Failed to send link"); return; }
      setMagicSent(true);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#131313",
        fontFamily: "'Inter', sans-serif",
        color: "#E5E2E1",
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 400,
          padding: "40px 32px",
          background: "#1C1B1B",
          borderRadius: "1.5rem",
          border: "1px solid rgba(82,68,57,0.3)",
          display: "flex",
          flexDirection: "column",
          gap: 20,
        }}
      >
        <h1
          style={{
            fontFamily: "'Newsreader', serif",
            fontSize: 28,
            fontWeight: 400,
            margin: 0,
          }}
        >
          {mode === "signup" ? "Create account" : "Sign in"}
        </h1>

        {error && (
          <p style={{ color: "#FFB77B", fontSize: 13, margin: 0 }}>{error}</p>
        )}

        <button type="button" onClick={handleGoogle} style={{ ...submitStyle, background: "#2C2B2B", border: "1px solid rgba(82,68,57,0.4)", color: "#E5E2E1", fontWeight: 400 }}>
          Continue with Google
        </button>

        <div style={{ display: "flex", alignItems: "center", gap: 10, color: "rgba(216,195,180,0.4)", fontSize: 12 }}>
          <div style={{ flex: 1, height: 1, background: "rgba(82,68,57,0.3)" }} />
          or
          <div style={{ flex: 1, height: 1, background: "rgba(82,68,57,0.3)" }} />
        </div>

        <div style={{ display: "flex", gap: 6 }}>
          {(["signin", "signup", "magic"] as Mode[]).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => reset(m)}
              style={{
                flex: 1,
                padding: "6px 0",
                borderRadius: "0.5rem",
                background: mode === m ? "rgba(255,183,123,0.12)" : "transparent",
                border: mode === m ? "1px solid rgba(255,183,123,0.3)" : "1px solid rgba(82,68,57,0.3)",
                color: mode === m ? "#FFB77B" : "rgba(216,195,180,0.5)",
                fontSize: 11,
                cursor: "pointer",
                fontFamily: "'Inter', sans-serif",
              }}
            >
              {m === "signin" ? "Sign in" : m === "signup" ? "Sign up" : "Magic link"}
            </button>
          ))}
        </div>

        {(mode === "signin" || mode === "signup") && (
          <form onSubmit={handleEmailPassword} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {mode === "signup" && (
              <input type="text" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} required style={inputStyle} />
            )}
            <input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required style={inputStyle} />
            <input type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} required style={inputStyle} />
            <button type="submit" disabled={loading} style={submitStyle}>
              {loading ? "…" : mode === "signup" ? "Create account" : "Sign in"}
            </button>
          </form>
        )}

        {mode === "magic" && !magicSent && (
          <form onSubmit={handleMagicLink} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required style={inputStyle} />
            <button type="submit" disabled={loading} style={submitStyle}>
              {loading ? "…" : "Email me a sign-in link"}
            </button>
          </form>
        )}

        {magicSent && (
          <p style={{ color: "rgba(216,195,180,0.7)", fontSize: 14, textAlign: "center", margin: 0 }}>
            Check your email — a sign-in link is on the way.
          </p>
        )}
      </div>
    </div>
  );
}
