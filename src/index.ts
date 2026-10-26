export interface Env {
  NOTION_TOKEN: string;
  TOGGL_WEBHOOK_SECRET: string;
  NOTION_DATA_SOURCE_ID?: string;
  NOTION_DATABASE_ID?: string;
  NOTION_VERSION?: string;
  EXPECTED_CALLBACK_URL?: string;
  NOTION_TITLE_PROPERTY?: string;
  NOTION_TOGGL_ID_PROPERTY?: string;
}

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
type JsonObject = { [key: string]: JsonValue };

interface TogglWebhookEvent {
  event_id?: number;
  created_at?: string;
  creator_id?: number;
  metadata?: {
    request_type?: string;
    action?: string;
    event_user_id?: number;
    [key: string]: unknown;
  };
  payload?: unknown;
  subscription_id?: number;
  timestamp?: string;
  url_callback?: string;
  validation_code?: string;
  action?: string;
  entity?: string;
}

interface TogglTimeEntry {
  id: number;
  description?: string | null;
  start?: string | null;
  stop?: string | null;
  duration?: number | null;
  billable?: boolean | null;
  project_name?: string | null;
  client_name?: string | null;
  task_name?: string | null;
  tags?: string[] | null;
  user_name?: string | null;
  workspace_id?: number | null;
  wid?: number | null;
  at?: string | null;
  server_deleted_at?: string | null;
  deleted_at?: string | null;
}

type NotionPropertyType =
  | "title"
  | "rich_text"
  | "number"
  | "date"
  | "checkbox"
  | "select"
  | "multi_select"
  | "url";

interface NotionSchemaProperty {
  id: string;
  name?: string;
  type: NotionPropertyType | string;
}

interface NotionSchema {
  properties: Record<string, NotionSchemaProperty>;
}

interface NotionPage {
  id: string;
}

interface NotionQueryResponse {
  results?: NotionPage[];
}

type NotionPropertyValue =
  | { title: Array<{ text: { content: string } }> }
  | { rich_text: Array<{ text: { content: string } }> }
  | { number: number | null }
  | { date: { start: string; end?: string | null } | null }
  | { checkbox: boolean }
  | { select: { name: string } | null }
  | { multi_select: Array<{ name: string }> }
  | { url: string | null };

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8"
};

const DEFAULT_NOTION_VERSION_FOR_DATA_SOURCE = "2025-09-03";
const DEFAULT_NOTION_VERSION_FOR_DATABASE = "2022-06-28";

const optionalPropertyNames = {
  start: "Start",
  end: "End",
  durationSeconds: "Duration Seconds",
  project: "Project",
  client: "Client",
  task: "Task",
  tags: "Tags",
  billable: "Billable",
  user: "User",
  workspaceId: "Workspace ID",
  status: "Status",
  lastEvent: "Last Event",
  togglUrl: "Toggl URL"
} as const;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await handleRequest(request, env);
    } catch (error) {
      console.error(error);
      return jsonResponse(
        {
          ok: false,
          error: error instanceof Error ? error.message : "Unknown error"
        },
        500
      );
    }
  }
};

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "GET") {
    return jsonResponse({
      ok: true,
      service: "toggl-notion-worker",
      webhook: `${url.origin}/webhook`
    });
  }

  if (request.method !== "POST") {
    return jsonResponse({ ok: false, error: "Method not allowed" }, 405);
  }

  if (url.pathname !== "/" && url.pathname !== "/webhook") {
    return jsonResponse({ ok: false, error: "Not found" }, 404);
  }

  assertEnv(env, "TOGGL_WEBHOOK_SECRET");
  assertEnv(env, "NOTION_TOKEN");

  const rawBody = await request.text();
  const isSignatureValid = await verifyTogglSignature(
    rawBody,
    request.headers.get("X-Webhook-Signature-256"),
    env.TOGGL_WEBHOOK_SECRET
  );

  if (!isSignatureValid) {
    return jsonResponse({ ok: false, error: "Invalid Toggl signature" }, 401);
  }

  const event = parseJson<TogglWebhookEvent>(rawBody);

  if (env.EXPECTED_CALLBACK_URL && event.url_callback !== env.EXPECTED_CALLBACK_URL) {
    return jsonResponse({ ok: false, error: "Unexpected callback URL" }, 401);
  }

  if (event.payload === "ping") {
    if (event.validation_code) {
      return jsonResponse({ validation_code: event.validation_code });
    }

    return jsonResponse({ ok: true, ping: true });
  }

  const timeEntry = normalizeTimeEntry(event.payload);
  if (!timeEntry) {
    return jsonResponse({ ok: true, ignored: true, reason: "Payload is not a time entry" });
  }

  const action = getAction(event, timeEntry);
  const notion = new NotionClient(env);

  if (action === "deleted") {
    const page = await notion.findPageByTogglId(timeEntry.id);
    if (page) {
      await notion.trashPage(page.id);
      return jsonResponse({ ok: true, action: "trashed", toggl_id: timeEntry.id });
    }

    return jsonResponse({ ok: true, action: "delete_ignored", toggl_id: timeEntry.id });
  }

  const result = await notion.upsertTimeEntry(timeEntry, action, event);
  return jsonResponse({
    ok: true,
    action: result.created ? "created" : "updated",
    page_id: result.pageId,
    toggl_id: timeEntry.id
  });
}

