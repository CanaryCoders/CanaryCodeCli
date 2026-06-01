// auth.ts — "Sign in with ChatGPT" (OpenAI Codex subscription) OAuth.
//
// Reimplements the public Codex CLI OAuth 2.0 + PKCE flow so a user can drive the
// agent with their ChatGPT Plus/Pro subscription instead of a pay-per-token API
// key. The same public PKCE client id the Codex CLI and opencode use is reused;
// there is no secret. Tokens land in ~/.cc/auth.json (chmod 600) — never in
// config.json, which keeps `${VAR}` placeholders and must not hold expanded
// secrets. The Codex provider (provider.ts) consumes a token getter from here.
//
// Flow: PKCE pair → open the browser to auth.openai.com/oauth/authorize → a local
// callback server on 127.0.0.1:1455 catches the redirect's `code` → exchange it
// for {access,refresh,id} tokens → decode the id_token JWT for the ChatGPT
// account id. An SSH/headless fallback prints the URL and reads back the pasted
// redirect URL instead of binding a port.

import { chmod, mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// ── Public Codex PKCE client constants (not secret) ──────────────────────────
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const REDIRECT_PORT = 1455;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/auth/callback`;
const SCOPE = "openid profile email offline_access";
const ORIGINATOR = "codex_cli_rs";
/** Refresh proactively this many ms before the access token actually expires. */
const REFRESH_SKEW_MS = 60_000;
/** How long the local callback server waits for the browser redirect. */
const CALLBACK_TIMEOUT_MS = 5 * 60_000;

/** Persisted credential shape (~/.cc/auth.json). */
export interface AuthCredentials {
  access_token: string;
  refresh_token: string;
  id_token: string;
  account_id: string;
  /** Epoch ms when `access_token` expires (Date.now() + expires_in*1000 at issue). */
  expires_at: number;
}

// ── base64url + PKCE ─────────────────────────────────────────────────────────

/** Base64url-encode raw bytes (no padding) — the encoding OAuth/JWT use. */
function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Decode a base64url string (re-padding it) into a UTF-8 string. */
function base64urlDecode(s: string): string {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad =
    padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  return atob(padded + pad);
}

interface Pkce {
  verifier: string;
  challenge: string;
}

/** A PKCE pair: a random verifier and its S256 challenge (base64url SHA-256). */
async function generatePkce(): Promise<Pkce> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return { verifier, challenge: base64url(new Uint8Array(digest)) };
}

/** A random opaque `state` value (CSRF guard for the callback). */
function randomState(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(16)));
}

/** Build the authorize URL, including the Codex-specific extra parameters. */
function buildAuthorizeUrl(challenge: string, state: string): string {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: SCOPE,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    // These three are what make the issued id_token usable against the Codex
    // backend; the standard OAuth params alone are not enough.
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    originator: ORIGINATOR,
  });
  return `${AUTHORIZE_URL}?${q.toString()}`;
}

// ── JWT account id ─────────────────────────────────────────────────────────

/**
 * Extract the ChatGPT account id from an id_token JWT. The claim lives under the
 * OpenAI-namespaced object; older/edge responses put it at the top level or only
 * carry an organizations list — try each in turn. Returns undefined if absent.
 */
export function accountIdFromIdToken(idToken: string): string | undefined {
  const parts = idToken.split(".");
  if (parts.length < 2) return undefined;
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(base64urlDecode(parts[1]!)) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const auth = payload["https://api.openai.com/auth"] as
    | { chatgpt_account_id?: string }
    | undefined;
  if (auth?.chatgpt_account_id) return auth.chatgpt_account_id;
  if (typeof payload.chatgpt_account_id === "string")
    return payload.chatgpt_account_id;
  const orgs = payload.organizations as Array<{ id?: string }> | undefined;
  return orgs?.[0]?.id;
}

// ── token endpoint ───────────────────────────────────────────────────────────

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
}

/** POST the form-encoded token endpoint and parse the JSON token response. */
async function postToken(form: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `token endpoint ${res.status} ${res.statusText}${text ? ` — ${text}` : ""}`,
    );
  }
  return (await res.json()) as TokenResponse;
}

/** Turn a token response into full credentials (deriving account_id + expiry). */
function credentialsFrom(
  tok: TokenResponse,
  prev?: AuthCredentials,
): AuthCredentials {
  // Refresh responses may omit refresh_token/id_token — carry the prior ones.
  const id_token = tok.id_token ?? prev?.id_token ?? "";
  const account_id =
    (id_token ? accountIdFromIdToken(id_token) : undefined) ??
    prev?.account_id ??
    "";
  const expires_in = tok.expires_in ?? 3600;
  return {
    access_token: tok.access_token,
    refresh_token: tok.refresh_token ?? prev?.refresh_token ?? "",
    id_token,
    account_id,
    expires_at: Date.now() + expires_in * 1000,
  };
}

/** Exchange an authorization `code` (+ PKCE verifier) for credentials. */
async function exchangeCode(
  code: string,
  verifier: string,
): Promise<AuthCredentials> {
  const tok = await postToken({
    grant_type: "authorization_code",
    client_id: CLIENT_ID,
    code,
    code_verifier: verifier,
    redirect_uri: REDIRECT_URI,
  });
  return credentialsFrom(tok);
}

/** Trade a refresh token for a fresh access token (carrying prior fields). */
async function refreshTokens(prev: AuthCredentials): Promise<AuthCredentials> {
  const tok = await postToken({
    grant_type: "refresh_token",
    client_id: CLIENT_ID,
    refresh_token: prev.refresh_token,
  });
  return credentialsFrom(tok, prev);
}

// ── credential store (~/.cc/auth.json) ───────────────────────────────────────

/** Path to the credential file (~/.cc/auth.json). */
function authPath(): string {
  return join(homedir(), ".cc", "auth.json");
}

/** Load stored credentials, or undefined if not signed in / unreadable. */
export async function loadCredentials(
  path: string = authPath(),
): Promise<AuthCredentials | undefined> {
  const file = Bun.file(path);
  if (!(await file.exists())) return undefined;
  try {
    return (await file.json()) as AuthCredentials;
  } catch {
    return undefined;
  }
}

/** Persist credentials, creating the dir and locking the file to the owner (600). */
export async function saveCredentials(
  creds: AuthCredentials,
  path: string = authPath(),
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, `${JSON.stringify(creds, null, 2)}\n`);
  await chmod(path, 0o600);
}

/** Remove stored credentials (logout). A missing file is fine. */
export async function clearCredentials(
  path: string = authPath(),
): Promise<void> {
  await rm(path, { force: true });
}

/** Whether credentials exist on disk (used to gate the Codex preset's models). */
export async function hasCredentials(
  path: string = authPath(),
): Promise<boolean> {
  return await Bun.file(path).exists();
}

// ── local callback server ─────────────────────────────────────────────────────

const SUCCESS_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>cc — signed in</title></head><body style="font-family:system-ui;text-align:center;padding-top:4rem"><h2>✓ Signed in to ChatGPT</h2><p>You can close this tab and return to your terminal.</p></body></html>`;

interface CallbackResult {
  code: string;
  state: string;
}

/**
 * Bind 127.0.0.1:1455 and resolve with the `code` from the OAuth redirect. The
 * `state` is validated against what we sent (CSRF guard). Rejects on timeout or a
 * state mismatch; always stops the server before settling.
 */
function waitForCallback(
  expectedState: string,
  signal?: AbortSignal,
): Promise<CallbackResult> {
  return new Promise<CallbackResult>((resolve, reject) => {
    const server = Bun.serve({
      port: REDIRECT_PORT,
      hostname: "127.0.0.1",
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname !== "/auth/callback") {
          return new Response("not found", { status: 404 });
        }
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        const err = url.searchParams.get("error");
        if (err) {
          finish(() => reject(new Error(`authorization denied: ${err}`)));
          return new Response(`authorization error: ${err}`, { status: 400 });
        }
        if (!code || state !== expectedState) {
          finish(() =>
            reject(new Error("invalid OAuth callback (state mismatch)")),
          );
          return new Response("invalid callback", { status: 400 });
        }
        finish(() => resolve({ code, state }));
        return new Response(SUCCESS_HTML, {
          headers: { "content-type": "text/html" },
        });
      },
    });

    const timer = setTimeout(() => {
      finish(() =>
        reject(new Error("timed out waiting for the browser sign-in")),
      );
    }, CALLBACK_TIMEOUT_MS);

    const onAbort = () => finish(() => reject(new Error("sign-in canceled")));
    signal?.addEventListener("abort", onAbort, { once: true });

    let settled = false;
    // Stop the server and clear the timer exactly once, then run the settle fn on
    // the next tick so the HTTP response flushes to the browser before we exit.
    function finish(settle: () => void): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      setTimeout(() => {
        server.stop(true);
        settle();
      }, 100);
    }
  });
}

