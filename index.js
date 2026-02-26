const { Client, Permissions } = require('discord.js-selfbot-v13');
const readline = require('readline');
require('dotenv').config();

// Suppress punycode deprecation warning
process.removeAllListeners('warning');

function parsePositiveInt(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isNaN(parsed) || parsed <= 0) {
        return fallback;
    }

    return parsed;
}

const client = new Client();
const HARDCODED_DEFAULT_REJECT_CHANNEL_ID = '1443931988430946324';
const DEFAULT_REJECT_CHANNEL_ID = process.env.DEFAULT_REJECT_CHANNEL_ID || HARDCODED_DEFAULT_REJECT_CHANNEL_ID;
const REJECT_CHANNEL_ID = process.env.REJECT_CHANNEL_ID || DEFAULT_REJECT_CHANNEL_ID;
const DEFAULT_REJECT_DELETE_DELAY_MS = 10000;
const REJECT_DELETE_DELAY_MS = parsePositiveInt(process.env.REJECT_DELETE_DELAY_MS, DEFAULT_REJECT_DELETE_DELAY_MS);
const DEFAULT_RECENTLY_LEFT_DISPLAY_MS = 10000;
const RECENTLY_LEFT_DISPLAY_MS = parsePositiveInt(process.env.RECENTLY_LEFT_DISPLAY_MS, DEFAULT_RECENTLY_LEFT_DISPLAY_MS);
const DEFAULT_VOICE_POLL_INTERVAL_MS = 2000;
const VOICE_POLL_INTERVAL_MS = parsePositiveInt(process.env.VOICE_POLL_INTERVAL_MS, DEFAULT_VOICE_POLL_INTERVAL_MS);
const ANSI_RED = '\x1b[31m';
const ANSI_GREEN = '\x1b[32m';
const ANSI_CYAN = '\x1b[36m';
const ANSI_BOLD = '\x1b[1m';
const ANSI_DIM = '\x1b[2m';
const ANSI_RESET = '\x1b[0m';
const MAX_COMMAND_HISTORY = 3;
let lastVoiceUserIds = new Set();
let recentlyLeftUsers = new Map(); // userId -> { number, displayName, expiresAt }
let lastDeltaEvents = [];
let commandHistory = [];
let currentUserMap = new Map(); // Map to store user objects with their selection numbers
let persistentUserMap = new Map(); // Map to store user ID to number assignments
let numberToUserMap = new Map(); // Map to store number to user ID assignments
let nextAvailableNumber = 1; // Keep track of the next available number
let currentVoiceChannel = null; // Store current voice channel
let rejectChannel = null; // Store the reject command channel
let lastAction = 'Ready';

// Setup readline interface
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});
rl.setPrompt('Selection> ');

function getCurrentTimestamp() {
    return new Date().toISOString();
}

function getDisplayNameFromGuild(guild, userId) {
    const guildMember = guild?.members?.cache?.get(userId);
    if (guildMember) {
        return guildMember.displayName || guildMember.user.username;
    }

    const user = client.users.cache.get(userId);
    return user?.username || user?.tag || userId;
}

function pruneExpiredRecentlyLeftUsers(now = Date.now()) {
    for (const [userId, leftInfo] of recentlyLeftUsers.entries()) {
        if (leftInfo.expiresAt <= now) {
            recentlyLeftUsers.delete(userId);
        }
    }
}

function colorize(text, colorCode) {
    return `${colorCode}${text}${ANSI_RESET}`;
}

function getVoiceStateBadges(voiceState) {
    if (!voiceState) return '';

    const badges = [];
    if (voiceState.mute || voiceState.selfMute || voiceState.serverMute) {
        badges.push('muted');
    }
    if (voiceState.deaf || voiceState.selfDeaf || voiceState.serverDeaf) {
        badges.push('deafened');
    }
    if (voiceState.selfVideo) {
        badges.push('video');
    }
    if (voiceState.streaming) {
        badges.push('stream');
    }
    if (voiceState.suppress) {
        badges.push('suppressed');
    }

    if (badges.length === 0) {
        return '';
    }

    return ` ${colorize(badges.map(badge => `[${badge}]`).join(''), ANSI_DIM)}`;
}

function formatTimestampForPanel(isoTimestamp) {
    const timestampDate = new Date(isoTimestamp);
    if (Number.isNaN(timestampDate.getTime())) {
        return isoTimestamp;
    }

    return timestampDate.toISOString().slice(11, 19);
}