class NotionClient {
  private readonly token: string;
  private readonly target: { type: "data_source"; id: string } | { type: "database"; id: string };
  private readonly version: string;
  private schemaPromise?: Promise<NotionSchema>;

  constructor(private readonly env: Env) {
    this.token = env.NOTION_TOKEN;

    if (env.NOTION_DATA_SOURCE_ID) {
      this.target = { type: "data_source", id: env.NOTION_DATA_SOURCE_ID };
      this.version = env.NOTION_VERSION ?? DEFAULT_NOTION_VERSION_FOR_DATA_SOURCE;
      return;
    }

    if (env.NOTION_DATABASE_ID) {
      this.target = { type: "database", id: env.NOTION_DATABASE_ID };
      this.version = env.NOTION_VERSION ?? DEFAULT_NOTION_VERSION_FOR_DATABASE;
      return;
    }

    throw new Error("Set NOTION_DATA_SOURCE_ID or NOTION_DATABASE_ID");
  }

  async upsertTimeEntry(
    timeEntry: TogglTimeEntry,
    action: string,
    event: TogglWebhookEvent
  ): Promise<{ created: boolean; pageId: string }> {
    const existing = await this.findPageByTogglId(timeEntry.id);
    const properties = await this.buildProperties(timeEntry, action, event);

    if (existing) {
      await this.request(`/v1/pages/${existing.id}`, {
        method: "PATCH",
        body: JSON.stringify({ ...this.pageTrashPatch(false), properties })
      });
      return { created: false, pageId: existing.id };
    }

    const body = {
      parent: this.target.type === "data_source"
        ? { data_source_id: this.target.id }
        : { database_id: this.target.id },
      properties
    };

    const page = await this.request<NotionPage>("/v1/pages", {
      method: "POST",
      body: JSON.stringify(body)
    });

    return { created: true, pageId: page.id };
  }

  async findPageByTogglId(togglId: number): Promise<NotionPage | null> {
    const schema = await this.getSchema();
    const idPropertyName = this.getTogglIdPropertyName(schema);
    const property = schema.properties[idPropertyName];

    if (!property) {
      throw new Error(`Notion property "${idPropertyName}" is required for idempotent sync`);
    }

    const filter = buildTogglIdFilter(idPropertyName, property.type, togglId);
    if (!filter) {
      throw new Error(`Notion property "${idPropertyName}" must be number, rich_text, or title`);
    }

    const endpoint =
      this.target.type === "data_source"
        ? `/v1/data_sources/${this.target.id}/query`
        : `/v1/databases/${this.target.id}/query`;

    const response = await this.request<NotionQueryResponse>(endpoint, {
      method: "POST",
      body: JSON.stringify({ filter, page_size: 1 })
    });

    return response.results?.[0] ?? null;
  }

  async trashPage(pageId: string): Promise<void> {
    await this.request(`/v1/pages/${pageId}`, {
      method: "PATCH",
      body: JSON.stringify(this.pageTrashPatch(true))
    });
  }

