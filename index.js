const { VK } = require("vk-io");
const { Bot, Keyboard } = require("@maxhub/max-bot-api");
require("dotenv").config();

if (typeof global.fetch === "undefined") global.fetch = require("node-fetch");

const vk = new VK({
  token: process.env.VK_GROUP_TOKEN,
  pollingGroupId: process.env.VK_GROUP_ID,
});

const bot = new Bot(process.env.MAX_BOT_TOKEN);
const MAX_CHAT_ID = process.env.MAX_CHAT_ID;

let lastPost = null;
let lastPostError = null;
let isBotHealthy = true;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;

// ========== КЛАВИАТУРЫ ==========
const adminKeyboard = Keyboard.inlineKeyboard([
  [Keyboard.button.callback("🔄 Попробовать еще раз", "retry_last_post")],
  [Keyboard.button.callback("📊 Статус бота", "bot_status")],
]);

// ========== ФУНКЦИИ С RETRY ==========

async function withRetry(fn, maxRetries = 3, delay = 1000) {
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      console.log(
        `⚠️ Попытка ${attempt}/${maxRetries} не удалась: ${error.message}`,
      );
      if (attempt < maxRetries) {
        const waitTime = delay * Math.pow(2, attempt - 1);
        console.log(`⏳ Ожидание ${waitTime}мс перед повторной попыткой...`);
        await new Promise((resolve) => setTimeout(resolve, waitTime));
      }
    }
  }
  throw lastError;
}

// ========== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ==========

// Преобразование ссылок VK
function fixVKLinks(text) {
  if (!text) return "";
  return text.replace(/\[#alias\|([^|\]]+)\|([^|\]]+)\]/g, "$2");
}

// Получение ссылки на пост в VK
function getVKPostLink(post) {
  return `https://vk.com/wall${post.owner_id}_${post.id}`;
}

// Проверка наличия видео в посте
function hasVideo(post) {
  if (!post.attachments) return false;
  return post.attachments.some((attach) => attach.type === "video");
}

// Получение лучшего фото
function getBestPhoto(photo) {
  if (!photo?.sizes) return null;
  return photo.sizes.reduce((a, b) =>
    b.width * b.height > a.width * a.height ? b : a,
  ).url;
}

// ========== ОТПРАВКА В MAX ==========
async function sendToMax(text, images = [], post = null) {
  try {
    let fixedText = fixVKLinks(text);
    const attachments = [];
    let failedImages = 0;

    // Загружаем картинки — каждая отдельно, ошибки не прерывают процесс
    for (const url of images.slice(0, 10)) {
      try {
        const img = await withRetry(
          async () => {
            return await bot.api.uploadImage({ url });
          },
          2,
          1000,
        );
        attachments.push(img.toJson());
        console.log(`✅ Фото загружено`);
      } catch (e) {
        failedImages++;
        console.log(`⚠️ Не удалось загрузить фото: ${e.message}`);
      }
    }

    // Если есть видео или не все картинки загрузились — добавляем ссылку на пост
    const hasVideoContent = post && hasVideo(post);
    const someImagesFailed = failedImages > 0;

    if (post && (hasVideoContent || someImagesFailed)) {
      const postLink = getVKPostLink(post);
      const note = hasVideoContent
        ? `\n\n🎬 В посте есть видео. Смотреть в VK: ${postLink}`
        : `\n\n📎 Часть вложений недоступна. Оригинал: ${postLink}`;
      fixedText += note;
      console.log(
        `🔗 Добавлена ссылка на пост в VK (видео: ${hasVideoContent}, ошибок фото: ${failedImages})`,
      );
    }

    // Если вообще нет контента — отправляем только ссылку
    if (!fixedText.trim() && attachments.length === 0) {
      if (post) {
        await withRetry(
          async () => {
            await bot.api.sendMessageToChat(
              MAX_CHAT_ID,
              `📎 Новый пост в VK: ${getVKPostLink(post)}`,
              { format: "markdown" },
            );
          },
          3,
          2000,
        );
        console.log(`✅ Отправлена ссылка на пост`);
        await notifyAdmin(`✅ Отправлена ссылка на пост (без медиа)`, false);
        return true;
      }
      return false;
    }

    // Отправляем сообщение
    await withRetry(
      async () => {
        await bot.api.sendMessageToChat(
          MAX_CHAT_ID,
          fixedText ||
            (attachments.length > 0 ? "📸 Новый пост" : "📝 Новый пост"),
          {
            attachments: attachments.length > 0 ? attachments : undefined,
            format: "markdown",
          },
        );
      },
      3,
      2000,
    );

    console.log(
      `✅ Пост отправлен в MAX (фото: ${attachments.length}, ошибок: ${failedImages})`,
    );
    await notifyAdmin(
      `✅ Пост успешно отправлен в MAX (фото: ${attachments.length})`,
      false,
    );
    return true;
  } catch (error) {
    console.error(`❌ Ошибка отправки в MAX: ${error.message}`);
    await notifyAdmin(`❌ Ошибка отправки в MAX: ${error.message}`, true);
    return false;
  }
}

// ========== УВЕДОМЛЕНИЕ АДМИНА ==========
async function notifyAdmin(message, showRetryButton = false) {
  try {
    const options = showRetryButton ? { attachments: [adminKeyboard] } : {};
    await withRetry(
      async () => {
        await bot.api.sendMessageToUser(
          process.env.SUPER_ADMIN_ID_MAX,
          message,
          options,
        );
      },
      2,
      1000,
    );
  } catch (e) {
    console.error("❌ Не удалось отправить уведомление админу:", e.message);
  }
}

// ========== РЕПОСТ ==========
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

  const success = await sendToMax(text, images, post);

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
  try {
    const post = ctx.wall;

    lastPost = post;
    lastPostError = null;

    console.log(`\n📥 Новый пост из VK:`);
    console.log(
      `📝 Оригинальный текст: ${post.text?.substring(0, 100) || "нет текста"}...`,
    );

    const text = post.text || "";
    const images = [];
    let hasVideoContent = false;

    if (post.attachments) {
      for (const attach of post.attachments) {
        if (attach.type === "photo" && attach.payload) {
          const url = getBestPhoto(attach.payload);
          if (url) {
            images.push(url);
            console.log(`🖼 Найдено фото`);
          }
        }
        if (attach.type === "video") {
          hasVideoContent = true;
          console.log(`🎬 Найдено видео`);
        }
      }
    }

    if (text.trim() || images.length > 0 || hasVideoContent) {
      const success = await sendToMax(text, images, post);
      if (!success) {
        lastPostError = "Ошибка при отправке поста";
      }
    } else {
      console.log(`⏭ Пропущен пустой пост`);
    }
  } catch (error) {
    console.error("❌ Ошибка в обработчике wall_post_new:", error.message);
    await notifyAdmin(`❌ Ошибка обработки поста: ${error.message}`, true);
  }
});