function addCommandHistory(status, text) {
    commandHistory.unshift({
        status,
        text,
        timestamp: getCurrentTimestamp(),
    });

    if (commandHistory.length > MAX_COMMAND_HISTORY) {
        commandHistory = commandHistory.slice(0, MAX_COMMAND_HISTORY);
    }
}

function scheduleMessageDeletion(message, delayMs = 10000) {
    const timer = setTimeout(async () => {
        try {
            if (!message || message.deleted) return;
            await message.delete();
        } catch (error) {
            if (error?.code === 50013) {
                console.log('\nCould not auto-delete reject message: missing permissions.');
            } else if (error?.code === 50001) {
                console.log('\nCould not auto-delete reject message: missing access to channel.');
            } else {
                console.log(`\nCould not auto-delete reject message: ${error?.message || error}`);
            }
        }
    }, delayMs);

    if (typeof timer.unref === 'function') {
        timer.unref();
    }
}

function resolveRejectChannel() {
    if (!REJECT_CHANNEL_ID) return null;

    for (const guild of client.guilds.cache.values()) {
        const channel = guild.channels.cache.get(REJECT_CHANNEL_ID);
        if (channel) {
            return channel;
        }
    }

    return null;
}

function getRejectChannelAccessIssue(channel) {
    if (!channel) {
        return `Reject channel (${REJECT_CHANNEL_ID}) was not found.`;
    }

    if (typeof channel.isText === 'function' && !channel.isText()) {
        return `Reject channel "${channel.name}" (${channel.id}) is not text-based (type: ${channel.type}).`;
    }

    if (!channel.guild || !client.user) {
        return null;
    }

    const permissions = channel.permissionsFor(client.user);
    if (!permissions) {
        return `Could not resolve permissions for "${channel.name}" (${channel.id}).`;
    }

    const missingPermissions = [];
    if (!permissions.has(Permissions.FLAGS.VIEW_CHANNEL, false)) {
        missingPermissions.push('VIEW_CHANNEL');
    }
    if (!permissions.has(Permissions.FLAGS.SEND_MESSAGES, false)) {
        missingPermissions.push('SEND_MESSAGES');
    }
    if (
        typeof channel.isThread === 'function' &&
        channel.isThread() &&
        !permissions.has(Permissions.FLAGS.SEND_MESSAGES_IN_THREADS, false)
    ) {
        missingPermissions.push('SEND_MESSAGES_IN_THREADS');
    }

    if (missingPermissions.length > 0) {
        return `Missing permissions in "${channel.name}" (${channel.id}): ${missingPermissions.join(', ')}`;
    }

    return null;
}

function getRejectChannelStatus() {
    if (!rejectChannel) {
        return {
            label: 'NOT_FOUND',
            detail: `Channel ${REJECT_CHANNEL_ID} not resolved`,
            color: ANSI_RED,
        };
    }

    const accessIssue = getRejectChannelAccessIssue(rejectChannel);
    if (accessIssue) {
        return {
            label: 'ISSUE',
            detail: accessIssue,
            color: ANSI_RED,
        };
    }

    return {
        label: 'OK',
        detail: `${rejectChannel.name} (${rejectChannel.id})`,
        color: ANSI_GREEN,
    };
}

function logToConsole(content) {
    const timestamp = getCurrentTimestamp();
    const renderedOutput = `${colorize(`[${timestamp}]`, ANSI_DIM)} ${content}\n\n${colorize(
        'Enter a number to select a user:',
        ANSI_CYAN,
    )}\n`;

    if (process.stdout.isTTY) {
        readline.cursorTo(process.stdout, 0, 0);
        readline.clearScreenDown(process.stdout);
        process.stdout.write(renderedOutput);
        rl.prompt(true);
    } else {
        console.log(renderedOutput);
    }
}

function getOrAssignUserNumber(user) {
    // If user already has a number, return it
    if (persistentUserMap.has(user.id)) {
        return persistentUserMap.get(user.id);
    }
    
    // Assign new number
    persistentUserMap.set(user.id, nextAvailableNumber);
    numberToUserMap.set(nextAvailableNumber, user.id);
    nextAvailableNumber++;
    return persistentUserMap.get(user.id);
}

