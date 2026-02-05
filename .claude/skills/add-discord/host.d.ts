/**
 * Discord Integration Host Handler
 *
 * Initializes Discord client and handles IPC messages from container agents.
 * This runs on the host (macOS) side.
 */
import { Client } from 'discord.js';
interface DiscordClientConfig {
    onMessage: (channelId: string, content: string, senderName: string, groupFolder: string, isMain: boolean) => Promise<string | null>;
}
/**
 * Initialize the Discord client and start listening for messages.
 * Silently returns if auth is not configured.
 */
export declare function initDiscordClient(config: DiscordClientConfig): Promise<void>;
/**
 * Handle Discord IPC messages from container agents.
 *
 * @returns true if message was handled, false if not a Discord message
 */
export declare function handleDiscordIpc(data: Record<string, unknown>, sourceGroup: string, isMain: boolean, dataDir: string): Promise<boolean>;
/**
 * Get the Discord client instance (for testing or direct access)
 */
export declare function getDiscordClient(): Client | null;
/**
 * Reload channel mappings from disk
 */
export declare function reloadChannelMappings(): void;
export {};
//# sourceMappingURL=host.d.ts.map