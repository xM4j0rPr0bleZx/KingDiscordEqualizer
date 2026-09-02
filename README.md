# KingEqualizer

A Discord bot that joins a voice channel, listens only to Rythm's incoming audio, performs real-time FFT analysis, and displays a smooth rainbow spectrum at `http://localhost:3000`. It also reads Rythm's Now Playing messages and displays the current song beneath the EQ bars.

> This uses Discord audio reception, which Discord does not officially document. It may need dependency updates if Discord changes voice behavior. It does **not** use a self-bot or user token.

## Requirements

- Windows 10/11
- Node.js 24.17 or newer
- A Discord bot with **Message Content Intent** enabled and no user-account token

## Discord Developer Portal setup

1. Open https://discord.com/developers/applications and create an application.
2. Open **Bot**, create the bot, reset/copy its bot token, and enable **Message Content Intent**.
3. Open **OAuth2 → URL Generator**.
4. Select `bot` and `applications.commands`.
5. Give it these permissions: **View Channels**, **Connect**, and **Use Application Commands**.
6. Use the generated URL to invite it to your server.
7. In Discord, enable Developer Mode under **Settings → Advanced**.
8. Right-click your server, target voice channel, and Rythm's account to copy their IDs.

## Configure

1. Copy `.env.example` and rename the copy to `.env`.
2. Fill in:

```env
DISCORD_TOKEN=your_bot_token
CLIENT_ID=your_application_id
GUILD_ID=your_server_id
VOICE_CHANNEL_ID=the_music_voice_channel_id
RYTHM_USER_ID=rythms_discord_user_id
# Optional when Rythm posts in a different channel:
RYTHM_TEXT_CHANNEL_ID=rythms_text_channel_id
PORT=3000
BANDS=64
VISUALIZER_GAIN=0.72
```

`VISUALIZER_GAIN` controls bar sensitivity. Try `0.50` for shorter bars or
`1.00` for a stronger response. It does not change Rythm's audible volume.

Never share or commit `.env`.

If `RYTHM_TEXT_CHANNEL_ID` is blank, live Rythm messages from any server channel are accepted and the startup history scan checks the configured voice-channel chat. Set it to a text-channel ID if Rythm posts its Now Playing message elsewhere.

## Run

Double-click `start.bat`. The first run installs dependencies. Then open:

http://localhost:3000

Press `F11` for fullscreen. The bot auto-joins the configured channel. Server managers can also use `/equalizer start`, `/equalizer stop`, and `/equalizer display`.

## Troubleshooting

- **Bot joins but bars do not move:** confirm `RYTHM_USER_ID` is Rythm's actual account ID, not an application ID, and that Rythm is producing audio.
- **Song stays on “Waiting for Rythm”:** enable **Message Content Intent**, confirm the Rythm user ID, and set `RYTHM_TEXT_CHANNEL_ID` if Rythm posts outside the voice-channel chat. Then make Rythm start or change a song so it sends a fresh message.
- **Bot cannot join:** move the bot role above channel permission overrides or explicitly grant View Channel and Connect.
- **DAVE/reconnect error:** run `npm update`, then restart. Discord voice reception is not guaranteed stable.
- **Installation fails:** install the current Node.js 24 release, delete `node_modules`, and rerun `start.bat`.
