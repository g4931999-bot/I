
const { Telegraf } = require('telegraf');
const express = require('express');
const axios = require('axios');
const { getDb } = require('./firebase');
const fs = require('fs');

const BOT_TOKEN = process.env.BOT_TOKEN;
const IG_USER_ID = process.env.IG_USER_ID;
const IG_ACCESS_TOKEN = process.env.IG_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'tubepilot123';

if(!BOT_TOKEN) throw new Error('BOT_TOKEN missing');
if(!IG_USER_ID) throw new Error('IG_USER_ID missing');
if(!IG_ACCESS_TOKEN) throw new Error('IG_ACCESS_TOKEN missing');

const bot = new Telegraf(BOT_TOKEN);
const app = express();
app.use(express.json());

// Store user photos temporarily
const userAlbums = new Map(); // userId -> {photos: [], timer: null}

// --- Telegram Bot ---
bot.start((ctx) => {
  return ctx.reply(
    `🚀 TubePilot Carousel Bot Ready!

` +
    `📸 Carousel kaise banaye:
` +
    `1. 2 se 10 photos ek saath ALBUM ke roop me bhejo
` +
    `2. Ya ek-ek karke jaldi bhejo (10 sec ke andar)
` +
    `3. Fir bot auto Instagram pe post kar dega @tubepilot.app pe

` +
    `Try karo - abhi 3 photos bhejo!`
  );
});

bot.help((ctx) => {
  ctx.reply('Bas 2-10 photos bhejo album ke roop me, mai Instagram pe carousel post kar dunga!');
});

bot.on('photo', async (ctx) => {
  try {
    const userId = ctx.from.id;
    const photo = ctx.message.photo[ctx.message.photo.length - 1]; // highest quality
    const fileId = photo.file_id;
    
    // Get file link
    const fileLink = await ctx.telegram.getFileLink(fileId);
    const fileUrl = fileLink.href;

    console.log(`Photo received from ${userId}: ${fileUrl}`);

    if (!userAlbums.has(userId)) {
      userAlbums.set(userId, { photos: [], timer: null });
    }
    const album = userAlbums.get(userId);
    album.photos.push(fileUrl);

    // Clear old timer
    if (album.timer) clearTimeout(album.timer);

    // If this is part of a media_group (album), wait for all
    const mediaGroupId = ctx.message.media_group_id;
    
    if (mediaGroupId) {
      // Album - wait 3 seconds for all photos
      album.timer = setTimeout(() => processAlbum(userId, ctx), 3000);
      if (album.photos.length === 1) {
        ctx.reply(`📸 ${album.photos.length} photo mili, aur bhejo... 3 sec me post karunga`);
      }
    } else {
      // Single photo - wait 10 seconds to collect more
      if (album.photos.length === 1) {
        ctx.reply(`📸 Photo 1 mili! Agar carousel banana hai to 10 sec ke andar aur photos bhejo. Single post ke liye wait karo.`);
      } else {
        ctx.reply(`📸 Photo ${album.photos.length} mili!`);
      }
      album.timer = setTimeout(() => processAlbum(userId, ctx), 10000);
    }

  } catch (e) {
    console.error('Photo handler error:', e);
    ctx.reply('❌ Error: ' + e.message);
  }
});

