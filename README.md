# Discord Rejecter

Terminal dashboard to monitor your current Discord voice channel and quickly send `.v reject <userId>` commands by typing a user number.

## Features

- Live terminal dashboard with:
  - Active users
  - Recently left users (with countdown)
  - Join/leave deltas
  - Event timeline (last 10)
  - Session stats (uptime, sent/failed, joins/leaves)
  - Reject channel health status
- Numbered user selection from terminal input
- Auto-delete sent reject command messages after a configurable delay
- Configurable poll interval and display timers via environment variables

## Requirements

- Node.js 18+
- npm

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create your local env file:

```bash
cp .env.example .env
```

3. Fill in your values in `.env`.

4. Start the app:

```bash
npm start
```

## Environment Variables

| Variable | Required | Description |
| --- | --- | --- |
| `DISCORD_TOKEN` | Yes | Discord account token used to log in |
| `REJECT_CHANNEL_ID` | No | Preferred text channel ID for sending reject commands |
| `DEFAULT_REJECT_CHANNEL_ID` | No | Fallback channel ID if `REJECT_CHANNEL_ID` is not set |
| `REJECT_DELETE_DELAY_MS` | No | Delay before auto-deleting sent reject command messages |
| `RECENTLY_LEFT_DISPLAY_MS` | No | How long recently-left users stay visible in dashboard |
| `VOICE_POLL_INTERVAL_MS` | No | Refresh interval for voice channel checks |

## Controls

- Enter a number: send reject command for that user
- `r`: manual refresh
- `q`: quit

## Notes

- Keep `.env` private and never commit it.
- If you suspect your token was exposed, rotate it immediately.
