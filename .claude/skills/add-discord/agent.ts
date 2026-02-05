/**
 * Discord Integration - MCP Tool Definitions (Agent/Container Side)
 *
 * These tools run inside the container and communicate with the host via IPC.
 * The host-side implementation is in host.ts.
 *
 * Note: This file is compiled in the container, not on the host.
 * The @ts-ignore is needed because the SDK is only available in the container.
 */

// @ts-ignore - SDK available in container environment only
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';

// IPC directories (inside container)
const IPC_DIR = '/workspace/ipc';
const TASKS_DIR = path.join(IPC_DIR, 'tasks');
const RESULTS_DIR = path.join(IPC_DIR, 'discord_results');

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);
  return filename;
}

async function waitForResult(requestId: string, maxWait = 30000): Promise<{ success: boolean; message: string }> {
  const resultFile = path.join(RESULTS_DIR, `${requestId}.json`);
  const pollInterval = 500;
  let elapsed = 0;

  while (elapsed < maxWait) {
    if (fs.existsSync(resultFile)) {
      try {
        const result = JSON.parse(fs.readFileSync(resultFile, 'utf-8'));
        fs.unlinkSync(resultFile);
        return result;
      } catch (err) {
        return { success: false, message: `Failed to read result: ${err}` };
      }
    }
    await new Promise(resolve => setTimeout(resolve, pollInterval));
    elapsed += pollInterval;
  }

  return { success: false, message: 'Request timed out' };
}

export interface SkillToolsContext {
  groupFolder: string;
  isMain: boolean;
}

/**
 * Create Discord integration MCP tools
 */
export function createDiscordTools(ctx: SkillToolsContext) {
  const { groupFolder, isMain } = ctx;

  return [
    tool(
      'discord_send',
      `Send a message to a Discord channel.

Main group can send to any mapped Discord channel.
Other groups can only send to their own mapped channel.

Discord messages are limited to 2000 characters. Long messages will be automatically split.`,
      {
        channel_id: z.string().describe('The Discord channel ID to send to'),
        text: z.string().describe('The message text to send')
      },
      async (args: { channel_id: string; text: string }) => {
        // Validate channel_id format (Discord snowflake)
        if (!/^\d{17,20}$/.test(args.channel_id)) {
          return {
            content: [{ type: 'text', text: 'Invalid channel ID format. Discord channel IDs are 17-20 digit numbers.' }],
            isError: true
          };
        }

        const requestId = `discord-send-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        writeIpcFile(TASKS_DIR, {
          type: 'discord_send',
          requestId,
          channelId: args.channel_id,
          text: args.text,
          groupFolder,
          isMain,
          timestamp: new Date().toISOString()
        });

        const result = await waitForResult(requestId);
        return {
          content: [{ type: 'text', text: result.message }],
          isError: !result.success
        };
      }
    )
  ];
}
