import 'dotenv/config';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import FFT from 'fft-js';
import OpusScript from 'opusscript';
import {
  Client,
  GatewayIntentBits,
  MessageFlags,
  Partials,
  SlashCommandBuilder,
  PermissionFlagsBits,
} from 'discord.js';
import {
  EndBehaviorType,
  VoiceConnectionStatus,
  entersState,
  getVoiceConnection,
  joinVoiceChannel,
} from '@discordjs/voice';

const config = {
  token: process.env.DISCORD_TOKEN,
  clientId: process.env.CLIENT_ID,
  guildId: process.env.GUILD_ID,
  channelId: process.env.VOICE_CHANNEL_ID,
  rythmId: process.env.RYTHM_USER_ID,
  rythmTextChannelId: process.env.RYTHM_TEXT_CHANNEL_ID || null,
  port: Number(process.env.PORT) || 3000,
  bandCount: Math.min(128, Math.max(16, Number(process.env.BANDS) || 64)),
  visualizerGain: Math.min(2, Math.max(0.1, Number(process.env.VISUALIZER_GAIN) || 0.72)),
  maxAudioListeners: Math.min(25, Math.max(1, Number(process.env.MAX_AUDIO_LISTENERS) || 8)),
};

for (const [key, value] of Object.entries(config)) {
  if (['port', 'bandCount', 'visualizerGain', 'maxAudioListeners', 'rythmTextChannelId'].includes(key)) continue;
  if (!value) {
    console.error(`Missing ${key}. Fill in every required value in .env.`);
    process.exit(1);
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('/health', (_req, res) => res.json({ ok: true, listening: analyzer.active }));
let widgetCache = { data: null, updatedAt: 0 };
app.get('/api/discord-widget', async (_req, res) => {
  try {
    if (!widgetCache.data || Date.now() - widgetCache.updatedAt > 30_000) {
      const response = await fetch(`https://discord.com/api/v10/guilds/${config.guildId}/widget.json`);
      if (!response.ok) throw new Error(`Discord widget request failed (${response.status}).`);
      const widget = await response.json();
      widgetCache = {
        updatedAt: Date.now(),
        data: {
          name: widget.name,
          instantInvite: widget.instant_invite,
          presenceCount: widget.presence_count || 0,
          members: (widget.members || []).slice(0, 12).map(member => ({
            username: member.username,
            status: member.status,
            avatarUrl: member.avatar_url,
          })),
        },
      };
    }
    res.json(widgetCache.data);
  } catch (error) {
    if (widgetCache.data) return res.json(widgetCache.data);
    res.status(503).json({ error: error.message });
  }
});
const server = http.createServer(app);
const sockets = new WebSocketServer({ server });
const AUDIO_SAMPLE_RATE = 24000;

const analyzer = {
  active: false,
  source: null,
  decoder: null,
  carry: Buffer.alloc(0),
  pcm: [],
  audioPhase: 0,
  timer: null,
  latest: Array(config.bandCount).fill(0),
};

let currentTrack = null;

function broadcast(payload) {
  const data = JSON.stringify(payload);
  for (const socket of sockets.clients) {
    if (socket.readyState === WebSocket.OPEN) socket.send(data);
  }
}

function hasAudioSubscribers() {
  for (const socket of sockets.clients) {
    if (socket.readyState === WebSocket.OPEN && socket.audioSubscribed) return true;
  }
  return false;
}

function broadcastAudio(samples) {
  if (!samples.length) return;
  const packet = Buffer.allocUnsafe(samples.length * 2);
  for (let i = 0; i < samples.length; i += 1) packet.writeInt16LE(samples[i], i * 2);
  for (const socket of sockets.clients) {
    if (socket.readyState !== WebSocket.OPEN || !socket.audioSubscribed) continue;
    if (socket.bufferedAmount > 512 * 1024) continue;
    socket.send(packet, { binary: true });
  }
}

function publishTrack(track) {
  if (!track) return;
  currentTrack = { ...track, detectedAt: Date.now() };
  broadcast({ type: 'track', track: currentTrack });
  console.log(`Rythm now playing: ${currentTrack.title}`);
}

function trackFromRythmMessage(message) {
  const isRythm = message.author?.id === config.rythmId
    || message.applicationId === config.rythmId
    || message.interactionMetadata?.user?.id === config.rythmId;
  if (!isRythm || message.guildId !== config.guildId) return null;
  if (config.rythmTextChannelId && message.channelId !== config.rythmTextChannelId) return null;

  const entries = [];
  if (message.content) entries.push({ label: 'content', text: message.content, url: null });
  for (const embed of message.embeds || []) {
    if (embed.author?.name) entries.push({ label: 'author', text: embed.author.name, url: embed.url });
    if (embed.title) entries.push({ label: 'title', text: embed.title, url: embed.url });
    if (embed.description) entries.push({ label: 'description', text: embed.description, url: embed.url });
    for (const field of embed.fields || []) {
      entries.push({ label: field.name || 'field', text: field.value, url: embed.url });
    }
  }

  const signal = /\b(now\s*playing|currently\s*playing|playing\s*now|started\s*playing)\b|^\s*playing\b/i;
  if (!entries.some(entry => signal.test(`${entry.label} ${entry.text}`))) return null;

  const priority = [
    ...entries.filter(entry => signal.test(entry.label)),
    ...entries.filter(entry => !signal.test(entry.label) && !signal.test(entry.text)),
    ...entries.filter(entry => signal.test(entry.text)),
  ];
  for (const entry of priority) {
    const parsed = cleanTrackCandidate(entry.text, entry.url, signal);
    if (parsed) return parsed;
  }
  return null;
}

function cleanTrackCandidate(value, fallbackUrl, signal) {
  if (!value) return null;
  const markdownLink = String(value).match(/\[([^\]]+)]\((https?:\/\/[^)\s]+)\)/i);
  let title = markdownLink?.[1] || String(value);
  const url = markdownLink?.[2] || fallbackUrl || null;
  title = title
    .replace(signal, '')
    .replace(/^[\s:|—–-]+/, '')
    .replace(/<a?:nav_music_note:\d+>/g, '🎵')
    .replace(/[\*_`~]/g, '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(line => line && !/^(requested|duration|volume|queue|progress)\b/i.test(line));
  if (!title || title.length < 2 || /^(now\s*playing|playing)$/i.test(title)) return null;
  return { title: title.slice(0, 300), url };
}

async function seedTrackFromRecentMessages(guild) {
  const channelId = config.rythmTextChannelId || config.channelId;
  try {
    const channel = await guild.channels.fetch(channelId);
    if (!channel?.messages?.fetch) {
      console.log('Rythm history scan skipped: configured channel has no readable message history.');
      return;
    }
    const messages = await channel.messages.fetch({ limit: 50 });
    for (const message of messages.values()) {
      const track = trackFromRythmMessage(message);
      if (track) {
        publishTrack(track);
        return;
      }
    }
    console.log('Waiting for Rythm to post a Now Playing message.');
  } catch (error) {
    console.error(`Rythm history scan failed: ${error.message}`);
  }
}

function stopAnalyzer() {
  analyzer.active = false;
  analyzer.source?.destroy();
  analyzer.source = null;
  analyzer.decoder = null;
  analyzer.carry = Buffer.alloc(0);
  analyzer.pcm = [];
  analyzer.audioPhase = 0;
  clearInterval(analyzer.timer);
  analyzer.timer = null;
  analyzer.latest.fill(0);
  broadcast({ type: 'status', active: false });
}

function bandsFromPcm(samples) {
  const fftSize = 2048;
  if (samples.length < fftSize) return analyzer.latest;
  const frame = samples.slice(-fftSize).map((sample, i) => {
    const hann = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (fftSize - 1)));
    return (sample / 32768) * hann;
  });
  const phasors = FFT.fft(frame);
  const mags = FFT.util.fftMag(phasors).slice(1, fftSize / 2);
  const minHz = 35;
  const maxHz = 18000;
  const sampleRate = 48000;
  const output = [];
  for (let band = 0; band < config.bandCount; band += 1) {
    const lowHz = minHz * ((maxHz / minHz) ** (band / config.bandCount));
    const highHz = minHz * ((maxHz / minHz) ** ((band + 1) / config.bandCount));
    const start = Math.max(1, Math.floor((lowHz * fftSize) / sampleRate));
    const end = Math.max(start + 1, Math.ceil((highHz * fftSize) / sampleRate));
    let peak = 0;
    for (let i = start; i < Math.min(end, mags.length); i += 1) peak = Math.max(peak, mags[i]);
    // fft-js magnitudes scale with the transform size. Convert them back to
    // a 0..1 signal amplitude before mapping decibels to bar height.
    const amplitude = peak / (fftSize / 2);
    const decibels = 20 * Math.log10(amplitude + 1e-8);
    const level = Math.min(1, Math.max(0, (decibels + 80) / 72));
    const adjusted = Math.min(1, Math.pow(level, 1.35) * config.visualizerGain);
    output.push(Math.max(adjusted, analyzer.latest[band] * 0.78));
  }
  analyzer.latest = output;
  return output;
}

function startAnalyzer(connection) {
  stopAnalyzer();
  const source = connection.receiver.subscribe(config.rythmId, {
    end: { behavior: EndBehaviorType.Manual },
  });
  const decoder = new OpusScript(48000, 2, OpusScript.Application.AUDIO);
  analyzer.active = true;
  analyzer.source = source;
  analyzer.decoder = decoder;

  source.on('data', packet => {
    try {
      const opus = Buffer.isBuffer(packet) ? packet : packet?.payload;
      if (!opus?.length) return;
      const decoded = decoder.decode(opus);
      const chunk = Buffer.from(decoded.buffer, decoded.byteOffset, decoded.byteLength);
      const data = Buffer.concat([analyzer.carry, chunk]);
      const usable = data.length - (data.length % 4);
      const audioSamples = hasAudioSubscribers() ? [] : null;
      for (let offset = 0; offset < usable; offset += 4) {
        const mono = (data.readInt16LE(offset) + data.readInt16LE(offset + 2)) / 2;
        analyzer.pcm.push(mono);
        if (audioSamples && analyzer.audioPhase === 0) audioSamples.push(Math.round(mono));
        analyzer.audioPhase = (analyzer.audioPhase + 1) % 2;
      }
      analyzer.carry = data.subarray(usable);
      if (analyzer.pcm.length > 8192) analyzer.pcm.splice(0, analyzer.pcm.length - 8192);
      if (audioSamples?.length) broadcastAudio(audioSamples);
    } catch (error) {
      console.error(`Opus packet skipped: ${error.message}`);
    }
  });
  source.on('error', error => console.error('Voice receiver:', error.message));
  analyzer.timer = setInterval(() => {
    broadcast({ type: 'spectrum', active: true, bands: bandsFromPcm(analyzer.pcm) });
  }, 1000 / 30);
  broadcast({ type: 'status', active: true });
}

async function connectToConfiguredChannel(guild) {
  const channel = await guild.channels.fetch(config.channelId);
  if (!channel?.isVoiceBased()) throw new Error('VOICE_CHANNEL_ID is not a voice channel.');
  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: true,
  });
  await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
  startAnalyzer(connection);
  return channel;
}

const commands = [
  new SlashCommandBuilder().setName('equalizer').setDescription('Control KingEqualizer')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(s => s.setName('start').setDescription('Join the configured voice channel'))
    .addSubcommand(s => s.setName('stop').setDescription('Disconnect and stop analyzing'))
    .addSubcommand(s => s.setName('display').setDescription('Show the visualizer address')),
].map(command => command.toJSON());

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message],
});

client.once('clientReady', async readyClient => {
  console.log(`Logged in as ${readyClient.user.tag}`);
  const guild = await readyClient.guilds.fetch(config.guildId);
  await guild.commands.set(commands);
  console.log(`Commands registered. Display: http://localhost:${config.port}`);
  await seedTrackFromRecentMessages(guild);
  try {
    const channel = await connectToConfiguredChannel(guild);
    console.log(`Listening for Rythm in ${channel.name}`);
  } catch (error) {
    console.error(`Auto-join failed: ${error.message}`);
  }
});

client.on('messageCreate', message => {
  publishTrack(trackFromRythmMessage(message));
});

client.on('messageUpdate', async (_oldMessage, newMessage) => {
  try {
    const message = newMessage.partial ? await newMessage.fetch() : newMessage;
    publishTrack(trackFromRythmMessage(message));
  } catch (error) {
    console.error(`Rythm message update skipped: ${error.message}`);
  }
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'equalizer') return;
  const sub = interaction.options.getSubcommand();
  try {
    if (sub === 'start') {
      const channel = await connectToConfiguredChannel(interaction.guild);
      await interaction.reply({ content: `Listening to Rythm in **${channel.name}**.`, flags: MessageFlags.Ephemeral });
    } else if (sub === 'stop') {
      stopAnalyzer();
      getVoiceConnection(interaction.guildId)?.destroy();
      await interaction.reply({ content: 'KingEqualizer stopped.', flags: MessageFlags.Ephemeral });
    } else {
      await interaction.reply({ content: `Open http://localhost:${config.port}`, flags: MessageFlags.Ephemeral });
    }
  } catch (error) {
    await interaction.reply({ content: `Error: ${error.message}`, flags: MessageFlags.Ephemeral });
  }
});