async function handleUserSelection(input) {
    const trimmedInput = input.trim();
    if (trimmedInput.toLowerCase() === 'q') {
        lastAction = 'Quit requested';
        console.log('\nShutting down...');
        rl.close();
        process.exit(0);
    }

    if (trimmedInput.toLowerCase() === 'r') {
        lastAction = 'Manual refresh requested';
        checkVoiceChannel();
        return;
    }

    const number = parseInt(trimmedInput, 10);
    if (Number.isNaN(number)) {
        lastAction = 'Invalid selection';
        console.log('\nInvalid input. Enter a number from the list.');
        return;
    }

    if (currentVoiceChannel && rejectChannel) {
        const accessIssue = getRejectChannelAccessIssue(rejectChannel);
        if (accessIssue) {
            lastAction = `Reject channel access issue: ${accessIssue}`;
            console.log(`\nCannot send reject command: ${accessIssue}`);
            console.log('Tip: verify channel permissions or update REJECT_CHANNEL_ID.');
            return;
        }

        // Check if this number exists in our number to user mapping
        const userId = numberToUserMap.get(number);
        if (userId) {
            const user = client.users.cache.get(userId);
            if (user) {
                try {
                    const commandText = `.v reject ${user.id}`;
                    const sentMessage = await rejectChannel.send(commandText);
                    lastAction = `Sent reject command for ${user.tag}`;
                    addCommandHistory('sent', `${commandText} (${user.tag})`);
                    console.log(`\nSent reject command for user: ${user.tag}`);
                    scheduleMessageDeletion(sentMessage, REJECT_DELETE_DELAY_MS);
                } catch (error) {
                    if (error?.code === 50001) {
                        addCommandHistory('failed', `.v reject ${user.id} (missing access)`);
                        lastAction = `Send failed (50001) for channel ${rejectChannel.id}`;
                        console.error(
                            `Failed to send message: Missing Access (50001) for "${rejectChannel.name}" (${rejectChannel.id})`,
                        );
                        rejectChannel = resolveRejectChannel();
                        const refreshedIssue = getRejectChannelAccessIssue(rejectChannel);
                        if (refreshedIssue) {
                            console.error(`Channel access check: ${refreshedIssue}`);
                        }
                    } else if (error?.code === 50013) {
                        addCommandHistory('failed', `.v reject ${user.id} (missing permissions)`);
                        lastAction = `Send failed (50013) for channel ${rejectChannel.id}`;
                        console.error(
                            `Failed to send message: Missing Permissions (50013) for "${rejectChannel.name}" (${rejectChannel.id})`,
                        );
                    } else {
                        addCommandHistory('failed', `.v reject ${user.id} (${error?.message || 'unknown error'})`);
                        lastAction = `Send failed: ${error?.message || 'unknown error'}`;
                        console.error('Failed to send message:', error?.message || error);
                    }
                }
            } else {
                lastAction = 'Selected user not available in cache';
                console.log('\nSelected user is not in cache anymore. Wait for the list to refresh and retry.');
            }
        } else {
            lastAction = `No user mapped to selection ${number}`;
            console.log('\nNo user is currently mapped to that number.');
        }
    } else if (!rejectChannel) {
        rejectChannel = resolveRejectChannel();
        const accessIssue = getRejectChannelAccessIssue(rejectChannel);
        lastAction = accessIssue || 'Reject channel could not be resolved';
        console.log(`\nError: ${accessIssue || 'Reject channel could not be resolved.'}`);
        console.log('Tip: set REJECT_CHANNEL_ID in .env and restart.');
    }
}