async function processAlbum(userId, ctx) {
  const album = userAlbums.get(userId);
  if (!album || album.photos.length === 0) return;

  const photos = [...album.photos];
  userAlbums.delete(userId); // clear

  if (photos.length === 0) return;

  try {
    await ctx.reply(`🔄 ${photos.length} photos se ${photos.length > 1 ? 'Carousel' : 'Single Post'} bana raha hoon... Instagram pe @tubepilot.app`);

    // Step 1: Create containers
    const containerIds = [];
    for (let i = 0; i < photos.length; i++) {
      const url = photos[i];
      console.log(`Creating container ${i+1}/${photos.length}: ${url}`);
      
      // Download and re-host? Instagram needs public URL, Telegram URLs expire fast
      // So we create container directly with Telegram URL (works if posted quickly)
      // Better to upload to somewhere, but try direct
      const res = await axios.post(`https://graph.facebook.com/v20.0/${IG_USER_ID}/media`, null, {
        params: {
          image_url: url,
          is_carousel_item: photos.length > 1 ? true : undefined,
          access_token: IG_ACCESS_TOKEN
        }
      });
      console.log(`Container ${i+1} created:`, res.data.id);
      containerIds.push(res.data.id);
      
      // Small delay to avoid rate limit
      await new Promise(r => setTimeout(r, 1500));
    }

    // Step 2: Create carousel or single
    let creationId;
    if (photos.length > 1) {
      const res = await axios.post(`https://graph.facebook.com/v20.0/${IG_USER_ID}/media`, null, {
        params: {
          media_type: 'CAROUSEL',
          children: containerIds.join(','),
          caption: `Posted via TubePilot Bot 🚀 #tubepilot`,
          access_token: IG_ACCESS_TOKEN
        }
      });
      creationId = res.data.id;
    } else {
      creationId = containerIds[0];
      // Add caption for single
      await axios.post(`https://graph.facebook.com/v20.0/${creationId}`, null, {
        params: {
          caption: `Posted via TubePilot Bot 🚀 #tubepilot`,
          access_token: IG_ACCESS_TOKEN
        }
      });
    }

    console.log('Creation ID:', creationId);
    await ctx.reply(`⏳ Container ban gaya, ab publish kar raha hoon...`);

    // Wait for containers to be ready
    await new Promise(r => setTimeout(r, 5000));

    // Step 3: Publish
    const publishRes = await axios.post(`https://graph.facebook.com/v20.0/${IG_USER_ID}/media_publish`, null, {
      params: {
        creation_id: creationId,
        access_token: IG_ACCESS_TOKEN
      }
    });

    console.log('Published:', publishRes.data);
    await ctx.reply(`✅ Posted Successfully! 🎉

https://www.instagram.com/p/${publishRes.data.id}/

Check karo @tubepilot.app pe!`);

    // Save to Firebase
    try {
      const db = getDb();
      await db.collection('telegram_uploads').add({
        userId: userId,
        username: ctx.from.username,
        photos: photos,
        igMediaId: publishRes.data.id,
        createdAt: new Date()
      });
    } catch (fbErr) {
      console.error('Firebase save error:', fbErr.message);
    }

  } catch (e) {
    console.error('Publish error:', e.response?.data || e.message);
    const errMsg = e.response?.data?.error?.message || e.message;
    await ctx.reply(`❌ Post Fail: ${errMsg}

Tip: Telegram photo link expire ho jata hai, jaldi post karta hoon. Fir se try karo.`);
  }
}

// --- Express for Meta Webhook Verification ---
app.get('/', (req, res) => {
  res.send('TubePilot Bot is Running 🚀 - Ready at https://i-bw08.onrender.com');
});

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  
  console.log(`Webhook verify attempt: ${mode} ${token}`);
  
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('WEBHOOK VERIFIED');
    res.status(200).send(challenge);
  } else {
    console.log('Webhook verification failed');
    res.sendStatus(403);
  }
});

app.post('/webhook', (req, res) => {
  console.log('Webhook POST:', JSON.stringify(req.body).substring(0, 500));
  res.status(200).send('EVENT_RECEIVED');
});

app.get('/auth/instagram/callback', (req, res) => res.send('Instagram Auth Callback OK - You can close this'));
app.get('/auth/deauthorize', (req, res) => res.send('Deauthorize OK'));
app.get('/auth/data-deletion', (req, res) => res.send('Data Deletion OK'));

// --- Start ---
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Express server running on port ${PORT} - Ready for Meta verification`);
});

// Fix 409 Conflict - stop other instances
bot.launch({ dropPendingUpdates: true }).then(() => {
  console.log('Telegram Bot started - Production Ready');
}).catch(err => {
  console.error('Bot launch error:', err.message);
  // Retry after 5 sec
  setTimeout(() => bot.launch({ dropPendingUpdates: true }), 5000);
});

// Graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
