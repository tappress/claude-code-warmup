import type { VercelRequest, VercelResponse } from "@vercel/node";
import { kv } from "@vercel/kv";

const OAUTH_TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const CLAUDE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const KV_REFRESH_TOKEN_KEY = "claude_refresh_token";

const DEFAULT_WARMUP_MESSAGE =
    "Hello! This is an automated warm-up message to reset my Claude Code rate limit window. Please just say 'Warmed up!' in response.";

interface TokenResponse {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
}

/**
 * Resolve the refresh token to use.
 * Priority: Vercel KV (persisted/rotated token) → CLAUDE_REFRESH_TOKEN env var (initial seed).
 */
async function resolveRefreshToken(): Promise<string> {
    const stored = await kv.get<string>(KV_REFRESH_TOKEN_KEY);
    if (stored) {
        console.log("[warmup] Using refresh token from KV store.");
        return stored;
    }

    const envToken = process.env.CLAUDE_REFRESH_TOKEN;
    if (!envToken) {
        throw new Error(
            "No refresh token found. Add CLAUDE_REFRESH_TOKEN env var as initial seed — subsequent rotated tokens will be stored in KV automatically."
        );
    }

    console.log("[warmup] KV empty — using CLAUDE_REFRESH_TOKEN env var as initial seed.");
    return envToken;
}

/**
 * Persist a (possibly rotated) refresh token to KV for future runs.
 */
async function persistRefreshToken(token: string): Promise<void> {
    await kv.set(KV_REFRESH_TOKEN_KEY, token);
    console.log("[warmup] Persisted refresh token to KV store.");
}

/**
 * Exchange a refresh token for a fresh access token.
 * Returns both the access token and the (possibly rotated) refresh token.
 */
async function refreshAccessToken(
    refreshToken: string
): Promise<{ accessToken: string; newRefreshToken: string | null }> {
    const params = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: CLAUDE_CLIENT_ID,
    });

    const response = await fetch(OAUTH_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString(),
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(
            `Token refresh failed: ${response.status} ${response.statusText} — ${text}`
        );
    }

    const data = (await response.json()) as TokenResponse;
    return {
        accessToken: data.access_token,
        // null means token was not rotated (keep existing one)
        newRefreshToken: data.refresh_token ?? null,
    };
}

/**
 * Send a single warm-up message to the Claude API.
 * Uses claude-haiku — cheapest model, no magic system prompt needed.
 */
async function sendWarmupMessage(
    accessToken: string,
    message: string
): Promise<string> {
    const response = await fetch(ANTHROPIC_API_URL, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
            "anthropic-version": "2023-06-01",
            "anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
        },
        body: JSON.stringify({
            model: "claude-haiku-4-5-20251001",
            max_tokens: 64,
            messages: [{ role: "user", content: message }],
        }),
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(
            `Anthropic API error: ${response.status} ${response.statusText} — ${text}`
        );
    }

    const data = (await response.json()) as {
        content: Array<{ type: string; text: string }>;
    };

    return data.content.find((b) => b.type === "text")?.text ?? "(no text)";
}

export default async function handler(
    req: VercelRequest,
    res: VercelResponse
) {
    // Only allow Vercel cron invocations.
    // Vercel auto-generates CRON_SECRET and sends it as: Authorization: Bearer <CRON_SECRET>
    const cronSecret = process.env.CRON_SECRET;
    if (!cronSecret || req.headers.authorization !== `Bearer ${cronSecret}`) {
        return res.status(401).json({ error: "Unauthorized" });
    }

    const warmupMessage = process.env.WARMUP_MESSAGE || DEFAULT_WARMUP_MESSAGE;
    const timestamp = new Date().toISOString();


    try {
        // 1. Get the best available refresh token (KV → env var)
        const refreshToken = await resolveRefreshToken();

        // 2. Exchange for access token (may get a rotated refresh token back)
        const { accessToken, newRefreshToken } = await refreshAccessToken(refreshToken);

        // 3. If the refresh token was rotated, persist the new one to KV
        if (newRefreshToken && newRefreshToken !== refreshToken) {
            console.log("[warmup] Refresh token was rotated — persisting new token.");
            await persistRefreshToken(newRefreshToken);
        }

        // 4. Send the warm-up message
        const reply = await sendWarmupMessage(accessToken, warmupMessage);

        console.log(`[warmup] ✓ Success at ${timestamp}. Claude replied: "${reply}"`);

        return res.status(200).json({
            success: true,
            message: "Warmup sent successfully!",
            claudeReply: reply,
            tokenRotated: newRefreshToken !== null && newRefreshToken !== refreshToken,
            timestamp,
        });
    } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        console.error(`[warmup] ✗ Error at ${timestamp}: ${error}`);
        return res.status(500).json({ success: false, error, timestamp });
    }
}
