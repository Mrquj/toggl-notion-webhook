import { describe, expect, it, vi, afterEach } from "vitest";
import worker, { Env } from "../src/index";

const env: Env = {
  NOTION_TOKEN: "notion-token",
  NOTION_DATA_SOURCE_ID: "data-source-id",
  TOGGL_WEBHOOK_SECRET: "webhook-secret",
  EXPECTED_CALLBACK_URL: "https://example.com/webhook",
  NOTION_TITLE_PROPERTY: "Name",
  NOTION_TOGGL_ID_PROPERTY: "Toggl ID"
};

describe("toggl notion worker", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("responds to health checks", async () => {
    const response = await worker.fetch(new Request("https://example.com/"), env);
    const body = await response.json() as { ok: boolean; webhook: string };

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.webhook).toBe("https://example.com/webhook");
  });

  it("answers Toggl validation ping with validation_code", async () => {
    const body = JSON.stringify({
      payload: "ping",
      validation_code: "abc123",
      url_callback: "https://example.com/webhook"
    });

    const response = await worker.fetch(await signedRequest(body), env);
    const json = await response.json() as { validation_code: string };

    expect(response.status).toBe(200);
    expect(json.validation_code).toBe("abc123");
  });

  it("rejects an invalid Toggl signature", async () => {
    const response = await worker.fetch(
      new Request("https://example.com/webhook", {
        method: "POST",
        headers: { "X-Webhook-Signature-256": "sha256=bad" },
        body: JSON.stringify({ payload: "ping" })
      }),
      env
    );

    expect(response.status).toBe(401);
  });

  it("creates a Notion page for a new time entry", async () => {
    const notionFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (url.endsWith("/v1/data_sources/data-source-id") && method === "GET") {
        return json({
          properties: {
            Name: { id: "title", type: "title" },
            "Toggl ID": { id: "id", type: "number" },
            Start: { id: "start", type: "date" },
            End: { id: "end", type: "date" },
            "Duration Seconds": { id: "duration", type: "number" },
            Project: { id: "project", type: "rich_text" },
            Tags: { id: "tags", type: "multi_select" },
            Billable: { id: "billable", type: "checkbox" },
            Status: { id: "status", type: "select" }
          }
        });
      }

      if (url.endsWith("/v1/data_sources/data-source-id/query") && method === "POST") {
        return json({ results: [] });
      }

      if (url.endsWith("/v1/pages") && method === "POST") {
        const body = JSON.parse(String(init?.body)) as {
          parent: { data_source_id: string };
          properties: Record<string, unknown>;
        };

        expect(body.parent.data_source_id).toBe("data-source-id");
        expect(body.properties["Toggl ID"]).toEqual({ number: 123 });
        expect(body.properties.Name).toEqual({
          title: [{ text: { content: "Write webhook" } }]
        });
        expect(body.properties.Status).toEqual({ select: { name: "Stopped" } });

        return json({ id: "notion-page-id" });
      }

      throw new Error(`Unexpected Notion call: ${method} ${url}`);
    });

    vi.stubGlobal("fetch", notionFetch);

    const body = JSON.stringify({
      event_id: 1,
      metadata: { request_type: "POST" },
      url_callback: "https://example.com/webhook",
      payload: {
        id: 123,
        description: "Write webhook",
        start: "2026-05-24T01:00:00Z",
        stop: "2026-05-24T02:00:00Z",
        duration: 3600,
        project_name: "Automation",
        tags: ["notion"],
        billable: false,
        workspace_id: 456
      }
    });

    const response = await worker.fetch(await signedRequest(body), env);
    const result = await response.json() as { ok: boolean; action: string; page_id: string };

    expect(response.status).toBe(200);
    expect(result).toEqual({
      ok: true,
      action: "created",
      page_id: "notion-page-id",
      toggl_id: 123
    });
  });
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

async function signedRequest(body: string): Promise<Request> {
  return new Request("https://example.com/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Webhook-Signature-256": `sha256=${await sign(body, env.TOGGL_WEBHOOK_SECRET)}`
    },
    body
  });
}

async function sign(body: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  return [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
