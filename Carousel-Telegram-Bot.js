// Telegram Carousel + Reels Auto Posting Bot
// Boss ke liye - Pure JS, No n8n
// Flow: Telegram me 2-10 images (media group) -> Title -> Caption -> IG Carousel Publish
// Same for Reels: Video -> Title -> Caption -> IG Reel Publish

const { Telegraf } = require('telegraf');
const axios = require('axios');
const { getDb } = require('./firebase'); // tumhara wala firebase.js

const BOT_TOKEN = process.env.BOT_TOKEN; // Telegram Bot Token
const IG_USER_ID = process.env.IG_USER_ID; // 17841...
const IG_ACCESS_TOKEN = process.env.IG_ACCESS_TOKEN; // Long lived token
const CLOUDINARY_UPLOAD = false; // true karo agar Cloudinary pe upload karna hai

const bot = new Telegraf(BOT_TOKEN);
const db = getDb();

// Media group ko collect karne ke liye temp memory
const mediaGroupCache = new Map(); // media_group_id -> { images: [], timer }

// 1. Telegram File ka Public URL nikalo
async function getTelegramFileUrl(fileId) {
  const res = await axios.get(`https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${fileId}`);
  const filePath = res.data.result.file_path;
  return `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;
}

// 2. IG Carousel Item Container Banao
async function createCarouselItem(imageUrl) {
  const url = `https://graph.facebook.com/v19.0/${IG_USER_ID}/media`;
  const res = await axios.post(url, {
    image_url: imageUrl,
    is_carousel_item: true,
    access_token: IG_ACCESS_TOKEN
  });
  return res.data.id;
}

// 3. IG Carousel Main Container Banao
async function createCarouselContainer(childrenIds, caption) {
  const url = `https://graph.facebook.com/v19.0/${IG_USER_ID}/media`;
  const res = await axios.post(url, {
    media_type: 'CAROUSEL',
    children: childrenIds.join(','),
    caption: caption,
    access_token: IG_ACCESS_TOKEN
  });
  return res.data.id;
}

// 4. IG Publish
async function publishMedia(creationId) {
  const url = `https://graph.facebook.com/v19.0/${IG_USER_ID}/media_publish`;
  const res = await axios.post(url, {
    creation_id: creationId,
    access_token: IG_ACCESS_TOKEN
  });
  return res.data.id;
}

// 5. Reels ke liye
async function createReelContainer(videoUrl, caption) {
  const url = `https://graph.facebook.com/v19.0/${IG_USER_ID}/media`;
  const res = await axios.post(url, {
    media_type: 'REELS',
    video_url: videoUrl,
    caption: caption,
    access_token: IG_ACCESS_TOKEN
  });
  return res.data.id;
}

// --- TELEGRAM HANDLERS ---

// Photo Handler - 2-10 images ek saath
bot.on('photo', async (ctx) => {
  const chatId = String(ctx.chat.id);
  const msg = ctx.message;
  const fileId = msg.photo[msg.photo.length - 1].file_id; // best quality
  const mediaGroupId = msg.media_group_id;

  const fileUrl = await getTelegramFileUrl(fileId);

  if (mediaGroupId) {
    // Media Group hai - multiple photos ek saath
    if (!mediaGroupCache.has(mediaGroupId)) {
      mediaGroupCache.set(mediaGroupId, { images: [], chatId, timer: null });
    }
    const group = mediaGroupCache.get(mediaGroupId);
    group.images.push(fileUrl);

    // 2 sec wait karo taaki saari images aa jaye
    if (group.timer) clearTimeout(group.timer);
    group.timer = setTimeout(async () => {
      const finalImages = mediaGroupCache.get(mediaGroupId).images;
      mediaGroupCache.delete(mediaGroupId);
      
      if (finalImages.length < 2) {
        return ctx.reply('Boss kam se kam 2 images bhejo carousel ke liye.');
      }
      if (finalImages.length > 10) {
        return ctx.reply('Boss max 10 images allowed hai, pehle 10 le raha hu.');
      }

      await db.collection('telegram_uploads').doc(chatId).set({
        step: 'awaiting_title',
        images: finalImages.slice(0, 10),
        type: 'carousel',
        chatId,
        createdAt: new Date()
      });

      ctx.reply(`🔥 ${finalImages.length} images mil gayi!\n\nAb Title bhejo:`);
    }, 2000);

  } else {
    // Single photo - single image post ya carousel start
    await db.collection('telegram_uploads').doc(chatId).set({
      step: 'awaiting_title',
      images: [fileUrl],
      type: 'carousel',
      chatId,
      createdAt: new Date()
    });
    ctx.reply('✅ Image mil gayi! Ab Title bhejo:');
  }
});