// ========== ОБРАБОТЧИК СООБЩЕНИЙ ==========
bot.on("message_created", async (ctx) => {
  try {
    const messageText = ctx.message?.body?.text || "";
    const userId = ctx.message.sender.user_id;

    console.log(`📩 Получено сообщение от ${userId}: "${messageText}"`);

    if (String(userId) !== String(process.env.SUPER_ADMIN_ID_MAX)) {
      return;
    }

    if (messageText === "/repost" || messageText === "🔄 Попробовать еще раз") {
      await repostLastPost();
      return;
    }

    if (messageText === "/status" || messageText === "📊 Статус бота") {
      console.log("🔍 Вошли в блок /status");
      const status = lastPost
        ? `✅ Есть сохраненный пост от ${new Date(lastPost.date * 1000).toLocaleString()}`
        : "❌ Нет сохраненных постов";

      await bot.api.sendMessageToUser(
        process.env.SUPER_ADMIN_ID_MAX,
        `📊 Статус бота:\n${status}\nОшибок: ${lastPostError || "нет"}\nЗдоровье: ${isBotHealthy ? "✅" : "❌"}`,
        { attachments: [adminKeyboard] },
      );
      return;
    }

    await bot.api.sendMessageToUser(
      process.env.SUPER_ADMIN_ID_MAX,
      "Доступные команды:\n/repost - повторить последний пост\n/status - статус бота",
      { attachments: [adminKeyboard] },
    );
  } catch (error) {
    console.error("❌ Ошибка в обработчике сообщений:", error.message);
  }
});

// ========== ОБРАБОТЧИК CALLBACK КНОПОК ==========
bot.action("retry_last_post", async (ctx) => {
  try {
    const userId = ctx.callback.user.user_id;
    if (String(userId) !== String(process.env.SUPER_ADMIN_ID_MAX)) {
      await ctx.reply("❌ Нет доступа");
      return;
    }
    await ctx.reply("🔄 Пробую переопубликовать...");
    await repostLastPost();
  } catch (error) {
    console.error("❌ Ошибка в callback retry:", error.message);
  }
});

