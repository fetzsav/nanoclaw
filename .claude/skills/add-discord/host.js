/**
 * Discord Integration Host Handler
 *
 * Initializes Discord client and handles IPC messages from container agents.
 * This runs on the host (macOS) side.
 */
import { Client, GatewayIntentBits, Partials } from 'discord.js';
import fs from 'fs';
import path from 'path';
import pino from 'pino';
const logger = pino({
    level: process.env.LOG_LEVEL || 'info',
    transport: { target: 'pino-pretty', options: { colorize: true } }
});
let discordClient = null;
let channelMappings = [];
function getDataDir() {
    return process.env.NANOCLAW_ROOT
        ? path.join(process.env.NANOCLAW_ROOT, 'data')
        : path.join(process.cwd(), 'data');
}
function loadAuth() {
    const authPath = path.join(getDataDir(), 'discord-auth.json');
    if (!fs.existsSync(authPath)) {
        return null;
    }
    try {
        return JSON.parse(fs.readFileSync(authPath, 'utf-8'));
    }
    catch (err) {
        logger.error({ err, authPath }, 'Failed to load Discord auth');
        return null;
    }
}
function loadChannelMappings() {
    const channelsPath = path.join(getDataDir(), 'discord-channels.json');
    if (!fs.existsSync(channelsPath)) {
        return [];
    }
    try {
        const config = JSON.parse(fs.readFileSync(channelsPath, 'utf-8'));
        return config.mappings || [];
    }
    catch (err) {
        logger.error({ err, channelsPath }, 'Failed to load Discord channel mappings');
        return [];
    }
}
function getMappingForChannel(channelId) {
    return channelMappings.find(m => m.discordChannelId === channelId);
}
function getMappingForGroup(groupFolder) {
    return channelMappings.find(m => m.nanoClawGroup === groupFolder);
}
/**
 * Check if a message should trigger the agent
 */
function shouldTrigger(message, mapping) {
    // Main channel responds to all messages
    if (mapping.isMain) {
        return true;
    }
    // Other channels require @mention
    if (!discordClient?.user) {
        return false;
    }
    return message.mentions.has(discordClient.user.id);
}
/**
 * Extract clean content from message (remove bot mention if present)
 */
function getCleanContent(message) {
    let content = message.content;
    // Remove bot mention from the beginning of the message
    if (discordClient?.user) {
        const mentionRegex = new RegExp(`^<@!?${discordClient.user.id}>\\s*`, 'i');
        content = content.replace(mentionRegex, '').trim();
    }
    return content;
}
/**
 * Split a long message into chunks that fit Discord's 2000 char limit
 */
function splitMessage(text, maxLength = 2000) {
    if (text.length <= maxLength) {
        return [text];
    }
    const chunks = [];
    let remaining = text;
    while (remaining.length > 0) {
        if (remaining.length <= maxLength) {
            chunks.push(remaining);
            break;
        }
        // Try to split at a newline
        let splitIndex = remaining.lastIndexOf('\n', maxLength);
        if (splitIndex === -1 || splitIndex < maxLength / 2) {
            // Try to split at a space
            splitIndex = remaining.lastIndexOf(' ', maxLength);
        }
        if (splitIndex === -1 || splitIndex < maxLength / 2) {
            // Hard split at maxLength
            splitIndex = maxLength;
        }
        chunks.push(remaining.slice(0, splitIndex));
        remaining = remaining.slice(splitIndex).trimStart();
    }
    return chunks;
}
/**
 * Send a message to a Discord channel, splitting if necessary
 */
async function sendToChannel(channelId, text) {
    if (!discordClient) {
        logger.error('Discord client not initialized');
        return false;
    }
    try {
        const channel = await discordClient.channels.fetch(channelId);
        if (!channel || !channel.isTextBased()) {
            logger.error({ channelId }, 'Channel not found or not a text channel');
            return false;
        }
        const textChannel = channel;
        const chunks = splitMessage(text);
        for (const chunk of chunks) {
            await textChannel.send(chunk);
        }
        logger.info({ channelId, chunks: chunks.length }, 'Discord message sent');
        return true;
    }
    catch (err) {
        logger.error({ err, channelId }, 'Failed to send Discord message');
        return false;
    }
}
/**
 * Initialize the Discord client and start listening for messages.
 * Silently returns if auth is not configured.
 */