// ── browser launch ─────────────────────────────────────────────────────────

/** Open `url` in the default browser. Best-effort and detached; never throws. */
export function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];
  try {
    Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" }).unref();
  } catch {
    // The caller has already printed the URL; a failed auto-open is non-fatal.
  }
}

// ── login orchestrators ──────────────────────────────────────────────────────

export interface LoginResult {
  account_id: string;
}

/**
 * Full browser login: generate PKCE, start the callback server, open the browser
 * (and surface the URL so a remote user can copy it), then exchange the returned
 * code and persist credentials.
 */
export async function loginWithBrowser(
  opts: {
    open?: (url: string) => void;
    onUrl?: (url: string) => void;
    signal?: AbortSignal;
  } = {},
): Promise<LoginResult> {
  const { verifier, challenge } = await generatePkce();
  const state = randomState();
  const url = buildAuthorizeUrl(challenge, state);
  opts.onUrl?.(url);
  // Start listening before opening the browser so a fast redirect isn't missed.
  const pending = waitForCallback(state, opts.signal);
  (opts.open ?? openBrowser)(url);
  const { code } = await pending;
  const creds = await exchangeCode(code, verifier);
  await saveCredentials(creds);
  return { account_id: creds.account_id };
}

/**
 * Headless/SSH login: print the authorize URL and read back the full redirect URL
 * the user was sent to (which carries `code` + `state`). No port binding needed.
 */