client.on('voiceStateUpdate', (oldState, newState) => {
  if (oldState.id !== config.rythmId && newState.id !== config.rythmId) return;
  if (newState.channelId === config.channelId) {
    const connection = getVoiceConnection(newState.guild.id);
    if (connection) startAnalyzer(connection);
  } else if (oldState.channelId === config.channelId) {
    analyzer.latest.fill(0);
    broadcast({ type: 'status', active: false });
  }
});

sockets.on('connection', socket => {
  socket.audioSubscribed = false;
  socket.send(JSON.stringify({ type: 'status', active: analyzer.active }));
  socket.send(JSON.stringify({ type: 'track', track: currentTrack }));
  socket.send(JSON.stringify({
    type: 'audio-format',
    format: 's16le',
    channels: 1,
    sampleRate: AUDIO_SAMPLE_RATE,
  }));
  socket.on('message', (data, isBinary) => {
    if (isBinary) return;
    try {
      const message = JSON.parse(data.toString());
      if (message.type === 'ping') {
        socket.send(JSON.stringify({ type: 'pong' }));
        return;
      }
      if (message.type !== 'audio-subscribe') return;
      const enable = message.enabled === true;
      const listenerCount = [...sockets.clients].filter(client =>
        client !== socket && client.readyState === WebSocket.OPEN && client.audioSubscribed
      ).length;
      if (enable && !socket.audioSubscribed && listenerCount >= config.maxAudioListeners) {
        socket.send(JSON.stringify({
          type: 'audio-subscription',
          enabled: false,
          error: 'The live audio listener limit has been reached.',
        }));
        return;
      }
      socket.audioSubscribed = enable;
      socket.send(JSON.stringify({ type: 'audio-subscription', enabled: enable }));
    } catch {
      // Ignore malformed browser messages.
    }
  });
});

server.listen(config.port, () => console.log(`Visualizer running at http://localhost:${config.port}`));
client.login(config.token).catch(error => {
  if (error.code === 'DisallowedIntents') {
    console.error('Discord login failed: enable Message Content Intent on the Bot page in the Discord Developer Portal.');
  } else {
    console.error(`Discord login failed: ${error.message}`);
  }
  process.exit(1);
});

process.on('SIGINT', () => {
  stopAnalyzer();
  client.destroy();
  server.close(() => process.exit(0));
});