// Video Handler - Reels ke liye
bot.on('video', async (ctx) => {
  const chatId = String(ctx.chat.id);
  const fileId = ctx.message.video.file_id;
  const fileUrl = await getTelegramFileUrl(fileId);

  await db.collection('telegram_uploads').doc(chatId).set({
    step: 'awaiting_title',
    videoUrl: fileUrl,
    type: 'reel',
    chatId,
    createdAt: new Date()
  });

  ctx.reply('🎬 Reel video mil gayi! Ab Title bhejo:');
});

// Text Handler - Title -> Caption -> Publish
bot.on('text', async (ctx) => {
  const chatId = String(ctx.chat.id);
  const text = ctx.message.text;

  const doc = await db.collection('telegram_uploads').doc(chatId).get();
  if (!doc.exists) return;

  const data = doc.data();

  if (data.step === 'awaiting_title') {
    await db.collection('telegram_uploads').doc(chatId).update({
      title: text,
      step: 'awaiting_caption'
    });
    return ctx.reply('👍 Title save ho gaya!\n\nAb Caption bhejo:');
  }

  if (data.step === 'awaiting_caption') {
    const fullCaption = `${data.title}\n\n${text}`;
    
    await ctx.reply('⏳ Posting kar raha hu Instagram pe...');

    try {
      if (data.type === 'carousel') {
        // CAROUSEL POSTING
        const childrenIds = [];
        for (const imgUrl of data.images) {
          const id = await createCarouselItem(imgUrl);
          childrenIds.push(id);
          // IG ko thoda time do process karne ka
          await new Promise(r => setTimeout(r, 1500));
        }

        const carouselId = await createCarouselContainer(childrenIds, fullCaption);
        // Carousel container ready hone ka wait
        await new Promise(r => setTimeout(r, 3000));
        
        const publishedId = await publishMedia(carouselId);
        
        await db.collection('telegram_uploads').doc(chatId).delete();
        ctx.reply(`✅ Carousel Post Ho Gaya!\nID: ${publishedId}`);

      } else if (data.type === 'reel') {
        // REELS POSTING
        const reelId = await createReelContainer(data.videoUrl, fullCaption);
        
        // Reels ko process hone me time lagta hai (20-30 sec)
        let status = 'IN_PROGRESS';
        for (let i = 0; i < 10; i++) {
          await new Promise(r => setTimeout(r, 5000));
          const check = await axios.get(`https://graph.facebook.com/v19.0/${reelId}?fields=status_code&access_token=${IG_ACCESS_TOKEN}`);
          status = check.data.status_code;
          if (status === 'FINISHED') break;
        }

        const publishedId = await publishMedia(reelId);
        await db.collection('telegram_uploads').doc(chatId).delete();
        ctx.reply(`✅ Reel Post Ho Gaya!\nID: ${publishedId}`);
      }

    } catch (err) {
      console.error(err.response?.data || err.message);
      ctx.reply(`❌ Error: ${err.response?.data?.error?.message || err.message}`);
    }
  }
});

bot.launch();
console.log('Bot started - Carousel + Reels ready boss!');
