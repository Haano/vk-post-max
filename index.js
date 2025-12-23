const { VK } = require("vk-io");
const { Bot } = require("@maxhub/max-bot-api");
require("dotenv").config();

if (typeof global.fetch === "undefined") global.fetch = require("node-fetch");

const vk = new VK({
  token: process.env.VK_GROUP_TOKEN,
  pollingGroupId: process.env.VK_GROUP_ID,
});

const maxBot = new Bot(process.env.MAX_BOT_TOKEN);
const MAX_CHAT_ID = process.env.MAX_CHAT_ID;

// Функция для преобразования ссылок VK в нормальный вид
function fixVKLinks(text) {
  if (!text) return "";

  // Регулярное выражение для ссылок вида [#alias|текст|ссылка]
  return text.replace(/\[#alias\|([^|\]]+)\|([^|\]]+)\]/g, "$2");

  // ИЛИ просто извлекаем URL (если нужна чистая ссылка):
  // return text.replace(/\[#alias\|([^|\]]+)\|([^|\]]+)\]/g, '$2');
}

// Функция для получения лучшего фото
function getBestPhoto(photo) {
  if (!photo?.sizes) return null;
  return photo.sizes.reduce((a, b) =>
    b.width * b.height > a.width * a.height ? b : a
  ).url;
}

// Функция отправки в MAX
async function sendToMax(text, images = []) {
  try {
    // Фиксируем ссылки в тексте
    const fixedText = fixVKLinks(text);

    const attachments = [];

    // Загружаем картинки
    for (const url of images.slice(0, 10)) {
      try {
        const img = await maxBot.api.uploadImage({ url });
        attachments.push(img.toJson());
        console.log(`✅ Фото загружено`);
      } catch (e) {
        console.log(`⚠️  Не удалось загрузить фото: ${e.message}`);
      }
    }

    // Отправляем сообщение
    await maxBot.api.sendMessageToChat(
      MAX_CHAT_ID,
      fixedText || (images.length > 0 ? "📸 Новый пост" : "📝 Новый пост"),
      {
        attachments: attachments.length > 0 ? attachments : undefined,
        format: "markdown", // Включаем поддержку Markdown
      }
    );

    console.log(`✅ Пост отправлен в MAX`);
    return true;
  } catch (error) {
    console.error(`❌ Ошибка отправки в MAX: ${error.message}`);
    return false;
  }
}

// Обработчик новых постов
vk.updates.on("wall_post_new", async (ctx) => {
  const post = ctx.wall;

  console.log(`\n📥 Новый пост из VK:`);
  console.log(
    `📝 Оригинальный текст: ${post.text?.substring(0, 100) || "нет текста"}...`
  );

  const text = post.text || "";
  const images = [];

  // Собираем картинки из вложений
  if (post.attachments) {
    for (const attach of post.attachments) {
      if (attach.type === "photo" && attach.payload) {
        const url = getBestPhoto(attach.payload);
        if (url) {
          images.push(url);
          console.log(`🖼 Найдено фото`);
        }
      }
    }
  }

  // Отправляем если есть либо текст, либо картинки
  if (text.trim() || images.length > 0) {
    await sendToMax(text, images);
  } else {
    console.log(`⏭ Пропущен пустой пост`);
  }
});

// Запуск
(async () => {
  try {
    await vk.updates.startPolling();
    await maxBot.start();
    console.log("\n🚀 Кросспостинг VK → MAX запущен!");
    console.log(`💬 MAX чат ID: ${MAX_CHAT_ID}`);
    console.log("⏳ Ожидание новых постов...\n");
  } catch (error) {
    console.error("❌ Ошибка запуска:", error.message);
    process.exit(1);
  }
})();

// Обработка Ctrl+C
process.on("SIGINT", () => {
  console.log("\n👋 Остановка...");
  process.exit(0);
});
