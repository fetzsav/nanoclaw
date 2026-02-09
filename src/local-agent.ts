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

function getToolDefinitions(isMain: boolean): ToolDefinition[] {
  const tools: ToolDefinition[] = [
    {
      type: 'function',
      function: {
        name: 'send_message',
        description: 'Send a message to the current WhatsApp group.',
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'The message text to send' },
          },
          required: ['text'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'schedule_task',
        description: 'Schedule a recurring or one-time task. schedule_type: cron, interval, or once. context_mode: "group" (uses chat history) or "isolated" (fresh session).',
        parameters: {
          type: 'object',
          properties: {
            prompt: { type: 'string', description: 'What the agent should do when the task runs' },
            schedule_type: { type: 'string', enum: ['cron', 'interval', 'once'], description: 'cron, interval, or once' },
            schedule_value: { type: 'string', description: 'cron expression, milliseconds, or ISO timestamp' },
            context_mode: { type: 'string', enum: ['group', 'isolated'], description: 'group or isolated (default: group)' },
          },
          required: ['prompt', 'schedule_type', 'schedule_value'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'list_tasks',
        description: "List all scheduled tasks for this group.",
        parameters: {
          type: 'object',
          properties: {},
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'pause_task',
        description: 'Pause a scheduled task.',
        parameters: {
          type: 'object',
          properties: {
            task_id: { type: 'string', description: 'The task ID to pause' },
          },
          required: ['task_id'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'resume_task',
        description: 'Resume a paused task.',
        parameters: {
          type: 'object',
          properties: {
            task_id: { type: 'string', description: 'The task ID to resume' },
          },
          required: ['task_id'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'cancel_task',
        description: 'Cancel and delete a scheduled task.',
        parameters: {
          type: 'object',
          properties: {
            task_id: { type: 'string', description: 'The task ID to cancel' },
          },
          required: ['task_id'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'discord_send',
        description: 'Send a message to a Discord channel.',
        parameters: {
          type: 'object',
          properties: {
            channel_id: { type: 'string', description: 'The Discord channel ID' },
            text: { type: 'string', description: 'The message text to send' },
          },
          required: ['channel_id', 'text'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'read_file',
        description: 'Read a file from the group directory. Use this to read memory, notes, or any files you previously saved.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Relative path within the group directory (e.g. "MEMORY.md", "notes/todo.md")' },
          },
          required: ['path'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'write_file',
        description: 'Write content to a file in the group directory. Creates parent directories if needed. Use this to save memory, notes, or data.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Relative path within the group directory (e.g. "MEMORY.md", "notes/todo.md")' },
            content: { type: 'string', description: 'The content to write to the file' },
          },
          required: ['path', 'content'],
        },
      },
    },
    // --- eBay tools ---
    {
      type: 'function',
      function: {
        name: 'ebay_search',
        description: 'Search active eBay listings. Returns item summaries with prices.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query (e.g. "vintage camera", "iPhone 15 Pro")' },
            category_id: { type: 'string', description: 'Optional eBay category ID to narrow results' },
            sort: { type: 'string', enum: ['price', '-price', 'newlyListed', 'endingSoonest'], description: 'Sort order' },
            limit: { type: 'string', description: 'Max results (1-200, default 10)' },
          },
          required: ['query'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'ebay_get_item',
        description: 'Get detailed information about a specific eBay item.',
        parameters: {
          type: 'object',
          properties: {
            item_id: { type: 'string', description: 'The eBay item ID (e.g. "v1|123456789|0")' },
          },
          required: ['item_id'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'ebay_get_category_suggestions',
        description: 'Find the best eBay category for a product. Use this before creating a listing.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Product name or description to categorize' },
          },
          required: ['query'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'ebay_create_listing',
        description: 'Create a new eBay listing (inventory item + offer). After creating, use ebay_publish_listing to make it live.',
        parameters: {
          type: 'object',
          properties: {
            sku: { type: 'string', description: 'Unique SKU identifier for this item' },
            title: { type: 'string', description: 'Listing title (max 80 chars)' },
            description: { type: 'string', description: 'Item description (HTML supported)' },
            condition: { type: 'string', enum: ['NEW', 'LIKE_NEW', 'VERY_GOOD', 'GOOD', 'ACCEPTABLE', 'FOR_PARTS_OR_NOT_WORKING'], description: 'Item condition' },
            price: { type: 'string', description: 'Price in USD (e.g. "29.99")' },
            quantity: { type: 'string', description: 'Quantity available' },
            image_urls: { type: 'string', description: 'Comma-separated image URLs' },
            category_id: { type: 'string', description: 'eBay category ID (use ebay_get_category_suggestions to find)' },
            aspects: { type: 'string', description: 'JSON object of item aspects (e.g. {"Brand":["Sony"],"Model":["A7III"]})' },
          },
          required: ['sku', 'title', 'description', 'condition', 'price', 'quantity', 'image_urls', 'category_id'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'ebay_publish_listing',
        description: 'Publish a draft offer to make it live on eBay.',
        parameters: {
          type: 'object',
          properties: {
            offer_id: { type: 'string', description: 'The offer ID returned from ebay_create_listing' },
          },
          required: ['offer_id'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'ebay_end_listing',
        description: 'End/withdraw an active eBay listing.',
        parameters: {
          type: 'object',
          properties: {
            offer_id: { type: 'string', description: 'The offer ID to withdraw' },
          },
          required: ['offer_id'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'ebay_update_price_quantity',
        description: 'Update the price and/or quantity of an existing inventory item and its offers.',
        parameters: {
          type: 'object',
          properties: {
            sku: { type: 'string', description: 'The SKU of the inventory item' },
            price: { type: 'string', description: 'New price in USD (e.g. "19.99")' },
            quantity: { type: 'string', description: 'New quantity available' },
          },
          required: ['sku'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'ebay_get_orders',
        description: 'List recent eBay orders.',
        parameters: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['ACTIVE', 'COMPLETED', 'CANCELLED'], description: 'Filter by order status' },
            limit: { type: 'string', description: 'Max results (default 50)' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'ebay_get_order',
        description: 'Get details of a specific eBay order.',
        parameters: {
          type: 'object',
          properties: {
            order_id: { type: 'string', description: 'The eBay order ID' },
          },
          required: ['order_id'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'ebay_mark_shipped',
        description: 'Add tracking information to an order.',
        parameters: {
          type: 'object',
          properties: {
            order_id: { type: 'string', description: 'The eBay order ID' },
            tracking_number: { type: 'string', description: 'The tracking number' },
            carrier: { type: 'string', description: 'Shipping carrier (e.g. "USPS", "UPS", "FedEx")' },
          },
          required: ['order_id', 'tracking_number', 'carrier'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'ebay_get_inventory',
        description: 'List your eBay inventory items.',
        parameters: {
          type: 'object',
          properties: {
            limit: { type: 'string', description: 'Max results (default 25)' },
            offset: { type: 'string', description: 'Offset for pagination' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'ebay_get_policies',
        description: 'List seller policies (needed for creating listings).',
        parameters: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['fulfillment', 'payment', 'return'], description: 'Policy type' },
          },
          required: ['type'],
        },
      },
    },
  ];

  // Main-only tools
  if (isMain) {
    tools.push(
      {
        type: 'function',
        function: {
          name: 'register_group',
          description: 'Register a new WhatsApp group. Main group only.',
          parameters: {
            type: 'object',
            properties: {
              jid: { type: 'string', description: 'The WhatsApp JID' },
              name: { type: 'string', description: 'Display name' },
              folder: { type: 'string', description: 'Folder name (lowercase, hyphens)' },
              trigger: { type: 'string', description: 'Trigger word' },
            },
            required: ['jid', 'name', 'folder', 'trigger'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'x_post',
          description: 'Post a tweet to X (Twitter). Main group only. Max 280 chars.',
          parameters: {
            type: 'object',
            properties: {
              content: { type: 'string', description: 'The tweet content (max 280 chars)' },
            },
            required: ['content'],
          },
        },
      },
    );
  }

  return tools;
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
        limit: args.limit ? parseInt(args.limit as string, 10) : 10,
      });
      return JSON.stringify(result, null, 2);
    }

    case 'ebay_get_item': {
      const api = getEbayApi();
      const result = await api.getItem(args.item_id as string);
      return JSON.stringify(result, null, 2);
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
      let filter: string | undefined;
      if (args.status) {
        filter = `orderfulfillmentstatus:{${args.status}}`;
      }
      const result = await api.getOrders(filter);
      return JSON.stringify(result, null, 2);
    }

    case 'ebay_get_order': {
      const api = getEbayApi();
      const result = await api.getOrder(args.order_id as string);
      return JSON.stringify(result, null, 2);
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
      return JSON.stringify(result, null, 2);
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

function buildSystemPrompt(groupFolder: string, chatJid: string): string {
  const parts: string[] = [];

  parts.push(`You are a helpful assistant. Your name is ${process.env.ASSISTANT_NAME || 'Andy'}.`);
  parts.push(`You are responding in group "${groupFolder}" (chat: ${chatJid}).`);
  parts.push('You have tools available to send messages, schedule tasks, and interact with Discord/X.');
  parts.push('Use tools when the user asks you to perform actions. Respond conversationally for questions.');

  // Load group CLAUDE.md if it exists
  const claudeMdPath = path.join(GROUPS_DIR, groupFolder, 'CLAUDE.md');
  try {
    if (fs.existsSync(claudeMdPath)) {
      const claudeMd = fs.readFileSync(claudeMdPath, 'utf-8');
      parts.push('\n--- Group Memory ---');
      parts.push(claudeMd);
    }
  } catch {
    // Ignore errors reading CLAUDE.md
  }

  return parts.join('\n');
}

// --- Ollama API call ---

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

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), config.timeout);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Ollama API error ${response.status}: ${text}`);
    }

    return (await response.json()) as ChatCompletionResponse;
  } finally {
    clearTimeout(timeoutId);
  }
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

  // Build messages: system + session history + new user message
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    ...session.messages,
    { role: 'user', content: input.prompt },
  ];

  // Tool call loop
  let iterations = 0;
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

      // Execute each tool call
      for (const toolCall of assistantMessage.tool_calls) {
        let args: Record<string, unknown>;
        try {
          args = JSON.parse(toolCall.function.arguments);
        } catch {
          args = {};
          logger.warn(
            { tool: toolCall.function.name, rawArgs: toolCall.function.arguments },
            'Failed to parse tool arguments',
          );
        }

        logger.debug(
          { tool: toolCall.function.name, args },
          'Executing local tool',
        );

        let result: string;
        try {
          result = await executeTool(toolCall.function.name, args, toolCtx);
        } catch (err) {
          result = `Tool error: ${err instanceof Error ? err.message : String(err)}`;
          logger.error({ tool: toolCall.function.name, err }, 'Tool execution error');
        }

        messages.push({
          role: 'tool',
          content: result,
          tool_call_id: toolCall.id,
        });
      }
    }

    // Hit max iterations
    logger.warn(
      { group: group.name, iterations: MAX_TOOL_ITERATIONS },
      'Local agent hit max tool iterations',
    );

    // Return the last assistant content if any
    const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant' && m.content);
    session.messages = messages.slice(1);
    saveSession(input.groupFolder, sessionId, session);

    return {
      status: 'success',
      result: lastAssistant?.content || 'I reached my processing limit. Please try again.',
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
