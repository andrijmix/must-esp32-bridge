#pragma once
#include <Arduino.h>

// Telegram-уведомления и команда /status.
//
// Сеть (HTTPS к api.telegram.org) живёт в отдельной FreeRTOS-задаче (ядро 0,
// как Modbus и MQTT): TLS-рукопожатие и long-poll блокирующие, и на медленном
// интернете они не должны подвешивать веб-интерфейс на ядре 1.
// Проверка порогов (сеть пропала, АКБ, перегрев) -- в основном loop(), без
// сети: она только кладёт готовый текст в очередь сообщений задаче.
//
// Выключено по умолчанию (g_config.tg_enabled). Токен бота -- секрет, вводится
// в веб-конфиге. Команды принимаем ТОЛЬКО из чата g_config.tg_chat_id.

void telegramTaskStart();

// Из ЛЮБОГО места основного loop(): вызывать на каждое прочитанное значение
// регистра (рядом с mqttPublishValue). Дёшево, сеть не трогает.
void telegramOnValue(const String &name, float value);

// Из loop(): проверки, которым не нужен новый отсчёт (потеря связи с
// инвертором, приветствие при загрузке).
void telegramLoop();

// "off" | "no_token" | "no_wifi" | "no_time" | "ok" | "tls_fail" | "api_error"
const char *telegramStateCode();
// Краткий текст последней ошибки ("" если всё хорошо).
String telegramLastError();

// Поставить в очередь тестовое сообщение. false + причина в errorOut, если
// Telegram выключен/не настроен.
bool telegramSendTest(String &errorOut);

// Приостановить/возобновить -- вокруг замены g_config целиком (как у MQTT).
void telegramTaskPause();
void telegramTaskResume();