  private async buildProperties(
    timeEntry: TogglTimeEntry,
    action: string,
    event: TogglWebhookEvent
  ): Promise<Record<string, NotionPropertyValue>> {
    const schema = await this.getSchema();
    const properties: Record<string, NotionPropertyValue> = {};
    const titlePropertyName = this.getTitlePropertyName(schema);
    const idPropertyName = this.getTogglIdPropertyName(schema);
    const title = timeEntry.description?.trim() || `Toggl #${timeEntry.id}`;
    const status = getStatus(timeEntry, action);

    putProperty(properties, schema, titlePropertyName, "title", titleValue(title));
    putFlexibleIdProperty(properties, schema, idPropertyName, timeEntry.id);
    putProperty(
      properties,
      schema,
      optionalPropertyNames.start,
      "date",
      dateValue(timeEntry.start ?? null)
    );
    putProperty(
      properties,
      schema,
      optionalPropertyNames.end,
      "date",
      dateValue(timeEntry.stop ?? null)
    );
    putProperty(
      properties,
      schema,
      optionalPropertyNames.durationSeconds,
      "number",
      numberValue(getDurationSeconds(timeEntry))
    );
    putProperty(
      properties,
      schema,
      optionalPropertyNames.project,
      "rich_text",
      richTextValue(timeEntry.project_name ?? "")
    );
    putProperty(
      properties,
      schema,
      optionalPropertyNames.client,
      "rich_text",
      richTextValue(timeEntry.client_name ?? "")
    );
    putProperty(
      properties,
      schema,
      optionalPropertyNames.task,
      "rich_text",
      richTextValue(timeEntry.task_name ?? "")
    );
    putProperty(
      properties,
      schema,
      optionalPropertyNames.tags,
      "multi_select",
      multiSelectValue(timeEntry.tags ?? [])
    );
    putProperty(
      properties,
      schema,
      optionalPropertyNames.billable,
      "checkbox",
      checkboxValue(Boolean(timeEntry.billable))
    );
    putProperty(
      properties,
      schema,
      optionalPropertyNames.user,
      "rich_text",
      richTextValue(timeEntry.user_name ?? "")
    );
    putProperty(
      properties,
      schema,
      optionalPropertyNames.workspaceId,
      "number",
      numberValue(timeEntry.workspace_id ?? timeEntry.wid ?? null)
    );
    putProperty(properties, schema, optionalPropertyNames.status, "select", selectValue(status));
    putProperty(
      properties,
      schema,
      optionalPropertyNames.lastEvent,
      "rich_text",
      richTextValue(`${action} / event ${event.event_id ?? "unknown"}`)
    );
    putProperty(
      properties,
      schema,
      optionalPropertyNames.togglUrl,
      "url",
      urlValue(buildTogglUrl(timeEntry))
    );

    return properties;
  }

  private getSchema(): Promise<NotionSchema> {
    this.schemaPromise ??= this.fetchSchema();
    return this.schemaPromise;
  }

  private async fetchSchema(): Promise<NotionSchema> {
    const endpoint =
      this.target.type === "data_source"
        ? `/v1/data_sources/${this.target.id}`
        : `/v1/databases/${this.target.id}`;

    const schema = await this.request<NotionSchema>(endpoint, { method: "GET" });

    if (!schema.properties || typeof schema.properties !== "object") {
      throw new Error("Notion target did not return a property schema");
    }

    return schema;
  }

  private getTitlePropertyName(schema: NotionSchema): string {
    if (this.env.NOTION_TITLE_PROPERTY && schema.properties[this.env.NOTION_TITLE_PROPERTY]) {
      return this.env.NOTION_TITLE_PROPERTY;
    }

    const titleEntry = Object.entries(schema.properties).find(([, property]) => property.type === "title");
    if (!titleEntry) {
      throw new Error("Notion target needs a title property");
    }

    return titleEntry[0];
  }

  private getTogglIdPropertyName(schema: NotionSchema): string {
    const configured = this.env.NOTION_TOGGL_ID_PROPERTY ?? "Toggl ID";
    return schema.properties[configured] ? configured : "Toggl ID";
  }

  private async request<T = unknown>(path: string, init: RequestInit): Promise<T> {
    const response = await fetch(`https://api.notion.com${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
        "notion-version": this.version,
        ...(init.headers ?? {})
      }
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Notion API ${response.status}: ${body}`);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return (await response.json()) as T;
  }

  private pageTrashPatch(trashed: boolean): { in_trash: boolean } | { archived: boolean } {
    return this.target.type === "data_source" ? { in_trash: trashed } : { archived: trashed };
  }
}

export async function verifyTogglSignature(
  rawBody: string,
  signatureHeader: string | null,
  secret: string
): Promise<boolean> {
  if (!signatureHeader?.startsWith("sha256=")) {
    return false;
  }

  const expected = await hmacSha256Hex(secret, rawBody);
  const received = signatureHeader.slice("sha256=".length).toLowerCase();
  return timingSafeEqualHex(received, expected);
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function timingSafeEqualHex(left: string, right: string): boolean {
  if (!/^[0-9a-f]+$/i.test(left) || !/^[0-9a-f]+$/i.test(right)) {
    return false;
  }

  const maxLength = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;

  for (let index = 0; index < maxLength; index += 1) {
    const leftCode = left.charCodeAt(index) || 0;
    const rightCode = right.charCodeAt(index) || 0;
    difference |= leftCode ^ rightCode;
  }

  return difference === 0;
}

function normalizeTimeEntry(payload: unknown): TogglTimeEntry | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }

  const maybeEntry = payload as Partial<TogglTimeEntry>;
  return typeof maybeEntry.id === "number" ? (maybeEntry as TogglTimeEntry) : null;
}

