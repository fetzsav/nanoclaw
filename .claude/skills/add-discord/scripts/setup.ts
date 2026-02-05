#!/usr/bin/env npx tsx
/**
 * Discord Integration - Setup Wizard
 * Usage: npx tsx setup.ts
 *
 * Interactive script to configure Discord bot credentials
 */

import * as readline from 'readline';
import fs from 'fs';
import path from 'path';

const DATA_DIR = process.env.NANOCLAW_ROOT
  ? path.join(process.env.NANOCLAW_ROOT, 'data')
  : path.join(process.cwd(), 'data');

const AUTH_PATH = path.join(DATA_DIR, 'discord-auth.json');
const CHANNELS_PATH = path.join(DATA_DIR, 'discord-channels.json');

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function setup(): Promise<void> {
  console.log('=== Discord Integration Setup ===\n');

  // Check if already configured
  if (fs.existsSync(AUTH_PATH)) {
    const existing = JSON.parse(fs.readFileSync(AUTH_PATH, 'utf-8'));
    console.log('Existing configuration found:');
    console.log(`  Application ID: ${existing.applicationId}`);
    console.log(`  Created: ${existing.createdAt}\n`);

    const overwrite = await prompt('Overwrite existing configuration? (y/N): ');
    if (overwrite.toLowerCase() !== 'y') {
      console.log('Setup cancelled.');
      return;
    }
    console.log('');
  }

  console.log('Step 1: Create a Discord Application\n');
  console.log('  1. Go to: https://discord.com/developers/applications');
  console.log('  2. Click "New Application"');
  console.log('  3. Name it (e.g., "NanoClaw")');
  console.log('  4. Click "Create"\n');

  await prompt('Press Enter when you have created the application...');

  console.log('\nStep 2: Configure the Bot\n');
  console.log('  1. In your application, go to the "Bot" section (left sidebar)');
  console.log('  2. Under "Privileged Gateway Intents", enable:');
  console.log('     - MESSAGE CONTENT INTENT (required to read message content)');
  console.log('  3. Click "Save Changes"\n');

  await prompt('Press Enter when you have enabled the intent...');

  console.log('\nStep 3: Get Your Bot Token\n');
  console.log('  1. In the "Bot" section, click "Reset Token" (or "View Token" if first time)');
  console.log('  2. Copy the token (it looks like: MTE2NTk4...)\n');
  console.log('  WARNING: Never share this token! It grants full access to your bot.\n');

  const botToken = await prompt('Paste your bot token: ');

  if (!botToken || botToken.length < 50) {
    console.log('\nError: Invalid token. Bot tokens are typically 70+ characters.');
    console.log('Please run setup again and paste the complete token.');
    process.exit(1);
  }

  console.log('\nStep 4: Get Your Application ID\n');
  console.log('  1. Go to the "General Information" section (left sidebar)');
  console.log('  2. Copy the "Application ID" (a long number)\n');

  const applicationId = await prompt('Paste your Application ID: ');

  if (!applicationId || !/^\d{17,20}$/.test(applicationId)) {
    console.log('\nError: Invalid Application ID. It should be a 17-20 digit number.');
    process.exit(1);
  }

  // Save credentials
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(AUTH_PATH, JSON.stringify({
    botToken,
    applicationId,
    createdAt: new Date().toISOString()
  }, null, 2));

  console.log(`\nCredentials saved to: ${AUTH_PATH}`);

  // Generate invite URL
  const permissions = [
    '2048',    // Send Messages
    '1024',    // View Channels
    '65536',   // Read Message History
  ].reduce((a, b) => (BigInt(a) | BigInt(b)).toString());

  const inviteUrl = `https://discord.com/api/oauth2/authorize?client_id=${applicationId}&permissions=${permissions}&scope=bot`;

  console.log('\n=== Step 5: Invite the Bot to Your Server ===\n');
  console.log('Open this URL in your browser to invite the bot:\n');
  console.log(inviteUrl);
  console.log('\n  1. Select the server where you want to add the bot');
  console.log('  2. Click "Authorize"');
  console.log('  3. Complete the CAPTCHA if prompted\n');

  await prompt('Press Enter when you have invited the bot...');

  // Create example channels config if it doesn't exist
  if (!fs.existsSync(CHANNELS_PATH)) {
    console.log('\n=== Step 6: Configure Channel Mappings ===\n');
    console.log('To get Discord channel IDs:');
    console.log('  1. In Discord, go to User Settings > App Settings > Advanced');
    console.log('  2. Enable "Developer Mode"');
    console.log('  3. Right-click a server and select "Copy Server ID" (this is the Guild ID)');
    console.log('  4. Right-click a channel and select "Copy Channel ID"\n');

    const guildId = await prompt('Enter your Discord Server (Guild) ID: ');
    const channelId = await prompt('Enter the main channel ID to connect: ');

    if (guildId && channelId) {
      fs.writeFileSync(CHANNELS_PATH, JSON.stringify({
        mappings: [
          {
            discordGuildId: guildId,
            discordChannelId: channelId,
            nanoClawGroup: 'main',
            isMain: true
          }
        ]
      }, null, 2));
      console.log(`\nChannel mapping saved to: ${CHANNELS_PATH}`);
    } else {
      console.log('\nSkipped channel mapping. You can configure it later by editing:');
      console.log(`  ${CHANNELS_PATH}`);
    }
  }

  console.log('\n=== Setup Complete! ===\n');
  console.log('Next steps:');
  console.log('  1. Rebuild container: ./container/build.sh');
  console.log('  2. Rebuild host: npm run build');
  console.log('  3. Restart service: launchctl kickstart -k gui/$(id -u)/com.nanoclaw');
  console.log('\nThe bot will connect when NanoClaw starts.');
}

setup().catch(err => {
  console.error('Setup failed:', err.message);
  process.exit(1);
});
