/**
 * Local Agent Runner for NanoClaw
 * Lightweight agent that uses Ollama's OpenAI-compatible API instead of Docker+Claude Code.
 * Supports the same IPC-based tools (send_message, schedule_task, discord_send, etc.)
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR, GROUPS_DIR, loadLocalLlmConfig, type FullLocalLlmConfig } from './config.js';
import { ContainerInput, ContainerOutput } from './container-runner.js';
import { EbayApi } from './ebay-api.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

const MAX_TOOL_ITERATIONS = 10;

// --- OpenAI-compatible API types ---

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, { type: string; description?: string; enum?: string[] }>;
      required?: string[];
    };
  };
}

interface ChatCompletionResponse {
  choices: Array<{
    message: {
      role: 'assistant';
      content: string | null;
      tool_calls?: ToolCall[];
    };
    finish_reason: string;
  }>;
}

// --- IPC file writing (same pattern as ipc-mcp.ts) ---

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);
  return filename;
}

// --- Tool definitions (OpenAI function calling format) ---
// Kept minimal to reduce token usage with hosted LLM APIs

function tool(name: string, description: string, properties: Record<string, { type: string; description?: string; enum?: string[] }>, required?: string[]): ToolDefinition {
  return { type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } };
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function getToolDefinitions(_isMain: boolean): ToolDefinition[] {
  return [
    tool('send_message', 'Send message to current chat', { text: { type: 'string' } }, ['text']),
    tool('read_file', 'Read file from group dir', { path: { type: 'string' } }, ['path']),
    tool('write_file', 'Write file to group dir', { path: { type: 'string' }, content: { type: 'string' } }, ['path', 'content']),
    tool('ebay_search', 'Search eBay listings. Returns top 3 results.', { query: { type: 'string' } }, ['query']),
    tool('ebay_get_item', 'Get eBay item details', { item_id: { type: 'string' } }, ['item_id']),
    tool('ebay_get_orders', 'List recent eBay orders', {}),
    tool('ebay_get_order', 'Get order details', { order_id: { type: 'string' } }, ['order_id']),
    tool('ebay_get_inventory', 'List inventory items', {}),
    tool('ebay_mark_shipped', 'Add tracking to order', { order_id: { type: 'string' }, tracking_number: { type: 'string' }, carrier: { type: 'string' } }, ['order_id', 'tracking_number', 'carrier']),
  ];
}

// --- File path validation ---

const MAX_FILE_SIZE = 100 * 1024; // 100KB

function validateGroupPath(relativePath: string, groupFolder: string): string | { error: string } {
  if (!relativePath || typeof relativePath !== 'string') return { error: 'Path is required' };
  if (path.isAbsolute(relativePath)) return { error: 'Absolute paths are not allowed' };
  if (relativePath.includes('..')) return { error: 'Path traversal (..) is not allowed' };

  const groupDir = path.join(GROUPS_DIR, groupFolder);
  const resolved = path.resolve(groupDir, relativePath);

  // Double-check the resolved path is within the group dir
  if (!resolved.startsWith(groupDir + path.sep) && resolved !== groupDir) {
    return { error: 'Path resolves outside the group directory' };
  }

  return resolved;
}

// --- eBay response summarizers (reduce tokens for LLM) ---

function summarizeSearchResults(raw: unknown): string {
  const data = raw as { total?: number; itemSummaries?: Array<Record<string, unknown>> };
  if (!data.itemSummaries?.length) return 'No results found.';
  const items = data.itemSummaries.map((item: Record<string, unknown>) => {
    const price = item.price as { value?: string; currency?: string } | undefined;
    return {
      id: item.itemId,
      title: item.title,
      price: price ? `${price.value} ${price.currency}` : 'N/A',
      condition: item.condition,
      url: item.itemWebUrl,
    };
  });
  return `Found ${data.total ?? items.length} results:\n${JSON.stringify(items, null, 2)}`;
}

function summarizeItem(raw: unknown): string {
  const item = raw as Record<string, unknown>;
  const price = item.price as { value?: string; currency?: string } | undefined;
  const seller = item.seller as { username?: string; feedbackScore?: number } | undefined;
  return JSON.stringify({
    id: item.itemId, title: item.title,
    price: price ? `${price.value} ${price.currency}` : 'N/A',
    condition: item.condition, description: (item.shortDescription as string)?.slice(0, 200),
    seller: seller ? `${seller.username} (${seller.feedbackScore})` : 'N/A',
    url: item.itemWebUrl,
  }, null, 2);
}

function summarizeOrders(raw: unknown): string {
  const data = raw as { total?: number; orders?: Array<Record<string, unknown>> };
  if (!data.orders?.length) return 'No orders found.';
  const orders = data.orders.map((o: Record<string, unknown>) => {
    const total = o.pricingSummary as { total?: { value?: string; currency?: string } } | undefined;
    return {
      id: o.orderId,
      status: o.orderFulfillmentStatus,
      total: total?.total ? `${total.total.value} ${total.total.currency}` : 'N/A',
      buyer: (o.buyer as Record<string, unknown>)?.username,
      date: o.creationDate,
      items: ((o.lineItems as Array<Record<string, unknown>>) || []).map(
        (li: Record<string, unknown>) => ({
          title: (li.title as string)?.slice(0, 60),
          url: li.legacyItemId ? `https://www.ebay.com/itm/${li.legacyItemId}` : undefined,
        })
      ),
    };
  });
  return `${data.total ?? orders.length} orders:\n${JSON.stringify(orders, null, 2)}`;
}

function summarizeOrder(raw: unknown): string {
  const o = raw as Record<string, unknown>;
  const total = o.pricingSummary as { total?: { value?: string; currency?: string } } | undefined;
  const shipping = o.fulfillmentStartInstructions as Array<{ shippingStep?: { shipTo?: Record<string, unknown> } }> | undefined;
  return JSON.stringify({
    id: o.orderId, status: o.orderFulfillmentStatus,
    total: total?.total ? `${total.total.value} ${total.total.currency}` : 'N/A',
    buyer: (o.buyer as Record<string, unknown>)?.username,
    date: o.creationDate,
    items: ((o.lineItems as Array<Record<string, unknown>>) || []).map((li: Record<string, unknown>) => ({
      title: (li.title as string)?.slice(0, 60), sku: li.sku, quantity: li.quantity,
      url: li.legacyItemId ? `https://www.ebay.com/itm/${li.legacyItemId}` : undefined,
    })),
    shipTo: shipping?.[0]?.shippingStep?.shipTo,
  }, null, 2);
}

function summarizeInventory(raw: unknown, listingUrls?: Record<string, string>): string {
  const data = raw as { total?: number; inventoryItems?: Array<Record<string, unknown>> };
  if (!data.inventoryItems?.length) return 'No inventory items found.';
  const items = data.inventoryItems.map((item: Record<string, unknown>) => {
    const product = item.product as Record<string, unknown> | undefined;
    const avail = item.availability as { shipToLocationAvailability?: { quantity?: number } } | undefined;
    const sku = item.sku as string;
    return {
      sku, title: product?.title,
      quantity: avail?.shipToLocationAvailability?.quantity ?? 'N/A',
      condition: item.condition,
      url: listingUrls?.[sku] || undefined,
    };
  });
  return `${data.total ?? items.length} items:\n${JSON.stringify(items, null, 2)}`;
}

// --- Tool execution ---

let ebayApiInstance: EbayApi | null = null;

function getEbayApi(): EbayApi {
  if (!ebayApiInstance) {
    ebayApiInstance = new EbayApi();
  }
  return ebayApiInstance;
}

async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: { chatJid: string; groupFolder: string; isMain: boolean; ipcDir: string },
): Promise<string> {
  args = args || {};
  const messagesDir = path.join(ctx.ipcDir, 'messages');
  const tasksDir = path.join(ctx.ipcDir, 'tasks');

  switch (name) {
    case 'send_message': {
      const data = {
        type: 'message',
        chatJid: ctx.chatJid,
        text: args.text,
        groupFolder: ctx.groupFolder,
        timestamp: new Date().toISOString(),
      };
      const filename = writeIpcFile(messagesDir, data);
      return `Message queued for delivery (${filename})`;
    }

    case 'schedule_task': {
      const data = {
        type: 'schedule_task',
        prompt: args.prompt,
        schedule_type: args.schedule_type,
        schedule_value: args.schedule_value,
        context_mode: (args.context_mode as string) || 'group',
        groupFolder: ctx.groupFolder,
        chatJid: ctx.chatJid,
        createdBy: ctx.groupFolder,
        timestamp: new Date().toISOString(),
      };
      const filename = writeIpcFile(tasksDir, data);
      return `Task scheduled (${filename}): ${args.schedule_type} - ${args.schedule_value}`;
    }

    case 'list_tasks': {
      const tasksFile = path.join(ctx.ipcDir, 'current_tasks.json');
      try {
        if (!fs.existsSync(tasksFile)) return 'No scheduled tasks found.';
        const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));
        const tasks = ctx.isMain
          ? allTasks
          : allTasks.filter((t: { groupFolder: string }) => t.groupFolder === ctx.groupFolder);
        if (tasks.length === 0) return 'No scheduled tasks found.';
        return tasks.map((t: { id: string; prompt: string; schedule_type: string; schedule_value: string; status: string; next_run: string }) =>
          `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`
        ).join('\n');
      } catch (err) {
        return `Error reading tasks: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    case 'pause_task': {
      const data = { type: 'pause_task', taskId: args.task_id, groupFolder: ctx.groupFolder, isMain: ctx.isMain, timestamp: new Date().toISOString() };
      writeIpcFile(tasksDir, data);
      return `Task ${args.task_id} pause requested.`;
    }

    case 'resume_task': {
      const data = { type: 'resume_task', taskId: args.task_id, groupFolder: ctx.groupFolder, isMain: ctx.isMain, timestamp: new Date().toISOString() };
      writeIpcFile(tasksDir, data);
      return `Task ${args.task_id} resume requested.`;
    }

    case 'cancel_task': {
      const data = { type: 'cancel_task', taskId: args.task_id, groupFolder: ctx.groupFolder, isMain: ctx.isMain, timestamp: new Date().toISOString() };
      writeIpcFile(tasksDir, data);
      return `Task ${args.task_id} cancellation requested.`;
    }

    case 'discord_send': {
      const data = { type: 'discord_send', channelId: args.channel_id, text: args.text, groupFolder: ctx.groupFolder, isMain: ctx.isMain, timestamp: new Date().toISOString() };
      writeIpcFile(tasksDir, data);
      return `Discord message queued for channel ${args.channel_id}`;
    }

    case 'register_group': {
      if (!ctx.isMain) return 'Only the main group can register new groups.';
      const data = { type: 'register_group', jid: args.jid, name: args.name, folder: args.folder, trigger: args.trigger, timestamp: new Date().toISOString() };
      writeIpcFile(tasksDir, data);
      return `Group "${args.name}" registered.`;
    }

    case 'x_post': {
      if (!ctx.isMain) return 'Only the main group can post to X.';
      const data = { type: 'x_post', content: args.content, groupFolder: ctx.groupFolder, isMain: ctx.isMain, timestamp: new Date().toISOString() };
      writeIpcFile(tasksDir, data);
      return `Tweet queued for posting.`;
    }

    case 'read_file': {
      const resolved = validateGroupPath(args.path as string, ctx.groupFolder);
      if (typeof resolved === 'object') return `Error: ${resolved.error}`;
      try {
        if (!fs.existsSync(resolved)) return `File not found: ${args.path}`;
        const content = fs.readFileSync(resolved, 'utf-8');
        return content || '(empty file)';
      } catch (err) {
        return `Error reading file: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    case 'write_file': {
      const resolved = validateGroupPath(args.path as string, ctx.groupFolder);
      if (typeof resolved === 'object') return `Error: ${resolved.error}`;
      const content = String(args.content ?? '');
      if (Buffer.byteLength(content, 'utf-8') > MAX_FILE_SIZE) {
        return `Error: Content exceeds maximum file size of ${MAX_FILE_SIZE / 1024}KB`;
      }
      try {
        fs.mkdirSync(path.dirname(resolved), { recursive: true });
        fs.writeFileSync(resolved, content, 'utf-8');
        return `File written: ${args.path} (${content.length} chars)`;
      } catch (err) {
        return `Error writing file: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    // --- eBay tools ---

    case 'ebay_search': {
      const api = getEbayApi();
      const result = await api.searchItems(args.query as string, {
        categoryId: args.category_id as string | undefined,
        sort: args.sort as string | undefined,
        limit: Math.min(args.limit ? parseInt(args.limit as string, 10) : 3, 3),
      });
      return summarizeSearchResults(result);
    }

    case 'ebay_get_item': {
      const api = getEbayApi();
      const result = await api.getItem(args.item_id as string);
      return summarizeItem(result);
    }

    case 'ebay_get_category_suggestions': {
      const api = getEbayApi();
      const result = await api.getCategorySuggestions(args.query as string);
      return JSON.stringify(result, null, 2);
    }

    case 'ebay_create_listing': {
      const api = getEbayApi();
      const imageUrls = (args.image_urls as string).split(',').map(u => u.trim());
      let aspects: Record<string, string[]> | undefined;
      if (args.aspects) {
        try {
          aspects = JSON.parse(args.aspects as string);
        } catch {
          return 'Error: Invalid JSON in aspects parameter';
        }
      }
      const result = await api.createListing({
        sku: args.sku as string,
        title: args.title as string,
        description: args.description as string,
        condition: args.condition as string,
        price: parseFloat(args.price as string),
        quantity: parseInt(args.quantity as string, 10),
        imageUrls,
        categoryId: args.category_id as string,
        aspects,
      });
      return JSON.stringify(result, null, 2);
    }

    case 'ebay_publish_listing': {
      const api = getEbayApi();
      const result = await api.publishOffer(args.offer_id as string);
      return JSON.stringify(result, null, 2);
    }

    case 'ebay_end_listing': {
      const api = getEbayApi();
      const result = await api.withdrawOffer(args.offer_id as string);
      return JSON.stringify(result, null, 2);
    }

    case 'ebay_update_price_quantity': {
      const api = getEbayApi();
      const sku = args.sku as string;
      // Get current inventory item, update it
      const current = await api.getInventoryItem(sku) as Record<string, unknown>;
      if (args.quantity) {
        const availability = (current.availability as Record<string, unknown>) || {};
        const shipTo = (availability.shipToLocationAvailability as Record<string, unknown>) || {};
        shipTo.quantity = parseInt(args.quantity as string, 10);
        availability.shipToLocationAvailability = shipTo;
        current.availability = availability;
      }
      await api.createInventoryItem(sku, current);
      // Update price on offers if provided
      if (args.price) {
        const offers = await api.getOffers(sku) as { offers?: Array<{ offerId: string }> };
        if (offers.offers) {
          for (const offer of offers.offers) {
            // Re-fetch and update each offer's price - simplified: just log
            logger.info({ offerId: offer.offerId, newPrice: args.price }, 'Price update on offer requires manual update via eBay');
          }
        }
      }
      return `Inventory item ${sku} updated${args.quantity ? ` (quantity: ${args.quantity})` : ''}${args.price ? ` (price update may need manual confirmation)` : ''}`;
    }

    case 'ebay_get_orders': {
      const api = getEbayApi();
      const result = await api.getOrders();
      return summarizeOrders(result);
    }

    case 'ebay_get_order': {
      const api = getEbayApi();
      const result = await api.getOrder(args.order_id as string);
      return summarizeOrder(result);
    }

    case 'ebay_mark_shipped': {
      const api = getEbayApi();
      const result = await api.markShipped(args.order_id as string, {
        trackingNumber: args.tracking_number as string,
        shippingCarrier: args.carrier as string,
      });
      return JSON.stringify(result, null, 2);
    }

    case 'ebay_get_inventory': {
      const api = getEbayApi();
      const result = await api.getInventoryItems(
        args.limit ? parseInt(args.limit as string, 10) : undefined,
        args.offset ? parseInt(args.offset as string, 10) : undefined,
      );
      // Look up listing URLs from offers for each SKU
      const data = result as { inventoryItems?: Array<{ sku: string }> };
      const listingUrls: Record<string, string> = {};
      if (data.inventoryItems) {
        await Promise.all(data.inventoryItems.map(async (item) => {
          try {
            const offers = await api.getOffers(item.sku) as {
              offers?: Array<{ listing?: { listingId?: string } }>;
            };
            const listingId = offers.offers?.[0]?.listing?.listingId;
            if (listingId) {
              listingUrls[item.sku] = `https://www.ebay.com/itm/${listingId}`;
            }
          } catch {
            // Skip — offer lookup may fail for unpublished items
          }
        }));
      }
      return summarizeInventory(result, listingUrls);
    }

    case 'ebay_get_policies': {
      const api = getEbayApi();
      const result = await api.getPolicies(args.type as string);
      return JSON.stringify(result, null, 2);
    }

    default:
      return `Unknown tool: ${name}`;
  }
}

// --- Session persistence ---

interface LocalSession {
  messages: ChatMessage[];
  updatedAt: string;
}

function getSessionDir(groupFolder: string): string {
  return path.join(DATA_DIR, 'sessions-local', groupFolder);
}

function loadSession(groupFolder: string, sessionId?: string): { session: LocalSession; id: string } {
  const dir = getSessionDir(groupFolder);
  if (sessionId) {
    const filePath = path.join(dir, `${sessionId}.json`);
    try {
      if (fs.existsSync(filePath)) {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as LocalSession;
        return { session: data, id: sessionId };
      }
    } catch {
      logger.warn({ sessionId, groupFolder }, 'Failed to load local session, starting fresh');
    }
  }
  const id = `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return { session: { messages: [], updatedAt: new Date().toISOString() }, id };
}

function saveSession(groupFolder: string, sessionId: string, session: LocalSession): void {
  const dir = getSessionDir(groupFolder);
  fs.mkdirSync(dir, { recursive: true });
  session.updatedAt = new Date().toISOString();
  fs.writeFileSync(path.join(dir, `${sessionId}.json`), JSON.stringify(session, null, 2));
}

// --- System prompt ---

function buildSystemPrompt(groupFolder: string, _chatJid: string): string {
  const parts: string[] = [];

  parts.push(`You are Andy, an eBay assistant. You respond in plain text.

CRITICAL RULES:
- Your text reply is sent automatically. Do NOT call send_message to reply — just respond with text.
- Only call tools that are directly relevant to the user's request. Do NOT call unrelated tools.
- Do NOT read MEMORY.md unless the user asks about their saved notes.
- Do NOT write to MEMORY.md unless the user explicitly asks you to remember something.
- When you get tool results, summarize them clearly and stop. Do not keep calling more tools.
- If a tool returns an error, report it to the user and stop. Do not retry with different parameters.
- NEVER fabricate search queries or data the user didn't ask for.`);

  // Load group CLAUDE.md if it exists
  const claudeMdPath = path.join(GROUPS_DIR, groupFolder, 'CLAUDE.md');
  try {
    if (fs.existsSync(claudeMdPath)) {
      const claudeMd = fs.readFileSync(claudeMdPath, 'utf-8');
      parts.push('\n--- Group Instructions ---');
      parts.push(claudeMd);
    }
  } catch {
    // Ignore errors reading CLAUDE.md
  }

  return parts.join('\n');
}

// --- LLM API call with retry ---

const MAX_RETRIES = 2;

async function callOllama(
  config: FullLocalLlmConfig,
  messages: ChatMessage[],
  tools: ToolDefinition[],
): Promise<ChatCompletionResponse> {
  const url = `${config.baseUrl}/chat/completions`;

  const body: Record<string, unknown> = {
    model: config.model,
    messages,
    temperature: config.temperature,
    max_tokens: config.maxTokens,
  };

  if (tools.length > 0) {
    body.tools = tools;
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.apiKey) {
    headers['Authorization'] = `Bearer ${config.apiKey}`;
  }

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), config.timeout);

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timeoutId);
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }

    if (response.ok) {
      return (await response.json()) as ChatCompletionResponse;
    }

    const text = await response.text();

    // Rate limited (429 or 413 on Groq) — wait and retry
    if ((response.status === 429 || response.status === 413) && attempt < MAX_RETRIES) {
      // Parse wait time from error message (e.g. "Please try again in 17.3s")
      const waitMatch = text.match(/try again in (\d+\.?\d*)s/);
      const waitSecs = waitMatch ? parseFloat(waitMatch[1]) : 20;
      logger.info({ attempt, waitSecs }, 'Rate limited, waiting before retry');
      await new Promise(resolve => setTimeout(resolve, waitSecs * 1000 + 1000));
      continue;
    }

    // Not a retryable error — handle normally
    {

      // Handle Groq tool_use_failed: model generated a response but in wrong format
      // Try to salvage the response instead of crashing
      if (response.status === 400 && text.includes('tool_use_failed')) {
        try {
          const errData = JSON.parse(text);
          const failed = errData?.error?.failed_generation || '';

          // Try to parse the failed generation as a tool call and return it properly
          const fnMatch = failed.match(/<function=(\w+)>([\s\S]*?)<\/function>/);
          if (fnMatch) {
            const [, fnName, fnArgs] = fnMatch;
            return {
              choices: [{
                message: {
                  role: 'assistant' as const,
                  content: null,
                  tool_calls: [{
                    id: `call_${Date.now()}`,
                    type: 'function' as const,
                    function: { name: fnName, arguments: fnArgs },
                  }],
                },
                finish_reason: 'tool_calls',
              }],
            };
          }

          // Fallback: extract any text content
          const textMatch = failed.match(/"text"\s*:\s*"([^"]+)"/);
          if (textMatch) {
            return {
              choices: [{
                message: { role: 'assistant' as const, content: textMatch[1] },
                finish_reason: 'stop',
              }],
            };
          }
        } catch {
          // Fall through to normal error
        }
      }

      throw new Error(`LLM API error ${response.status}: ${text}`);
    }
  }

  throw new Error('LLM API: max retries exceeded');
}

// --- Main entry point ---

export async function runLocalAgent(
  group: RegisteredGroup,
  input: ContainerInput,
): Promise<ContainerOutput> {
  const startTime = Date.now();
  ebayApiInstance = null; // Reset per-invocation
  const config = loadLocalLlmConfig(group.localLlmConfig);

  logger.info(
    { group: group.name, model: config.model, baseUrl: config.baseUrl },
    'Running local agent',
  );

  // Ensure IPC directories exist
  const ipcDir = path.join(DATA_DIR, 'ipc', input.groupFolder);
  fs.mkdirSync(path.join(ipcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(ipcDir, 'tasks'), { recursive: true });

  const toolCtx = {
    chatJid: input.chatJid,
    groupFolder: input.groupFolder,
    isMain: input.isMain,
    ipcDir,
  };

  const tools = getToolDefinitions(input.isMain);
  const systemPrompt = buildSystemPrompt(input.groupFolder, input.chatJid);

  // Load or create session
  const { session, id: sessionId } = loadSession(input.groupFolder, input.sessionId);

  // Trim session history to last N messages to maintain conversation context
  const MAX_HISTORY = 20;
  const recentHistory = session.messages.slice(-MAX_HISTORY);

  // Build messages: system + trimmed history + new user message
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    ...recentHistory,
    { role: 'user', content: input.prompt },
  ];

  // Tool call loop with guardrails
  let iterations = 0;
  const toolCallCounts: Record<string, number> = {};
  const MAX_SAME_TOOL = 3; // Max times the same tool can be called per request
  const MAX_SEND_MESSAGES = 2; // Max send_message calls per request

  try {
    while (iterations < MAX_TOOL_ITERATIONS) {
      iterations++;

      const response = await callOllama(config, messages, tools);

      if (!response.choices || response.choices.length === 0) {
        throw new Error('No choices in Ollama response');
      }

      const choice = response.choices[0];
      const assistantMessage = choice.message;

      // Add assistant message to conversation
      messages.push({
        role: 'assistant',
        content: assistantMessage.content,
        tool_calls: assistantMessage.tool_calls,
      });

      // If no tool calls, we're done
      if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
        const result = assistantMessage.content || '';

        // Save session (exclude system prompt)
        session.messages = messages.slice(1);
        saveSession(input.groupFolder, sessionId, session);

        logger.info(
          { group: group.name, iterations, durationMs: Date.now() - startTime },
          'Local agent completed',
        );

        return {
          status: 'success',
          result: result || null,
          newSessionId: sessionId,
        };
      }

      // Execute each tool call with guardrails
      let loopAborted = false;
      for (const toolCall of assistantMessage.tool_calls) {
        const toolName = toolCall.function.name;
        toolCallCounts[toolName] = (toolCallCounts[toolName] || 0) + 1;

        // Guardrail: block repeated tool abuse
        const sendMessageLimit = toolName === 'send_message' ? MAX_SEND_MESSAGES : MAX_SAME_TOOL;
        if (toolCallCounts[toolName] > sendMessageLimit) {
          logger.warn(
            { tool: toolName, count: toolCallCounts[toolName], group: group.name },
            'Tool call limit reached, aborting loop',
          );
          messages.push({
            role: 'tool',
            content: `Tool "${toolName}" has been called too many times. Stop calling tools and respond to the user with what you have.`,
            tool_call_id: toolCall.id,
          });
          loopAborted = true;
          continue;
        }

        let args: Record<string, unknown>;
        try {
          args = JSON.parse(toolCall.function.arguments);
        } catch {
          args = {};
          logger.warn(
            { tool: toolName, rawArgs: toolCall.function.arguments },
            'Failed to parse tool arguments',
          );
        }

        logger.debug(
          { tool: toolName, args },
          'Executing local tool',
        );

        let result: string;
        try {
          result = await executeTool(toolName, args, toolCtx);
        } catch (err) {
          result = `Tool error: ${err instanceof Error ? err.message : String(err)}`;
          logger.error({ tool: toolName, err }, 'Tool execution error');
        }

        // Truncate tool results to stay within token limits
        const MAX_TOOL_RESULT_CHARS = 1200;
        if (result.length > MAX_TOOL_RESULT_CHARS) {
          result = result.slice(0, MAX_TOOL_RESULT_CHARS) + '\n... (truncated)';
        }

        messages.push({
          role: 'tool',
          content: result,
          tool_call_id: toolCall.id,
        });
      }

      // If guardrails triggered, give model one more chance to produce a text response
      if (loopAborted) {
        // Do one final call without tools to force a text response
        const finalResponse = await callOllama(config, messages, []);
        const finalContent = finalResponse.choices?.[0]?.message?.content || '';

        session.messages = messages.slice(1);
        saveSession(input.groupFolder, sessionId, session);

        logger.info(
          { group: group.name, iterations, durationMs: Date.now() - startTime },
          'Local agent completed (guardrail forced text response)',
        );

        return {
          status: 'success',
          result: finalContent || 'Sorry, I had trouble processing that. Please try again.',
          newSessionId: sessionId,
        };
      }
    }

    // Hit max iterations — do one final call without tools to force a summary
    logger.warn(
      { group: group.name, iterations: MAX_TOOL_ITERATIONS },
      'Local agent hit max tool iterations, forcing final response',
    );

    const finalResponse = await callOllama(config, messages, []);
    const finalContent = finalResponse.choices?.[0]?.message?.content || '';

    session.messages = messages.slice(1);
    saveSession(input.groupFolder, sessionId, session);

    return {
      status: 'success',
      result: finalContent || 'I reached my processing limit. Please try again.',
      newSessionId: sessionId,
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error({ group: group.name, err, durationMs: Date.now() - startTime }, 'Local agent error');

    // Provide helpful error messages
    let userError = errorMsg;
    if (errorMsg.includes('ECONNREFUSED') || errorMsg.includes('fetch failed')) {
      userError = 'Cannot connect to Ollama. Is it running? Start with: ollama serve';
    } else if (errorMsg.includes('model') && errorMsg.includes('not found')) {
      userError = `Model "${config.model}" not found. Pull it with: ollama pull ${config.model}`;
    } else if (errorMsg.includes('aborted')) {
      userError = `Request timed out after ${config.timeout}ms. The model may be too slow or overloaded.`;
    }

    return {
      status: 'error',
      result: null,
      error: userError,
    };
  }
}
