---
name: add-discord
description: Add Discord as a full message channel alongside WhatsApp. Messages in mapped Discord channels trigger the agent, responses go back to Discord. Use for setup, testing, or troubleshooting Discord functionality.
---

# Discord Integration

Discord as a bidirectional message channel for NanoClaw.

> **Compatibility:** NanoClaw v1.0.0. Directory structure may change in future versions.

## Features

| Feature | Description |
|---------|-------------|
| Incoming messages | Discord channel messages trigger the agent |
| Outgoing messages | Agent can send messages to Discord channels |
| Channel mapping | Map Discord channels to NanoClaw groups |
| Trigger modes | Main channel: all messages; others: @mention required |

## Prerequisites

Before using this skill, ensure:

1. **NanoClaw is installed** - Container system working
2. **Discord bot created** - See Setup section below

Note: WhatsApp is **not required**. Discord can run as the sole channel.

## Quick Start

```bash
# 1. Run setup wizard (creates bot and gets token)
npx tsx .claude/skills/add-discord/scripts/setup.ts

# 2. Rebuild container to include skill
./container/build.sh

# 3. Rebuild host and restart service
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# 4. Add channel mappings to data/discord-channels.json
```

## Setup

### 1. Run Setup Wizard

```bash
npx tsx .claude/skills/add-discord/scripts/setup.ts
```

The wizard will:
1. Guide you to create a Discord application at https://discord.com/developers/applications
2. Create a bot with MESSAGE CONTENT intent enabled
3. Get your bot token
4. Generate an invite URL with required permissions
5. Save credentials to `data/discord-auth.json`

### 2. Configure Channel Mappings

Create or edit `data/discord-channels.json`:

```json
{
  "mappings": [
    {
      "discordGuildId": "123456789012345678",
      "discordChannelId": "987654321098765432",
      "nanoClawGroup": "main",
      "isMain": true
    },
    {
      "discordGuildId": "123456789012345678",
      "discordChannelId": "111222333444555666",
      "nanoClawGroup": "project-alpha",
      "isMain": false
    }
  ]
}
```

To get Discord IDs:
1. Enable Developer Mode in Discord (User Settings > App Settings > Advanced)
2. Right-click server/channel and select "Copy ID"

### 3. Rebuild and Restart

```bash
./container/build.sh
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

## Architecture

```
Discord Bot (discord.js)
       |
       +--[incoming]---> initDiscordClient callback
       |                      |
       |                      v
       |               runContainerAgent()
       |                      |
       |                      v
       |               Container (Linux VM)
       |                      |
       |               IPC message file
       |                      |
       +--[outgoing]<--- processIpcFiles() -> handleDiscordIpc()
```

### File Structure

```
.claude/skills/add-discord/
├── SKILL.md          # This documentation
├── host.ts           # Host-side Discord client and IPC handler
├── agent.ts          # Container-side MCP tool definitions
└── scripts/
    └── setup.ts      # Interactive bot setup wizard
```

### Data Files

| Path | Purpose | Git |
|------|---------|-----|
| `data/discord-auth.json` | Bot token and app ID | Ignored |
| `data/discord-channels.json` | Channel-to-group mappings | Ignored |

## Integration Points

To integrate this skill into NanoClaw, make the following modifications:

---

**1. Host side: `src/index.ts`**

Add import after other local imports:
```typescript
import { initDiscordClient, handleDiscordIpc } from '../.claude/skills/add-discord/host.js';
```

Call Discord init after WhatsApp connects (in connection 'open' handler):
```typescript
// After startIpcWatcher() and startMessageLoop()
initDiscordClient({
  onMessage: async (channelId, content, groupFolder, isMain) => {
    // Route to container agent same as WhatsApp messages
  }
});
```

Modify `processTaskIpc` function's switch statement default case:
```typescript
// Find:
default:
  logger.warn({ type: data.type }, 'Unknown IPC task type');

// Replace with:
default:
  // Try X integration first
  const xHandled = await handleXIpc(data, sourceGroup, isMain, DATA_DIR);
  if (xHandled) break;

  // Try Discord integration
  const discordHandled = await handleDiscordIpc(data, sourceGroup, isMain, DATA_DIR);
  if (discordHandled) break;

  logger.warn({ type: data.type }, 'Unknown IPC task type');
```

---

**2. Container side: `container/agent-runner/src/ipc-mcp.ts`**

Add import after other skill imports:
```typescript
// @ts-ignore - Copied during Docker build from .claude/skills/add-discord/
import { createDiscordTools } from './skills/add-discord/agent.js';
```

Add to the end of tools array (before the closing `]`):
```typescript
    ...createDiscordTools({ groupFolder, isMain })
```

---

**3. Dockerfile: `container/Dockerfile`**

Add COPY line after other skill COPY lines:
```dockerfile
# Copy Discord skill MCP tools
COPY .claude/skills/add-discord/agent.ts ./src/skills/add-discord/
```

---

**4. Dependencies: `package.json`**

Add discord.js:
```bash
npm install discord.js
```

## Usage

### Via WhatsApp (Agent-Initiated)

The agent can send messages to Discord using the `discord_send` tool:

```
@Assistant send a message to the project-alpha Discord channel saying the build is complete
```

### Via Discord (User-Initiated)

Send messages in a mapped Discord channel:

- **Main channel**: Agent responds to all messages
- **Other channels**: Agent responds to messages mentioning @BotName

## Trigger Modes

| Channel Type | Trigger | Example |
|--------------|---------|---------|
| Main (`isMain: true`) | All messages | "What's the weather?" |
| Other (`isMain: false`) | @mention required | "@NanoClaw what's the weather?" |

## Message Limits

Discord has a 2000 character limit per message. Long responses are automatically split.

## Troubleshooting

### Bot Not Responding

1. Check auth file exists:
   ```bash
   cat data/discord-auth.json
   ```

2. Check channel mappings:
   ```bash
   cat data/discord-channels.json
   ```

3. Check logs:
   ```bash
   grep -i discord logs/nanoclaw.log | tail -20
   ```

### Bot Can't Read Messages

Enable MESSAGE CONTENT intent:
1. Go to https://discord.com/developers/applications
2. Select your application
3. Go to Bot settings
4. Enable "Message Content Intent" under Privileged Gateway Intents

### Permission Errors

Ensure bot has these permissions in your server:
- View Channels
- Send Messages
- Read Message History

Re-invite with the URL from setup if needed.

## Security

- `data/discord-auth.json` - Contains bot token (in `.gitignore`)
- Channel mappings control which Discord channels can trigger which groups
- Non-main groups can only send to their mapped channel
- Main group can send to any mapped channel