function checkVoiceChannel() {
    const guilds = client.guilds.cache;
    let isInVoice = false;
    currentUserMap.clear();
    currentVoiceChannel = null;
    pruneExpiredRecentlyLeftUsers();
    
    for (const guild of guilds.values()) {
        const member = guild.members.cache.get(client.user.id);
        if (member && member.voice.channel) {
            isInVoice = true;
            const voiceChannel = member.voice.channel;
            currentVoiceChannel = voiceChannel;
            const currentUserIds = new Set();
            const currentUserDetails = new Map();
            let userList = [];
            const deltaEvents = [];
            
            // Get all users in the voice channel except yourself
            voiceChannel.members.forEach(member => {
                if (member.user.id !== client.user.id) {
                    const userNumber = getOrAssignUserNumber(member.user);
                    currentUserIds.add(member.user.id);
                    currentUserMap.set(userNumber, member.user);
                    const displayName = member.displayName || member.user.username;
                    currentUserDetails.set(member.user.id, { number: userNumber, displayName });
                    userList.push(`[${userNumber}] ${displayName}${getVoiceStateBadges(member.voice)}`);
                }
            });

            const now = Date.now();
            for (const previousUserId of lastVoiceUserIds) {
                if (!currentUserIds.has(previousUserId)) {
                    const number = persistentUserMap.get(previousUserId) || '?';
                    const displayName = getDisplayNameFromGuild(guild, previousUserId);
                    recentlyLeftUsers.set(previousUserId, {
                        number,
                        displayName,
                        expiresAt: now + RECENTLY_LEFT_DISPLAY_MS,
                    });
                    deltaEvents.push({ type: 'left', number, displayName });
                }
            }

            for (const currentUserId of currentUserIds) {
                if (!lastVoiceUserIds.has(currentUserId)) {
                    const userDetails = currentUserDetails.get(currentUserId);
                    if (userDetails) {
                        deltaEvents.push({ type: 'join', number: userDetails.number, displayName: userDetails.displayName });
                    }
                }
            }

            // Remove stale "left" state for users who are currently in the voice channel again.
            for (const currentUserId of currentUserIds) {
                recentlyLeftUsers.delete(currentUserId);
            }

            // Sort the list by user number for consistent display
            userList.sort((a, b) => {
                const numA = parseInt(a.match(/\[(\d+)\]/)[1]);
                const numB = parseInt(b.match(/\[(\d+)\]/)[1]);
                return numA - numB;
            });

            const recentlyLeftList = [];
            for (const [userId, leftInfo] of recentlyLeftUsers.entries()) {
                if (leftInfo.expiresAt > now && !currentUserIds.has(userId)) {
                    recentlyLeftList.push(leftInfo);
                }
            }

            recentlyLeftList.sort((a, b) => {
                const numA = Number.isFinite(Number(a.number)) ? Number(a.number) : Number.MAX_SAFE_INTEGER;
                const numB = Number.isFinite(Number(b.number)) ? Number(b.number) : Number.MAX_SAFE_INTEGER;
                return numA - numB;
            });

            // Log voice channel info and users in a fixed layout.
            const summaryLine = `${colorize('Channel', ANSI_BOLD)}: ${voiceChannel.name} | ${colorize(
                'Active',
                ANSI_BOLD,
            )}: ${userList.length} | ${colorize('Recently Left', ANSI_BOLD)}: ${recentlyLeftList.length} | ${colorize(
                'Last Action',
                ANSI_BOLD,
            )}: ${lastAction}`;
            let displayContent = `${colorize('Discord Rejecter Dashboard', ANSI_CYAN)}\n${summaryLine}\n\n${colorize(
                'Active Users',
                ANSI_BOLD,
            )}\n`;
            if (userList.length > 0) {
                displayContent += userList.join('\n');
            } else {
                displayContent += colorize('No other users in channel', ANSI_DIM);
            }

            if (recentlyLeftList.length > 0) {
                const leftLines = recentlyLeftList.map(
                    leftInfo => {
                        const secondsLeft = Math.max(1, Math.ceil((leftInfo.expiresAt - now) / 1000));
                        return `${ANSI_RED}[${leftInfo.number}] ${leftInfo.displayName} (left, ${secondsLeft}s)${ANSI_RESET}`;
                    },
                );
                const windowInSeconds = Math.floor(RECENTLY_LEFT_DISPLAY_MS / 1000);
                displayContent += `\n\n${colorize(`Recently Left (${windowInSeconds}s):`, ANSI_BOLD)}\n${leftLines.join(
                    '\n',
                )}`;
            }

            if (deltaEvents.length > 0) {
                const deltaLines = deltaEvents.map(deltaEvent => {
                    if (deltaEvent.type === 'join') {
                        return colorize(`+ [${deltaEvent.number}] ${deltaEvent.displayName} joined`, ANSI_GREEN);
                    }

                    return colorize(`- [${deltaEvent.number}] ${deltaEvent.displayName} left`, ANSI_RED);
                });
                displayContent += `\n\n${colorize('Deltas (latest refresh):', ANSI_BOLD)}\n${deltaLines.join('\n')}`;
            } else {
                displayContent += `\n\n${colorize('Deltas (latest refresh):', ANSI_BOLD)}\n${colorize('No changes', ANSI_DIM)}`;
            }

            if (commandHistory.length > 0) {
                const historyLines = commandHistory.map(command => {
                    const statusColor = command.status === 'sent' ? ANSI_GREEN : ANSI_RED;
                    return `${colorize(`[${formatTimestampForPanel(command.timestamp)}]`, ANSI_DIM)} ${colorize(
                        command.status.toUpperCase(),
                        statusColor,
                    )} ${command.text}`;
                });
                displayContent += `\n\n${colorize('Last Commands:', ANSI_BOLD)}\n${historyLines.join('\n')}`;
            } else {
                displayContent += `\n\n${colorize('Last Commands:', ANSI_BOLD)}\n${colorize('No commands yet', ANSI_DIM)}`;
            }

            const rejectChannelStatus = getRejectChannelStatus();
            const autoDeleteSeconds = (REJECT_DELETE_DELAY_MS / 1000).toFixed(1).replace(/\.0$/, '');
            const pollSeconds = (VOICE_POLL_INTERVAL_MS / 1000).toFixed(1).replace(/\.0$/, '');
            displayContent += `\n\n${colorize('Status:', ANSI_BOLD)}\nReject channel: ${colorize(
                rejectChannelStatus.label,
                rejectChannelStatus.color,
            )} (${rejectChannelStatus.detail})\nAuto-delete: ${autoDeleteSeconds}s | Poll: ${pollSeconds}s`;
            displayContent += `\n\n${colorize('Keys:', ANSI_BOLD)} ${colorize(
                '[number]=reject | r=refresh | q=quit',
                ANSI_DIM,
            )}`;

            logToConsole(displayContent);
            
            lastDeltaEvents = deltaEvents;
            lastVoiceUserIds = currentUserIds;
        }
    }
    
    if (!isInVoice) {
        lastVoiceUserIds = new Set();
        recentlyLeftUsers.clear();
        lastDeltaEvents = [];
        const rejectChannelStatus = getRejectChannelStatus();
        const autoDeleteSeconds = (REJECT_DELETE_DELAY_MS / 1000).toFixed(1).replace(/\.0$/, '');
        const pollSeconds = (VOICE_POLL_INTERVAL_MS / 1000).toFixed(1).replace(/\.0$/, '');
        const summaryLine = `${colorize('Channel', ANSI_BOLD)}: ${colorize('Not in voice', ANSI_DIM)} | ${colorize(
            'Active',
            ANSI_BOLD,
        )}: 0 | ${colorize('Recently Left', ANSI_BOLD)}: 0 | ${colorize('Last Action', ANSI_BOLD)}: ${lastAction}`;
        const content = `${colorize('Discord Rejecter Dashboard', ANSI_CYAN)}\n${summaryLine}\n\n${colorize(
            'Active Users',
            ANSI_BOLD,
        )}\n${colorize('No voice channel connected', ANSI_DIM)}\n\n${colorize('Status:', ANSI_BOLD)}\nReject channel: ${colorize(
            rejectChannelStatus.label,
            rejectChannelStatus.color,
        )} (${rejectChannelStatus.detail})\nAuto-delete: ${autoDeleteSeconds}s | Poll: ${pollSeconds}s\n\n${colorize(
            'Keys:',
            ANSI_BOLD,
        )} ${colorize('[number]=reject | r=refresh | q=quit', ANSI_DIM)}`;
        logToConsole(content);
    }
}

