# Discord Integration

## Files Created

| File | Purpose |
|------|---------|
| `SKILL.md` | Skill documentation with integration instructions |
| `host.ts` | Host-side Discord client (handles incoming messages, IPC) |
| `agent.ts` | Container-side MCP tool (`discord_send`) |
| `scripts/setup.ts` | Interactive bot setup wizard |

## Files Modified

| File | Change |
|------|--------|
| `src/index.ts` | Added Discord initialization and `handleDiscordIpc` in IPC switch |
| `container/agent-runner/src/ipc-mcp.ts` | Added `createDiscordTools` import |
| `container/Dockerfile` | Added COPY for skill agent files |
| `container/build.sh` | Changed build context to project root for skill access |
| `package.json` | Added `discord.js` dependency |
| `tsconfig.json` | Added skill host.ts files to compilation |

## Setup

```bash
# 1. Run setup wizard
npx tsx .claude/skills/add-discord/scripts/setup.ts

# 2. Rebuild container
./container/build.sh

# 3. Restart service
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

Main channel responds to all messages; others require @mention.

## Standalone Mode

**Discord can run independently of WhatsApp.**

The application now supports running with either channel, both, or neither:

- If no WhatsApp auth exists (`data/store/auth/creds.json`), WhatsApp is skipped
- If no Discord auth exists (`data/discord-auth.json`), Discord is skipped
- Common services (scheduler, IPC watcher) start regardless of channels

### Channel Identifiers

Groups are keyed by their channel identifier:
- WhatsApp: `{jid}@g.us` or `{jid}@s.whatsapp.net`
- Discord: `discord:{channelId}`

### Auto-Registration

When a message arrives on a mapped Discord channel that doesn't have a registered group, NanoClaw auto-registers it as a Discord-native group using the folder name from the channel mapping.

### Running Discord-Only

```bash
# 1. Set up Discord (no WhatsApp auth needed)
npx tsx .claude/skills/add-discord/scripts/setup.ts

# 2. Add channel mapping to data/discord-channels.json
# 3. Rebuild and restart
./container/build.sh
npm run build
npm run dev  # or restart the service
```

The logs will show:
```
No WhatsApp auth found, skipping WhatsApp
Discord bot connected
NanoClaw running { channels: ['discord'] }
```
