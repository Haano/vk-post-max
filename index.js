const { VK } = require("vk-io");
const { Bot, Keyboard } = require("@maxhub/max-bot-api");
require("dotenv").config();
const path = require("path");
const fs = require("fs");

if (typeof global.fetch === "undefined") global.fetch = require("node-fetch");

const vk = new VK({
  token: process.env.VK_GROUP_TOKEN,
  pollingGroupId: process.env.VK_GROUP_ID,
});

const bot = new Bot(process.env.MAX_BOT_TOKEN);
const MAX_CHAT_ID = process.env.MAX_CHAT_ID;

let lastPost = null;
let lastPostError = null;

// ========== КЛАВИАТУРЫ ==========
// Клавиатура для админа
const adminKeyboard = Keyboard.inlineKeyboard([
  [Keyboard.button.callback("🔄 Попробовать еще раз", "retry_last_post")],
  [Keyboard.button.callback("📊 Статус бота", "bot_status")],
]);

// ========== ФУНКЦИИ ==========

// Функция для преобразования ссылок VK в нормальный вид
function fixVKLinks(text) {
  if (!text) return "";
  return text.replace(/\[#alias\|([^|\]]+)\|([^|\]]+)\]/g, "$2");
}

// Функция для получения лучшего фото
function getBestPhoto(photo) {
  if (!photo?.sizes) return null;
  return photo.sizes.reduce((a, b) =>
    b.width * b.height > a.width * a.height ? b : a,
  ).url;
}

// Функция отправки в MAX (возвращает успех/ошибку)
async function sendToMax(text, images = []) {
  try {
    const fixedText = fixVKLinks(text);
    const attachments = [];

    // Загружаем картинки
    for (const url of images.slice(0, 10)) {
      try {
        const img = await bot.api.uploadImage({ url });
        attachments.push(img.toJson());
        console.log(`✅ Фото загружено`);
      } catch (e) {
        console.log(`⚠️ Не удалось загрузить фото: ${e.message}`);
        await notifyAdmin(`⚠️ Не удалось загрузить фото: ${e.message}`, true);
      }
    }

    // Отправляем сообщение
    await bot.api.sendMessageToChat(
      MAX_CHAT_ID,
      fixedText || (images.length > 0 ? "📸 Новый пост" : "📝 Новый пост"),
      {
        attachments: attachments.length > 0 ? attachments : undefined,
        format: "markdown",
      },
    );

    console.log(`✅ Пост отправлен в MAX`);
    await notifyAdmin(`✅ Пост успешно отправлен в MAX`, false);
    return true;
  } catch (error) {
    console.error(`❌ Ошибка отправки в MAX: ${error.message}`);
    await notifyAdmin(`❌ Ошибка отправки в MAX: ${error.message}`, true);
    return false;
  }
}

// Функция для уведомления админа
async function notifyAdmin(message, showRetryButton = false) {
  try {
    const options = showRetryButton ? { attachments: [adminKeyboard] } : {};

    await bot.api.sendMessageToUser(
      process.env.SUPER_ADMIN_ID_MAX,
      message,
      options,
    );
  } catch (e) {
    console.error("❌ Не удалось отправить уведомление админу:", e.message);
  }
}

// ========== ФУНКЦИЯ РЕПОСТА ==========
async function repostLastPost() {
  if (!lastPost) {
    await notifyAdmin("❌ Нет сохраненного поста для репоста");
    return false;
  }

  console.log("\n🔄 Попытка повторной публикации...");
  await notifyAdmin("🔄 Начинаю повторную публикацию...");

  const post = lastPost;
  const text = post.text || "";
  const images = [];

  // Собираем картинки из вложений
  if (post.attachments) {
    for (const attach of post.attachments) {
      if (attach.type === "photo" && attach.payload) {
        const url = getBestPhoto(attach.payload);
        if (url) {
          images.push(url);
        }
      }
    }
  }

  // Пробуем отправить
  const success = await sendToMax(text, images);

  if (success) {
    console.log("✅ Пост успешно переопубликован!");
    await notifyAdmin("✅ Пост успешно переопубликован!", false);
  } else {
    console.log("❌ Повторная публикация не удалась");
  }

  return success;
}

// ========== ОБРАБОТЧИК НОВЫХ ПОСТОВ VK ==========
vk.updates.on("wall_post_new", async (ctx) => {
  const post = ctx.wall;

  // Сохраняем пост для возможного репоста
  lastPost = post;
  lastPostError = null;

  console.log(`\n📥 Новый пост из VK:`);
  console.log(
    `📝 Оригинальный текст: ${post.text?.substring(0, 100) || "нет текста"}...`,
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
    const success = await sendToMax(text, images);
    if (!success) {
      lastPostError = "Ошибка при отправке поста";
    }
  } else {
    console.log(`⏭ Пропущен пустой пост`);
  }
});

// ========== ОБРАБОТЧИК СООБЩЕНИЙ (ваш стиль) ==========
bot.on("message_created", async (ctx) => {
  const messageText = ctx.message?.body?.text || "";
  const userId = ctx.message.sender.user_id;

  console.log(`📩 Получено сообщение от ${userId}: "${messageText}"`);
  // Проверяем, что сообщение от админа
  if (String(userId) !== String(process.env.SUPER_ADMIN_ID_MAX)) {
    // Если не админ - игнорируем или отвечаем
    return;
  }

  // Обработка команд
  if (messageText === "/repost" || messageText === "🔄 Попробовать еще раз") {
    await repostLastPost();
    return;
  }

  if (messageText === "/status" || messageText === "📊 Статус бота") {
    console.log("🔍 Вошли в блок /status");
    console.log("📦 lastPost:", lastPost);
    const status = lastPost
      ? `✅ Есть сохраненный пост от ${new Date(lastPost.date * 1000).toLocaleString()}`
      : "❌ Нет сохраненных постов";

    await bot.api.sendMessageToUser(
      process.env.SUPER_ADMIN_ID_MAX,
      `📊 Статус бота:\n${status}\nОшибок: ${lastPostError || "нет"}`,
      { attachments: [adminKeyboard] },
    );
    return;
  }

  // Если сообщение не распознано - показываем подсказку
  await bot.api.sendMessageToUser(
    process.env.SUPER_ADMIN_ID_MAX,
    "Доступные команды:\n/repost - повторить последний пост\n/status - статус бота",
    { attachments: [adminKeyboard] },
  );
});

// ========== ОБРАБОТЧИК CALLBACK КНОПОК ==========
bot.action("retry_last_post", async (ctx) => {
  const userId = ctx.callback.user.user_id;

  // Проверяем, что нажатие от админа
  if (String(userId) !== String(process.env.SUPER_ADMIN_ID_MAX)) {
    await ctx.reply("❌ Нет доступа");
    return;
  }

  await ctx.reply("🔄 Пробую переопубликовать...");
  await repostLastPost();
});

bot.action("bot_status", async (ctx) => {
  const userId = ctx.callback.user.user_id;

  // Проверяем, что нажатие от админа
  if (String(userId) !== String(process.env.SUPER_ADMIN_ID_MAX)) {
    await ctx.reply("❌ Нет доступа");
    return;
  }

  const status = lastPost
    ? `✅ Пост "${lastPost.text}" с ${lastPost.attachments.length} вложениями`
    : "❌ Нет постов";

  await ctx.reply(
    `📊 Статус бота:\n${status}\nОшибок: ${lastPostError || "нет"}`,
    { attachments: [adminKeyboard] },
  );
});

// ========== ЗАПУСК ==========
(async () => {
  try {
    await vk.updates.startPolling();
    bot.start();

    console.log("\n🚀 Кросспостинг VK → MAX запущен!");
    console.log(`💬 MAX чат ID: ${MAX_CHAT_ID}`);
    console.log("⏳ Ожидание новых постов...\n");

    // Отправляем приветствие админу
    await bot.api.sendMessageToUser(
      process.env.SUPER_ADMIN_ID_MAX,
      "🤖 Бот запущен!\n\nДоступные команды:\n/repost - повторить последний пост\n/status - статус бота",
      { attachments: [adminKeyboard] },
    );
    console.log("Админа оповестили...\n");
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
