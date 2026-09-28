// Telegram Carousel + Reels Auto Posting Bot - FINAL
// Flow: image -> 2-10 photos -> title -> caption -> Carousel
// Flow: video -> video -> title -> caption -> Reel

const { Telegraf } = require('telegraf');
const axios = require('axios');
const { getDb } = require('./firebase');

const BOT_TOKEN = process.env.BOT_TOKEN;
const IG_USER_ID = process.env.IG_USER_ID;
const IG_ACCESS_TOKEN = process.env.IG_ACCESS_TOKEN;

if(!BOT_TOKEN) throw new Error('BOT_TOKEN missing');
const bot = new Telegraf(BOT_TOKEN);
const db = getDb();

const mediaGroupCache = new Map();

async function getTelegramFileUrl(fileId){
  const res = await axios.get(`https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${fileId}`);
  return `https://api.telegram.org/file/bot${BOT_TOKEN}/${res.data.result.file_path}`;
}
async function createCarouselItem(imageUrl){
  const url = `https://graph.facebook.com/v19.0/${IG_USER_ID}/media`;
  const res = await axios.post(url, {image_url: imageUrl, is_carousel_item: true, access_token: IG_ACCESS_TOKEN});
  return res.data.id;
}
async function createCarouselContainer(childrenIds, caption){
  const url = `https://graph.facebook.com/v19.0/${IG_USER_ID}/media`;
  const res = await axios.post(url, {media_type: 'CAROUSEL', children: childrenIds.join(','), caption, access_token: IG_ACCESS_TOKEN});
  return res.data.id;
}
async function publishMedia(creationId){
  const url = `https://graph.facebook.com/v19.0/${IG_USER_ID}/media_publish`;
  const res = await axios.post(url, {creation_id: creationId, access_token: IG_ACCESS_TOKEN});
  return res.data.id;
}
async function createReelContainer(videoUrl, caption){
  const url = `https://graph.facebook.com/v19.0/${IG_USER_ID}/media`;
  const res = await axios.post(url, {media_type: 'REELS', video_url: videoUrl, caption, access_token: IG_ACCESS_TOKEN});
  return res.data.id;
}

bot.start(async (ctx)=>{
  await db.collection('telegram_uploads').doc(String(ctx.chat.id)).delete().catch(()=>{});
  return ctx.reply('Boss swagat hai!\n\n👉 Carousel ke liye likho: image\n👉 Reels ke liye likho: video\n\nFir media bhejo!');
});

bot.on('text', async (ctx)=>{
  const chatId = String(ctx.chat.id);
  const text = ctx.message.text.trim().toLowerCase();
  const originalText = ctx.message.text.trim();

  if(text === 'image' || text === 'images' || text === 'carousel'){
    await db.collection('telegram_uploads').doc(chatId).set({step: 'awaiting_images', type: 'carousel', chatId, createdAt: new Date()});
    return ctx.reply('✅ Carousel mode ON!\n\nAb 2 se 10 images ek saath bhejo.');
  }
  if(text === 'video' || text === 'reel' || text === 'reels'){
    await db.collection('telegram_uploads').doc(chatId).set({step: 'awaiting_video', type: 'reel', chatId, createdAt: new Date()});
    return ctx.reply('✅ Reels mode ON!\n\nAb ek video bhejo.');
  }

  const doc = await db.collection('telegram_uploads').doc(chatId).get();
  if(!doc.exists) return ctx.reply('Pehle likho: image ya video');
  const data = doc.data();

  if(data.step === 'awaiting_title'){
    await db.collection('telegram_uploads').doc(chatId).update({title: originalText, step: 'awaiting_caption'});
    return ctx.reply('👍 Title save!\n\nAb Caption bhejo:');
  }

  if(data.step === 'awaiting_caption'){
    const fullCaption = `${data.title}\n\n${originalText}`;
    await ctx.reply('⏳ Instagram pe post kar raha hu...');
    try{
      if(data.type === 'carousel'){
        const childrenIds=[];
        for(const imgUrl of data.images){
          const id = await createCarouselItem(imgUrl);
          childrenIds.push(id);
          await new Promise(r=>setTimeout(r,1500));
        }
        const carouselId = await createCarouselContainer(childrenIds, fullCaption);
        await new Promise(r=>setTimeout(r,3000));
        const publishedId = await publishMedia(carouselId);
        await db.collection('telegram_uploads').doc(chatId).delete();
        return ctx.reply(`✅ Carousel Post Ho Gaya!\nID: ${publishedId}`);
      } else {
        const reelId = await createReelContainer(data.videoUrl, fullCaption);
        for(let i=0;i<10;i++){
          await new Promise(r=>setTimeout(r,5000));
          try{
            const check = await axios.get(`https://graph.facebook.com/v19.0/${reelId}?fields=status_code&access_token=${IG_ACCESS_TOKEN}`);
            if(check.data.status_code === 'FINISHED') break;
          }catch(e){}
        }
        const publishedId = await publishMedia(reelId);
        await db.collection('telegram_uploads').doc(chatId).delete();
        return ctx.reply(`✅ Reel Post Ho Gaya!\nID: ${publishedId}`);
      }
    }catch(err){
      console.error(err.response?.data || err.message);
      return ctx.reply(`❌ Error: ${err.response?.data?.error?.message || err.message}`);
    }
  }
});

bot.on('photo', async (ctx)=>{
  const chatId = String(ctx.chat.id);
  const msg = ctx.message;
  const fileId = msg.photo[msg.photo.length-1].file_id;
  const mediaGroupId = msg.media_group_id;
  const fileUrl = await getTelegramFileUrl(fileId);

  if(mediaGroupId){
    if(!mediaGroupCache.has(mediaGroupId)) mediaGroupCache.set(mediaGroupId, {images:[], chatId, timer:null});
    const group = mediaGroupCache.get(mediaGroupId);
    group.images.push(fileUrl);
    if(group.timer) clearTimeout(group.timer);
    group.timer = setTimeout(async ()=>{
      const finalImages = mediaGroupCache.get(mediaGroupId).images;
      mediaGroupCache.delete(mediaGroupId);
      await db.collection('telegram_uploads').doc(chatId).set({step: 'awaiting_title', images: finalImages.slice(0,10), type: 'carousel', chatId, createdAt: new Date()}, {merge:true});
      ctx.reply(`🔥 ${finalImages.length} images mil gayi!\n\nAb Title bhejo:`);
    }, 2500);
  } else {
    const docRef = db.collection('telegram_uploads').doc(chatId);
    const existing = (await docRef.get()).data();
    const imgs = existing?.images || [];
    imgs.push(fileUrl);
    await docRef.set({images: imgs, step: 'awaiting_title', type: 'carousel', chatId, createdAt: new Date()}, {merge:true});
    ctx.reply(`✅ ${imgs.length} image save! Aur bhejo ya Title likho.`);
  }
});

bot.on('video', async (ctx)=>{
  const chatId = String(ctx.chat.id);
  const fileId = ctx.message.video.file_id;
  const fileUrl = await getTelegramFileUrl(fileId);
  await db.collection('telegram_uploads').doc(chatId).set({step: 'awaiting_title', videoUrl: fileUrl, type: 'reel', chatId, createdAt: new Date()}, {merge:true});
  ctx.reply('🎬 Video mil gayi! Ab Title bhejo:');
});

bot.launch().then(()=> console.log('Bot started - image/video command ready'));
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