function getAction(event: TogglWebhookEvent, timeEntry: TogglTimeEntry): string {
  if (timeEntry.server_deleted_at || timeEntry.deleted_at) {
    return "deleted";
  }

  const explicitAction = event.action ?? event.metadata?.action;
  if (explicitAction) {
    return explicitAction.toLowerCase();
  }

  switch (event.metadata?.request_type?.toUpperCase()) {
    case "POST":
      return "created";
    case "PUT":
    case "PATCH":
      return "updated";
    case "DELETE":
      return "deleted";
    default:
      return "updated";
  }
}

function getStatus(timeEntry: TogglTimeEntry, action: string): string {
  if (action === "deleted") {
    return "Deleted";
  }

  return timeEntry.stop ? "Stopped" : "Running";
}

function getDurationSeconds(timeEntry: TogglTimeEntry): number | null {
  if (typeof timeEntry.duration === "number" && timeEntry.duration >= 0) {
    return timeEntry.duration;
  }

  if (timeEntry.start && timeEntry.stop) {
    const start = Date.parse(timeEntry.start);
    const stop = Date.parse(timeEntry.stop);
    if (Number.isFinite(start) && Number.isFinite(stop) && stop >= start) {
      return Math.round((stop - start) / 1000);
    }
  }

  return null;
}

function buildTogglUrl(timeEntry: TogglTimeEntry): string | null {
  const workspaceId = timeEntry.workspace_id ?? timeEntry.wid;
  if (!workspaceId) {
    return null;
  }

  return `https://track.toggl.com/${workspaceId}/timer/edit/${timeEntry.id}`;
}

function buildTogglIdFilter(
  propertyName: string,
  propertyType: string,
  togglId: number
): JsonObject | null {
  if (propertyType === "number") {
    return {
      property: propertyName,
      number: { equals: togglId }
    };
  }

  if (propertyType === "rich_text") {
    return {
      property: propertyName,
      rich_text: { equals: String(togglId) }
    };
  }

  if (propertyType === "title") {
    return {
      property: propertyName,
      title: { equals: String(togglId) }
    };
  }

  return null;
}

function putFlexibleIdProperty(
  properties: Record<string, NotionPropertyValue>,
  schema: NotionSchema,
  propertyName: string,
  togglId: number
): void {
  const property = schema.properties[propertyName];

  if (!property) {
    return;
  }

  if (property.type === "number") {
    properties[propertyName] = numberValue(togglId);
  } else if (property.type === "rich_text") {
    properties[propertyName] = richTextValue(String(togglId));
  } else if (property.type === "title") {
    properties[propertyName] = titleValue(String(togglId));
  }
}

function putProperty(
  properties: Record<string, NotionPropertyValue>,
  schema: NotionSchema,
  propertyName: string,
  expectedType: NotionPropertyType,
  value: NotionPropertyValue
): void {
  if (schema.properties[propertyName]?.type === expectedType) {
    properties[propertyName] = value;
  }
}

function titleValue(content: string): NotionPropertyValue {
  return { title: [{ text: { content: truncate(content, 2000) } }] };
}

function richTextValue(content: string): NotionPropertyValue {
  return content
    ? { rich_text: [{ text: { content: truncate(content, 2000) } }] }
    : { rich_text: [] };
}

function numberValue(value: number | null): NotionPropertyValue {
  return { number: value };
}

function dateValue(value: string | null): NotionPropertyValue {
  return { date: value ? { start: value } : null };
}

function checkboxValue(value: boolean): NotionPropertyValue {
  return { checkbox: value };
}

function selectValue(value: string): NotionPropertyValue {
  return { select: value ? { name: truncate(value, 100) } : null };
}

function multiSelectValue(values: string[]): NotionPropertyValue {
  const unique = new Set(
    values
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .map((value) => truncate(value.replaceAll(",", " "), 100))
  );

  return { multi_select: [...unique].map((name) => ({ name })) };
}

function urlValue(value: string | null): NotionPropertyValue {
  return { url: value };
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function parseJson<T>(rawBody: string): T {
  try {
    return JSON.parse(rawBody) as T;
  } catch {
    throw new Error("Request body is not valid JSON");
  }
}

function assertEnv(env: Env, key: keyof Env): void {
  if (!env[key]) {
    throw new Error(`Missing environment variable: ${key}`);
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: JSON_HEADERS
  });
}
