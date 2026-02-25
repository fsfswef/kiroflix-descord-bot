// index.js
require('dotenv').config();
const { Client, GatewayIntentBits, Partials, EmbedBuilder } = require('discord.js');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// -------------------- CONFIG --------------------
const TOKEN = process.env.BOT_TOKEN;
const GEMINI_KEY = process.env.GEMINI_KEY;
const GEMINI_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemma-3-27b-it:generateContent";

const CACHE_FILE = path.join(__dirname, "latest_cache.json");
const CACHE_DURATION = 3 * 60 * 60 * 1000; // 3 hours

// -------------------- DISCORD CLIENT --------------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages
  ],
  partials: [Partials.Channel] // Needed to receive DMs
});

client.once('ready', () => {
  console.log(`🎬 Kiroflix Discord Bot Running as ${client.user.tag}`);
});

// -------------------- LOGGER --------------------
function logStep(step, data = "") {
  console.log(`\n===== ${step} =====`);
  if (data) console.log(data);
}
function logError(context, err) {
  console.error(`\n❌ ERROR in ${context}`);
  console.error(err.message, err.stack);
  if (err.response?.data) console.error("API Response:", err.response.data);
}

// -------------------- AI CORE --------------------
async function askAI(prompt) {
  try {
    const { data } = await axios.post(`${GEMINI_URL}?key=${GEMINI_KEY}`, {
      contents: [{ parts: [{ text: prompt }] }]
    });
    return data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  } catch (err) {
    logError("AI CALL", err);
    return "";
  }
}

// -------------------- INTENT --------------------
async function parseIntent(text) {
  try {
    const prompt = `
You are an anime title parser.
Return JSON as:
{
  "title":"official anime title",
  "season":null,
  "episode":number,
  "subtitle":false,
  "subtitleLang":null,
  "notFound":false
}
User: ${text}`;
    let res = await askAI(prompt);
    res = res.replace(/```json|```/gi, "").trim();
    const json = res.match(/\{[\s\S]*\}/)?.[0];
    if (!json) throw new Error("No JSON from AI");
    return JSON.parse(json);
  } catch {
    // fallback simple parser
    const ep = text.match(/ep(?:isode)?\s*(\d+)/i)?.[1];
    const season = text.match(/season\s*(\d+)/i)?.[1] || null;
    const title = text.replace(/ep(?:isode)?\s*\d+/i, "").replace(/season\s*\d+/i, "").trim();
    const subtitleMatch = text.match(/subtitle(?: in)?\s*([a-zA-Z]+)/i);
    const subtitleLang = subtitleMatch ? subtitleMatch[1] : null;
    if (title && ep) return { title, season, episode: Number(ep), subtitle: !!subtitleLang, subtitleLang };
    return null;
  }
}

// -------------------- SEARCH --------------------
async function searchAnime(title) {
  try {
    const { data } = await axios.get(
      "https://creators.kiroflix.site/backend/anime_search.php",
      { params: { q: title } }
    );
    return data.results || [];
  } catch (err) { logError("ANIME SEARCH", err); return []; }
}

// -------------------- BEST MATCH --------------------
async function chooseBestAnime(intent, results) {
  try {
    const minimal = results.map(a => ({ id: a.id, title: a.title }));
    const prompt = `
User searching: "${intent.title}"
Return ONLY the id of the best match from this list:
${JSON.stringify(minimal)}
`;
    const res = await askAI(prompt);
    const id = res.match(/\d+/)?.[0];
    return results.find(a => a.id === id) || results[0];
  } catch { return results[0]; }
}

// -------------------- EPISODES --------------------
async function getEpisodes(id) {
  try {
    const { data } = await axios.get(
      "https://creators.kiroflix.site/backend/episodes_proxy.php",
      { params: { id } }
    );
    return data.episodes || [];
  } catch (err) { logError("EPISODES FETCH", err); return []; }
}

// -------------------- STREAM --------------------
async function generateStream(episodeId) {
  try {
    const { data } = await axios.get("https://kiroflix.cu.ma/generate/generate_episode.php", {
      params: { episode_id: episodeId },
      timeout: 40000
    });
    if (!data?.success) return null;
    return { player: `https://kiroflix.cu.ma/generate/player/?episode_id=${episodeId}`, master: data.master, subtitle: data.subtitle };
  } catch (err) { logError("STREAM GEN", err); return null; }
}