bot.action("bot_status", async (ctx) => {
  try {
    const userId = ctx.callback.user.user_id;
    if (String(userId) !== String(process.env.SUPER_ADMIN_ID_MAX)) {
      await ctx.reply("❌ Нет доступа");
      return;
    }

    const status = lastPost
      ? `✅ Пост "${lastPost.text?.substring(0, 50)}..." с ${lastPost.attachments?.length || 0} вложениями`
      : "❌ Нет постов";

    await ctx.reply(
      `📊 Статус бота:\n${status}\nОшибок: ${lastPostError || "нет"}\nЗдоровье: ${isBotHealthy ? "✅" : "❌"}`,
      { attachments: [adminKeyboard] },
    );
  } catch (error) {
    console.error("❌ Ошибка в callback status:", error.message);
  }
});

// ========== ЗАПУСК С ВОССТАНОВЛЕНИЕМ ==========
async function startBotWithRecovery() {
  try {
    console.log("🚀 Запуск бота...");

    await vk.updates.startPolling();
    console.log("✅ VK polling запущен");

    await bot.start();
    console.log("✅ MAX бот запущен");

    isBotHealthy = true;
    reconnectAttempts = 0;

    console.log("\n🚀 Кросспостинг VK → MAX запущен!");
    console.log(`💬 MAX чат ID: ${MAX_CHAT_ID}`);
    console.log("⏳ Ожидание новых постов...\n");

    await bot.api.sendMessageToUser(
      process.env.SUPER_ADMIN_ID_MAX,
      "🤖 Бот запущен!\n\nДоступные команды:\n/repost - повторить последний пост\n/status - статус бота",
      { attachments: [adminKeyboard] },
    );
    console.log("✅ Админ оповещен\n");
  } catch (error) {
    console.error("❌ Ошибка запуска:", error.message);
    await handleBotCrash(error);
  }
}

// ========== ОБРАБОТКА КРАША ==========
async function handleBotCrash(error) {
  console.error("💥 Бот упал:", error.message);
  isBotHealthy = false;

  try {
    await notifyAdmin(
      `⚠️ Бот упал: ${error.message}\nПопытка перезапуска...`,
      false,
    );
  } catch (e) {
    console.error("❌ Не удалось оповестить админа о краше");
  }

  reconnectAttempts++;

  if (reconnectAttempts <= MAX_RECONNECT_ATTEMPTS) {
    const delay = 5000 * Math.pow(2, reconnectAttempts - 1);
    console.log(
      `⏳ Перезапуск через ${delay / 1000} секунд (попытка ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`,
    );

    setTimeout(async () => {
      try {
        try {
          await bot.stop();
        } catch (e) {}
        try {
          await vk.updates.stopPolling();
        } catch (e) {}
        await startBotWithRecovery();
      } catch (error) {
        console.error("❌ Критическая ошибка при перезапуске:", error);
        await handleBotCrash(error);
      }
    }, delay);
  } else {
    console.error("❌ Достигнут лимит попыток перезапуска. Бот остановлен.");
    await notifyAdmin(
      `❌ Бот остановлен. Достигнут лимит попыток перезапуска (${MAX_RECONNECT_ATTEMPTS}). Требуется ручное вмешательство.`,
      true,
    );
    process.exit(1);
  }
}

// ========== ПЕРЕХВАТ ОШИБОК POLLING ==========
const originalPollingLoop = bot.start;
bot.start = async function () {
  try {
    await originalPollingLoop.call(this);
  } catch (error) {
    console.error("❌ Ошибка в polling бота:", error.message);
    await handleBotCrash(error);
  }
};

// ========== ЗАПУСК ==========
startBotWithRecovery();

// ========== ОБРАБОТКА СИГНАЛОВ ==========
process.on("SIGINT", async () => {
  console.log("\n👋 Получен сигнал остановки...");
  try {
    await bot.stop();
    await vk.updates.stopPolling();
  } catch (e) {}
  console.log("👋 Бот остановлен");
  process.exit(0);
});

process.on("uncaughtException", async (error) => {
  console.error("💥 Необработанное исключение:", error);
  await handleBotCrash(error);
});

process.on("unhandledRejection", async (reason, promise) => {
  console.error("💥 Необработанный rejection:", reason);
  await handleBotCrash(reason);
});
