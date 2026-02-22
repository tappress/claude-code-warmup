import type { VercelRequest, VercelResponse } from "@vercel/node";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";

const DEFAULT_WARMUP_MESSAGE =
    "Hello! This is an automated warm-up message to reset my Claude Code rate limit window. Please just say 'Warmed up!' in response.";

/**
 * Send a single warm-up message to the Claude API using a long-lived OAuth token.
 */
async function sendWarmupMessage(
    oauthToken: string,
    message: string
): Promise<string> {
    const response = await fetch(ANTHROPIC_API_URL, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${oauthToken}`,
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

    const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    if (!oauthToken) {
        return res.status(500).json({
            error: "CLAUDE_CODE_OAUTH_TOKEN env var is not set. Run `claude setup-token` to generate a long-lived token.",
        });
    }

    const warmupMessage = process.env.WARMUP_MESSAGE || DEFAULT_WARMUP_MESSAGE;
    const timestamp = new Date().toISOString();

    try {
        const reply = await sendWarmupMessage(oauthToken, warmupMessage);

        console.log(`[warmup] ✓ Success at ${timestamp}. Claude replied: "${reply}"`);

        return res.status(200).json({
            success: true,
            message: "Warmup sent successfully!",
            claudeReply: reply,
            timestamp,
        });
    } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        console.error(`[warmup] ✗ Error at ${timestamp}: ${error}`);
        return res.status(500).json({ success: false, error, timestamp });
    }
}
