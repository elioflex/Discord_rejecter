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
const RECENTLY_LEFT_DISPLAY_MS = 60000;
const ANSI_RED = '\x1b[31m';
const ANSI_CYAN = '\x1b[36m';
const ANSI_BOLD = '\x1b[1m';
const ANSI_DIM = '\x1b[2m';
const ANSI_RESET = '\x1b[0m';
let lastVoiceUserIds = new Set();
let recentlyLeftUsers = new Map(); // userId -> { number, displayName, expiresAt }
let currentUserMap = new Map(); // Map to store user objects with their selection numbers
let persistentUserMap = new Map(); // Map to store user ID to number assignments
let numberToUserMap = new Map(); // Map to store number to user ID assignments
let nextAvailableNumber = 1; // Keep track of the next available number
let currentVoiceChannel = null; // Store current voice channel
let rejectChannel = null; // Store the reject command channel

// Setup readline interface
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

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

function logToConsole(content) {
    const timestamp = getCurrentTimestamp();
    console.clear();
    console.log(`${colorize(`[${timestamp}]`, ANSI_DIM)} ${content}`);
    console.log(`\n${colorize('Enter a number to select a user:', ANSI_CYAN)}`);
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
    const number = parseInt(input, 10);
    if (Number.isNaN(number)) {
        console.log('\nInvalid input. Enter a number from the list.');
        return;
    }

    if (currentVoiceChannel && rejectChannel) {
        const accessIssue = getRejectChannelAccessIssue(rejectChannel);
        if (accessIssue) {
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
                    const sentMessage = await rejectChannel.send(`.v reject ${user.id}`);
                    console.log(`\nSent reject command for user: ${user.tag}`);
                    scheduleMessageDeletion(sentMessage, REJECT_DELETE_DELAY_MS);
                } catch (error) {
                    if (error?.code === 50001) {
                        console.error(
                            `Failed to send message: Missing Access (50001) for "${rejectChannel.name}" (${rejectChannel.id})`,
                        );
                        rejectChannel = resolveRejectChannel();
                        const refreshedIssue = getRejectChannelAccessIssue(rejectChannel);
                        if (refreshedIssue) {
                            console.error(`Channel access check: ${refreshedIssue}`);
                        }
                    } else if (error?.code === 50013) {
                        console.error(
                            `Failed to send message: Missing Permissions (50013) for "${rejectChannel.name}" (${rejectChannel.id})`,
                        );
                    } else {
                        console.error('Failed to send message:', error?.message || error);
                    }
                }
            } else {
                console.log('\nSelected user is not in cache anymore. Wait for the list to refresh and retry.');
            }
        } else {
            console.log('\nNo user is currently mapped to that number.');
        }
    } else if (!rejectChannel) {
        rejectChannel = resolveRejectChannel();
        const accessIssue = getRejectChannelAccessIssue(rejectChannel);
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
            let userList = [];
            
            // Get all users in the voice channel except yourself
            voiceChannel.members.forEach(member => {
                if (member.user.id !== client.user.id) {
                    const userNumber = getOrAssignUserNumber(member.user);
                    currentUserIds.add(member.user.id);
                    currentUserMap.set(userNumber, member.user);
                    const displayName = member.displayName || member.user.username;
                    userList.push(`[${userNumber}] ${displayName}`);
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

            // Log voice channel info and users
            let displayContent = '';
            if (userList.length > 0) {
                displayContent = `${colorize('Voice Channel:', ANSI_BOLD)} ${voiceChannel.name}\n${colorize(
                    'Users:',
                    ANSI_BOLD,
                )}\n${userList.join('\n')}`;
            } else {
                displayContent = `${colorize('Voice Channel:', ANSI_BOLD)} ${voiceChannel.name}\n${colorize(
                    'No other users in channel',
                    ANSI_DIM,
                )}`;
            }

            if (recentlyLeftList.length > 0) {
                const leftLines = recentlyLeftList.map(
                    leftInfo => `${ANSI_RED}[${leftInfo.number}] ${leftInfo.displayName} (left)${ANSI_RESET}`,
                );
                displayContent += `\n\n${colorize('Recently Left:', ANSI_BOLD)}\n${leftLines.join('\n')}`;
            }

            logToConsole(displayContent);
            
            lastVoiceUserIds = currentUserIds;
        }
    }
    
    if (!isInVoice) {
        lastVoiceUserIds = new Set();
        recentlyLeftUsers.clear();
        console.clear();
        console.log('Not currently in a voice channel');
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
    
    // Start checking voice channel every 2 seconds
    setInterval(checkVoiceChannel, 2000);
});

client.login(process.env.DISCORD_TOKEN).catch(error => {
    console.error('Failed to login:', error);
    process.exit(1);
});