// Handle user input
rl.on('line', async (input) => {
    await handleUserSelection(input);
});

client.on('ready', () => {
    console.log(`Logged in as ${client.user.tag}`);

    const configuredFromEnv = Boolean(process.env.REJECT_CHANNEL_ID);
    const defaultFromEnv = Boolean(process.env.DEFAULT_REJECT_CHANNEL_ID);
    console.log(
        `Using reject channel ID: ${REJECT_CHANNEL_ID} ${
            configuredFromEnv
                ? '(from REJECT_CHANNEL_ID)'
                : defaultFromEnv
                    ? '(from DEFAULT_REJECT_CHANNEL_ID)'
                    : '(hardcoded default)'
        }`,
    );
    console.log(
        `Reject message auto-delete delay: ${REJECT_DELETE_DELAY_MS}ms ${
            process.env.REJECT_DELETE_DELAY_MS ? '(from REJECT_DELETE_DELAY_MS)' : '(default)'
        }`,
    );
    console.log(
        `Voice poll interval: ${VOICE_POLL_INTERVAL_MS}ms ${
            process.env.VOICE_POLL_INTERVAL_MS ? '(from VOICE_POLL_INTERVAL_MS)' : '(default)'
        }`,
    );

    rejectChannel = resolveRejectChannel();
    if (rejectChannel) {
        console.log(`Found reject channel: ${rejectChannel.name} (${rejectChannel.type})`);
        const accessIssue = getRejectChannelAccessIssue(rejectChannel);
        if (accessIssue) {
            console.log(`Warning: ${accessIssue}`);
        }
    } else {
        console.log('Warning: Reject channel not found. Make sure REJECT_CHANNEL_ID is correct.');
    }
    
    // Start checking voice channel on configured interval.
    setInterval(checkVoiceChannel, VOICE_POLL_INTERVAL_MS);
});

client.login(process.env.DISCORD_TOKEN).catch(error => {
    console.error('Failed to login:', error);
    process.exit(1);
});