// -------------------- LATEST EPISODES CACHE --------------------
async function updateLatestCache() {
  try {
    const { data } = await axios.get("https://creators.kiroflix.site/backend/lastep.php");
    let latestEpisodes = (data.results || []).slice(0, 5);
    const streams = await Promise.all(latestEpisodes.map(ep => generateStream(ep.episode_id)));
    let message = "**🎬 Latest Episodes**\n\n";
    latestEpisodes.forEach((ep, i) => {
      const stream = streams[i];
      if (!stream) return;
      message += `**${ep.anime_title}**\nEpisode ${ep.latest_episode_number}: ${ep.episode_title}\n[Watch Now](${stream.player})\n\n`;
    });
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ updatedAt: Date.now(), message }, null, 2));
    console.log("[CACHE] Latest episodes updated");
  } catch (err) { logError("CACHE UPDATE", err); }
}
updateLatestCache();
setInterval(updateLatestCache, CACHE_DURATION);
async function fetchAvailableSubtitles(episodeId) {
  try {
    const { data } = await axios.get(`https://kiroflix.cu.ma/generate/getsubs.php`, {
      params: { episode_id: episodeId }
    });
    return data || [];
  } catch (err) {
    console.error("❌ Failed to fetch subtitles:", err.message);
    return [];
  }
}
async function generateDiscordSubtitle(channel, episodeId, lang = "English") {
  const msg = await channel.send(`🎯 Generating ${lang} subtitle... 0%`);
  try {
    const { data: vttText } = await axios.get(`https://creators.kiroflix.site/backend/vttreader.php`, {
      params: { episode_id: episodeId }
    });

    const lines = vttText.split(/\r?\n/);
    const chunkSize = 100;
    const chunks = [];
    for (let i = 0; i < lines.length; i += chunkSize) {
      chunks.push([i, Math.min(i + chunkSize - 1, lines.length - 1)]);
    }

    const results = new Array(chunks.length);
    let completedChunks = 0;

    await Promise.all(chunks.map(async ([start, end], index) => {
      try {
        const { data: translated } = await axios.post(`https://kiroflix.cu.ma/generate/translate_chunk.php`, {
          lang,
          episode_id: episodeId,
          start_line: start,
          end_line: end
        });
        results[index] = translated.trim();
      } catch {
        results[index] = "";
      }
      completedChunks++;
      const percent = Math.floor((completedChunks / chunks.length) * 100);
      await msg.edit(`🎯 Generating ${lang} subtitle... ${percent}%`);
    }));

    const finalSubtitle = results.join("\n");
    const filename = `${lang.toLowerCase()}.vtt`;

    await axios.post(`https://kiroflix.cu.ma/generate/save_subtitle.php`, {
      episode_id: episodeId,
      filename,
      content: finalSubtitle
    });

    const url = `https://kiroflix.cu.ma/generate/episodes/${episodeId}/${filename}`;
    await channel.send(`✅ ${lang} subtitle ready.`);
    await msg.delete();

    return url;
  } catch (err) {
    console.error("❌ Subtitle generation failed:", err.message);
    await msg.edit(`❌ Failed to generate ${lang} subtitle`);
    return null;
  }
}
// -------------------- MESSAGE HANDLER --------------------
// Replace with your channel ID
const SEARCH_CHANNEL_ID = "1476169370693664878";

client.on('messageCreate', async (message) => {
  if (message.author.bot) return; // ignore other bots
  if (message.channel.id !== SEARCH_CHANNEL_ID) return; // ignore all other channels

  const text = message.content;

  try {
    // Commands
    if (text.startsWith("/start") || text.startsWith("/help")) {
      return message.reply(`🎬 Welcome to Kiroflix Discord Bot!\nSend anime title + episode number to get stream.\nOptional: add "subtitle in <language>"`);
    }
    if (text.startsWith("/latest")) {
      if (!fs.existsSync(CACHE_FILE)) return message.reply("⏳ Latest episodes are being prepared...");
      const cache = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
      return message.reply({ content: cache.message, allowedMentions: { parse: [] } });
    }

    await message.reply("🍿 Finding your episode...");

    // AI Intent
    const intent = await parseIntent(text);
    if (!intent) return message.reply("❌ Could not understand request");

    // Search + match
    const results = await searchAnime(intent.title);
    if (!results.length) return message.reply("❌ Anime not found");
    const anime = await chooseBestAnime(intent, results);

    // Episodes
    const episodes = await getEpisodes(anime.id);
    if (!episodes.length) return message.reply("❌ Episodes unavailable");
    const episode = episodes.find(e => Number(e.number) === Number(intent.episode)) || episodes[0];

    const stream = await generateStream(episode.id);
    if (!stream) return message.reply("❌ Could not generate stream");

    // Reply
    const embed = new EmbedBuilder()
      .setTitle(`${anime.title} - Episode ${episode.number}`)
      .setDescription(`[Watch Now](${stream.player})`)
      .setURL(stream.player)
      .setColor(0xff0000)
      .setThumbnail(anime.poster || null);

    await message.reply({ embeds: [embed] });
    if (intent.subtitle) {
  const lang = intent.subtitleLang || "English";

  const subs = await fetchAvailableSubtitles(episode.id);
  const existing = subs.find(s => s.lang.toLowerCase() === lang.toLowerCase());

  if (existing) {
    await message.channel.send(`🎯 Subtitle already available: ${existing.lang} .`);
  } else {
    await generateDiscordSubtitle(message.channel, episode.id, lang);
  }
}

  } catch (err) {
    logError("MAIN HANDLER", err);
    message.reply("⚠️ Something went wrong.");
  }
});
// -------------------- LOGIN --------------------
client.login(TOKEN);