export async function loginManual(opts: {
  onUrl: (url: string) => void;
  readLine: () => Promise<string>;
}): Promise<LoginResult> {
  const { verifier, challenge } = await generatePkce();
  const state = randomState();
  opts.onUrl(buildAuthorizeUrl(challenge, state));
  const pasted = (await opts.readLine()).trim();
  let code: string | null;
  let returnedState: string | null;
  try {
    const u = new URL(pasted);
    code = u.searchParams.get("code");
    returnedState = u.searchParams.get("state");
  } catch {
    throw new Error("could not parse the pasted redirect URL");
  }
  if (!code) throw new Error("no `code` in the pasted URL");
  if (returnedState !== state)
    throw new Error("state mismatch in the pasted URL");
  const creds = await exchangeCode(code, verifier);
  await saveCredentials(creds);
  return { account_id: creds.account_id };
}

// ── token getter (consumed by the Codex provider) ────────────────────────────

export interface TokenSnapshot {
  accessToken: string;
  accountId: string;
}

export interface TokenGetter {
  /** Valid token, refreshing proactively if it is at/near expiry. */
  get(): Promise<TokenSnapshot>;
  /** Force a refresh (used on a reactive 401), then return the new token. */
  forceRefresh(): Promise<TokenSnapshot>;
}

/**
 * A lazy token source the provider holds. Loads ~/.cc/auth.json on first use,
 * refreshes (and re-persists) when expired or when forced, and dedupes concurrent
 * refreshes behind a single in-flight promise so parallel sub-agent requests don't
 * each trigger one. Throws a clear "not signed in" error when no credentials exist.
 */
export function makeTokenGetter(path: string = authPath()): TokenGetter {
  let creds: AuthCredentials | undefined;
  let loaded = false;
  let inflight: Promise<AuthCredentials> | null = null;

  async function ensureLoaded(): Promise<AuthCredentials> {
    if (!loaded) {
      creds = await loadCredentials(path);
      loaded = true;
    }
    if (!creds) {
      throw new Error("cc: not signed in — run `cc login-codex`");
    }
    return creds;
  }

  async function doRefresh(): Promise<AuthCredentials> {
    const current = await ensureLoaded();
    if (!inflight) {
      inflight = refreshTokens(current)
        .then(async (next) => {
          creds = next;
          await saveCredentials(next, path);
          return next;
        })
        .finally(() => {
          inflight = null;
        });
    }
    return inflight;
  }

  function snapshot(c: AuthCredentials): TokenSnapshot {
    return { accessToken: c.access_token, accountId: c.account_id };
  }

  return {
    async get(): Promise<TokenSnapshot> {
      const c = await ensureLoaded();
      if (Date.now() >= c.expires_at - REFRESH_SKEW_MS && c.refresh_token) {
        return snapshot(await doRefresh());
      }
      return snapshot(c);
    },
    async forceRefresh(): Promise<TokenSnapshot> {
      return snapshot(await doRefresh());
    },
  };
}
