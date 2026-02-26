# Discord Voice Channel Logger

This software logs information about users in your voice channel when you are connected.

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Configure the `.env` file:
   - Add your Discord token to `DISCORD_TOKEN`
   - Optionally modify the `LOG_FILE_PATH` if you want logs stored elsewhere

3. Run the software:
   ```bash
   npm start
   ```

## Features

- Logs all users in your voice channel every second
- Only creates new log entries when there are changes in the voice channel
- Includes timestamps with each log entry
- Stores logs in a text file for easy review

## Log Format

Logs are stored in the following format:
```
[TIMESTAMP] Voice Channel: CHANNEL_NAME | Users: USER1, USER2, USER3
```