export async function initDiscordClient(config) {
    const auth = loadAuth();
    if (!auth) {
        logger.info('Discord auth not configured, skipping Discord integration');
        return;
    }
    channelMappings = loadChannelMappings();
    if (channelMappings.length === 0) {
        logger.warn('No Discord channel mappings configured');
    }
    logger.info({ mappingCount: channelMappings.length }, 'Initializing Discord client');
    discordClient = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent,
            GatewayIntentBits.DirectMessages,
        ],
        partials: [Partials.Channel], // Required for DMs
    });
    discordClient.on('ready', () => {
        logger.info({ user: discordClient?.user?.tag }, 'Discord bot connected');
    });
    discordClient.on('messageCreate', async (message) => {
        // Ignore messages from bots (including ourselves)
        if (message.author.bot)
            return;
        // Find mapping for this channel
        const mapping = getMappingForChannel(message.channelId);
        if (!mapping) {
            // Not a mapped channel, ignore
            return;
        }
        // Check if this message should trigger the agent
        if (!shouldTrigger(message, mapping)) {
            return;
        }
        const content = getCleanContent(message);
        if (!content) {
            return;
        }
        const senderName = message.member?.displayName || message.author.displayName || message.author.username;
        logger.info({
            channel: message.channelId,
            group: mapping.nanoClawGroup,
            sender: senderName,
            contentLength: content.length,
        }, 'Processing Discord message');
        try {
            // Show typing indicator while processing
            await message.channel.sendTyping();
            // Route to container agent
            const response = await config.onMessage(message.channelId, content, senderName, mapping.nanoClawGroup, mapping.isMain);
            if (response) {
                const chunks = splitMessage(response);
                for (const chunk of chunks) {
                    await message.channel.send(chunk);
                }
            }
        }
        catch (err) {
            logger.error({ err, channelId: message.channelId }, 'Error processing Discord message');
        }
    });
    discordClient.on('error', (err) => {
        logger.error({ err }, 'Discord client error');
    });
    try {
        await discordClient.login(auth.botToken);
    }
    catch (err) {
        logger.error({ err }, 'Failed to login to Discord');
        discordClient = null;
    }
}
/**
 * Write result to IPC results directory for container to read
 */
function writeResult(dataDir, sourceGroup, requestId, result) {
    const resultsDir = path.join(dataDir, 'ipc', sourceGroup, 'discord_results');
    fs.mkdirSync(resultsDir, { recursive: true });
    fs.writeFileSync(path.join(resultsDir, `${requestId}.json`), JSON.stringify(result));
}
/**
 * Handle Discord IPC messages from container agents.
 *
 * @returns true if message was handled, false if not a Discord message
 */
export async function handleDiscordIpc(data, sourceGroup, isMain, dataDir) {
    const type = data.type;
    // Only handle discord_* types
    if (!type?.startsWith('discord_')) {
        return false;
    }
    const requestId = data.requestId;
    if (!requestId) {
        logger.warn({ type }, 'Discord IPC blocked: missing requestId');
        return true;
    }
    logger.info({ type, requestId, sourceGroup }, 'Processing Discord request');
    let result;
    switch (type) {
        case 'discord_send': {
            const channelId = data.channelId;
            const text = data.text;
            if (!channelId || !text) {
                result = { success: false, message: 'Missing channelId or text' };
                break;
            }
            // Authorization: check if this group can send to this channel
            const mapping = getMappingForChannel(channelId);
            if (!mapping) {
                result = { success: false, message: 'Channel not mapped to any group' };
                break;
            }
            // Main group can send to any mapped channel; others only to their own
            if (!isMain && mapping.nanoClawGroup !== sourceGroup) {
                logger.warn({ sourceGroup, targetChannel: channelId }, 'Unauthorized Discord send attempt');
                result = { success: false, message: 'Not authorized to send to this channel' };
                break;
            }
            const success = await sendToChannel(channelId, text);
            result = success
                ? { success: true, message: 'Message sent' }
                : { success: false, message: 'Failed to send message' };
            break;
        }
        default:
            return false;
    }
    writeResult(dataDir, sourceGroup, requestId, result);
    if (result.success) {
        logger.info({ type, requestId }, 'Discord request completed');
    }
    else {
        logger.error({ type, requestId, message: result.message }, 'Discord request failed');
    }
    return true;
}
/**
 * Get the Discord client instance (for testing or direct access)
 */
export function getDiscordClient() {
    return discordClient;
}
/**
 * Reload channel mappings from disk
 */
export function reloadChannelMappings() {
    channelMappings = loadChannelMappings();
    logger.info({ count: channelMappings.length }, 'Discord channel mappings reloaded');
}
//# sourceMappingURL=host.js.map