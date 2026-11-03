#include "telegram.h"
#include "config.h"
#include "log_buffer.h"
#include "modbus_poll.h"
#include "version.h"

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <esp_system.h>
#include <stdarg.h>
#include <time.h>

// ВАЖНО про секреты: токен бота входит в URL запросов (/bot<token>/...), поэтому
// URL и тело запросов НИКОГДА не пишутся в лог -- только коды и описание ошибки.

namespace {

enum TgState { TG_OFF = 0, TG_NO_TOKEN, TG_NO_WIFI, TG_NO_TIME, TG_OK, TG_TLS_FAIL, TG_API_ERROR };

struct OutMsg {
  char text[512];
};

QueueHandle_t s_queue = nullptr;
TaskHandle_t s_task = nullptr;
SemaphoreHandle_t s_snapMutex = nullptr;

volatile int s_state = TG_OFF;
char s_lastErr[96] = "";

// Последние значения для /status. Пишет loop() (ядро 1), читает задача (ядро 0).
struct Snapshot {
  float gridV = NAN, gridHz = NAN, loadW = NAN, loadPct = NAN;
  float battV = NAN, battI = NAN, pvV = NAN, pvW = NAN;
  float trafoC = NAN, acRadC = NAN, mode = NAN;
};
Snapshot s_snap;

void setState(int st, const char *err = "") {
  s_state = st;
  strncpy(s_lastErr, err, sizeof(s_lastErr) - 1);
  s_lastErr[sizeof(s_lastErr) - 1] = 0;
}

void enqueue(const char *fmt, ...) {
  if (!s_queue) return;
  OutMsg m;
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(m.text, sizeof(m.text), fmt, ap);
  va_end(ap);
  if (xQueueSend(s_queue, &m, 0) != pdTRUE) {
    logPrintln("[telegram] очередь сообщений переполнена, уведомление пропущено");
  }
}

String num(float v, int digits) {
  if (isnan(v)) return String("—");
  return String(v, digits);
}

String fmtDuration(uint32_t ms) {
  uint32_t s = ms / 1000UL;
  uint32_t d = s / 86400UL, h = (s % 86400UL) / 3600UL, m = (s % 3600UL) / 60UL;
  String out;
  if (d) out += String(d) + " д ";
  if (d || h) out += String(h) + " год ";
  out += String(m) + " хв";
  if (!d && !h) out += " " + String(s % 60UL) + " с";
  return out;
}

const char *resetReasonText() {
  switch (esp_reset_reason()) {
    case ESP_RST_POWERON:   return "увімкнення живлення";
    case ESP_RST_SW:        return "програмне перезавантаження (зміна налаштувань/OTA)";
    case ESP_RST_PANIC:     return "збій прошивки (panic)";
    case ESP_RST_INT_WDT:
    case ESP_RST_TASK_WDT:
    case ESP_RST_WDT:       return "зависання (watchdog)";
    case ESP_RST_BROWNOUT:  return "просідання живлення (brownout)";
    case ESP_RST_EXT:       return "зовнішнє скидання";
    case ESP_RST_DEEPSLEEP: return "вихід зі сну";
    default:                return "невідома причина";
  }
}

const char *modeName(float m) {
  if (isnan(m)) return "—";
  switch ((int)lroundf(m)) {
    case 1: return "SBU (акумулятор/сонце в пріоритеті)";
    case 2: return "SUB";
    case 3: return "UTI (мережа в пріоритеті)";
    case 4: return "SOL (сонце в пріоритеті)";
    default: return "?";
  }
}

String buildStatus() {
  Snapshot s;
  if (s_snapMutex && xSemaphoreTake(s_snapMutex, pdMS_TO_TICKS(100)) == pdTRUE) {
    s = s_snap;
    xSemaphoreGive(s_snapMutex);
  }
  String t = "📊 MUST PV18\n";
  t += "🔌 Мережа: " + num(s.gridV, 0) + " В, " + num(s.gridHz, 2) + " Гц\n";
  t += "🏠 Навантаження: " + num(s.loadW, 0) + " Вт (" + num(s.loadPct, 0) + "%)\n";
  t += "🔋 АКБ: " + num(s.battV, 1) + " В, струм " + num(s.battI, 0) + " А\n";
  t += "☀️ PV: " + num(s.pvV, 0) + " В, " + num(s.pvW, 0) + " Вт\n";
  t += "🌡 Трансформатор: " + num(s.trafoC, 0) + " °C, радіатор AC: " + num(s.acRadC, 0) + " °C\n";
  t += String("⚙️ Режим: ") + modeName(s.mode) + "\n";
  t += String("🔗 Інвертор: ") + (modbusIsHealthy() ? "на зв'язку" : "не відповідає") + "\n";
  t += "🕒 Плата працює: " + fmtDuration(millis());
  return t;
}

// ---------------------------------------------------------------------------
// Пороги и сигналы. Всё ниже вызывается ТОЛЬКО из loop() (ядро 1), поэтому
// состояние автоматов не требует блокировок -- наружу уходит лишь очередь.
// ---------------------------------------------------------------------------

// Сеть: порог потери 150 В, возврата 190 В (гистерезис), 2 замера подряд (~30 с)
int s_gridState = -1;  // -1 неизвестно, 1 есть, 0 нет
int s_gridBad = 0, s_gridGood = 0;
uint32_t s_gridLostMs = 0;

void onGrid(float v) {
  if (!g_config.tg_alert_grid) return;
  if (v < 150.0f) { s_gridBad++; s_gridGood = 0; }
  else if (v >= 190.0f) { s_gridGood++; s_gridBad = 0; }

  if (s_gridState == -1) {
    if (s_gridGood >= 1) s_gridState = 1;
    else if (s_gridBad >= 2) {
      s_gridState = 0;
      s_gridLostMs = millis();
      enqueue("⚠️ Мережі немає (при запуску плати)\n🔋 АКБ: %s В\n🏠 Навантаження: %s Вт",
              num(s_snap.battV, 1).c_str(), num(s_snap.loadW, 0).c_str());
    }
    return;
  }
  if (s_gridState == 1 && s_gridBad >= 2) {
    s_gridState = 0;
    s_gridLostMs = millis();
    enqueue("⚠️ Мережа зникла\n🔋 АКБ: %s В\n🏠 Навантаження: %s Вт",
            num(s_snap.battV, 1).c_str(), num(s_snap.loadW, 0).c_str());
  } else if (s_gridState == 0 && s_gridGood >= 2) {
    s_gridState = 1;
    enqueue("✅ Мережа повернулась\n⏱ Не було: %s\n🔌 %s В\n🔋 АКБ: %s В",
            fmtDuration(millis() - s_gridLostMs).c_str(), num(s_snap.gridV, 0).c_str(),
            num(s_snap.battV, 1).c_str());
  }
}

// АКБ: ниже порога 2 замера подряд; "норма" при +0.5 В выше порога
bool s_battLow = false;
int s_battBad = 0, s_battGood = 0;

void onBattery(float v) {
  if (!g_config.tg_alert_battery) return;
  float low = g_config.tg_batt_low_v;
  if (v < low) { s_battBad++; s_battGood = 0; }
  else if (v >= low + 0.5f) { s_battGood++; s_battBad = 0; }

  if (!s_battLow && s_battBad >= 2) {
    s_battLow = true;
    enqueue("🪫 Низька напруга АКБ: %.1f В (поріг %.1f В)\n🏠 Навантаження: %s Вт\n🔌 Мережа: %s В",
            v, low, num(s_snap.loadW, 0).c_str(), num(s_snap.gridV, 0).c_str());
  } else if (s_battLow && s_battGood >= 2) {
    s_battLow = false;
    enqueue("✅ Напруга АКБ відновилась: %.1f В", v);
  }
}

// Температура: макс. из трансформатора и радиатора AC; "норма" на 5 °C ниже порога
bool s_hot = false;
int s_hotBad = 0, s_hotGood = 0;

void onTemperature() {
  if (!g_config.tg_alert_temp) return;
  float m = NAN;
  if (!isnan(s_snap.trafoC)) m = s_snap.trafoC;
  if (!isnan(s_snap.acRadC) && (isnan(m) || s_snap.acRadC > m)) m = s_snap.acRadC;
  if (isnan(m)) return;
  float lim = g_config.tg_temp_limit_c;
  if (m > lim) { s_hotBad++; s_hotGood = 0; }
  else if (m <= lim - 5.0f) { s_hotGood++; s_hotBad = 0; }

  if (!s_hot && s_hotBad >= 2) {
    s_hot = true;
    enqueue("🔥 Перегрів інвертора\n🌡 Трансформатор: %s °C, радіатор AC: %s °C (поріг %.0f °C)\n🏠 Навантаження: %s Вт",
            num(s_snap.trafoC, 0).c_str(), num(s_snap.acRadC, 0).c_str(), lim, num(s_snap.loadW, 0).c_str());
  } else if (s_hot && s_hotGood >= 2) {
    s_hot = false;
    enqueue("✅ Температура в нормі: трансформатор %s °C, радіатор AC %s °C",
            num(s_snap.trafoC, 0).c_str(), num(s_snap.acRadC, 0).c_str());
  }
}

// ---------------------------------------------------------------------------
// Сеть
// ---------------------------------------------------------------------------

WiFiClientSecure s_client;

// Один HTTPS-запрос к Bot API. Возвращает true только при HTTP 200 и ok:true.
// Новое соединение на каждый запрос: рукопожатие дороже keep-alive, но не
// страдает от протухших сессий -- при long-poll раз в ~20 с это приемлемо.
bool apiCall(const char *method, const String &pathAndQuery, const String &body, JsonDocument &out,
             int timeoutSec) {
  HTTPClient http;
  String url = String("https://api.telegram.org/bot") + g_config.tg_token + pathAndQuery;
  if (!http.begin(s_client, url)) {
    setState(TG_TLS_FAIL, "http.begin failed");
    return false;
  }
  http.setTimeout((uint32_t)timeoutSec * 1000UL);
  http.setReuse(false);

  int code;
  if (body.length()) {
    http.addHeader("Content-Type", "application/json");
    code = http.POST(body);
  } else {
    code = http.GET();
  }

  if (code < 0) {
    // Сюда попадают и сбой TLS (сертификат/время), и обрыв связи
    char e[80];
    snprintf(e, sizeof(e), "%s: %s", method, HTTPClient::errorToString(code).c_str());
    setState(TG_TLS_FAIL, e);
    http.end();
    s_client.stop();
    return false;
  }

  String resp = http.getString();
  http.end();
  s_client.stop();

  DeserializationError de = deserializeJson(out, resp);
  bool apiOk = !de && out["ok"] == true;
  if (code == 200 && apiOk) {
    setState(TG_OK);
    return true;
  }
  char e[96];
  const char *desc = out["description"] | "";
  snprintf(e, sizeof(e), "HTTP %d %s", code, desc);
  setState(TG_API_ERROR, e);
  return false;
}

bool sendMessage(const char *text) {
  JsonDocument req;
  req["chat_id"] = g_config.tg_chat_id;
  req["text"] = text;
  String body;
  serializeJson(req, body);
  JsonDocument resp;
  bool ok = apiCall("sendMessage", "/sendMessage", body, resp, 15);
  if (!ok) logPrintf("[telegram] sendMessage не вдалося: %s", s_lastErr);
  return ok;
}

// Long-poll getUpdates. offset: следующий update_id (после обработки +1).
// skipBacklog: только узнать последний update_id, ничего не обрабатывая
// (иначе после перезагрузки ответили бы на старые команды).
bool pollUpdates(long long &offset, bool skipBacklog) {
  String path = "/getUpdates?";
  if (skipBacklog) path += "offset=-1&timeout=0";
  else path += "timeout=20&offset=" + String((long)offset) + "&allowed_updates=%5B%22message%22%5D";

  JsonDocument resp;
  if (!apiCall("getUpdates", path, "", resp, skipBacklog ? 15 : 35)) return false;

  for (JsonObject upd : resp["result"].as<JsonArray>()) {
    long long id = upd["update_id"] | 0LL;
    if (id + 1 > offset) offset = id + 1;
    if (skipBacklog) continue;

    JsonObject msg = upd["message"];
    if (msg.isNull()) continue;
    char chat[24];
    snprintf(chat, sizeof(chat), "%lld", (long long)(msg["chat"]["id"] | 0LL));
    if (g_config.tg_chat_id != chat) {
      logPrintln("[telegram] повідомлення з чужого чату проігноровано");
      continue;  // команды принимаем только из настроенного чата
    }
    String text = (const char *)(msg["text"] | "");
    text.trim();
    if (text.startsWith("/status") || text.startsWith("/start")) {
      sendMessage(buildStatus().c_str());
    } else if (text.startsWith("/help")) {
      sendMessage("Команди:\n/status — поточні показники інвертора");
    }
  }
  return true;
}

void tgTaskFn(void *) {
  s_client.useBuiltinCACertBundle();  // проверяем сертификат Telegram, не setInsecure()

  OutMsg pending;
  bool havePending = false;
  int pendingTries = 0;
  uint32_t backoffUntil = 0;
  long long offset = 0;
  bool haveOffset = false;

  for (;;) {
    if (!g_config.tg_enabled) { setState(TG_OFF); vTaskDelay(pdMS_TO_TICKS(1000)); continue; }
    if (g_config.tg_token.length() == 0 || g_config.tg_chat_id.length() == 0) {
      setState(TG_NO_TOKEN, "token/chat_id не заданы");
      vTaskDelay(pdMS_TO_TICKS(2000));
      continue;
    }
    if (WiFi.status() != WL_CONNECTED) { setState(TG_NO_WIFI); vTaskDelay(pdMS_TO_TICKS(2000)); continue; }
    if (time(nullptr) < 1700000000) {  // сертификат нельзя проверить без правильного времени (NTP)
      setState(TG_NO_TIME, "час не синхронізовано");
      vTaskDelay(pdMS_TO_TICKS(2000));
      continue;
    }
    if (millis() < backoffUntil) { vTaskDelay(pdMS_TO_TICKS(500)); continue; }

    // 1) исходящие (приоритетнее long-poll)
    if (!havePending && xQueueReceive(s_queue, &pending, 0) == pdTRUE) {
      havePending = true;
      pendingTries = 0;
    }
    if (havePending) {
      if (sendMessage(pending.text)) {
        havePending = false;
      } else if (++pendingTries >= 3) {
        logPrintln("[telegram] повідомлення втрачено після 3 спроб");
        havePending = false;
      } else {
        backoffUntil = millis() + 5000UL * pendingTries;
      }
      continue;
    }

    // 2) входящие команды
    if (!haveOffset) {
      if (pollUpdates(offset, true)) haveOffset = true;
      else backoffUntil = millis() + 10000;
      continue;
    }
    if (!pollUpdates(offset, false)) backoffUntil = millis() + 10000;
  }
}

}  // namespace

void telegramTaskStart() {
  s_queue = xQueueCreate(8, sizeof(OutMsg));
  s_snapMutex = xSemaphoreCreateMutex();
  // Стек с запасом: mbedTLS-рукопожатие и разбор JSON глубоко в стеке
  xTaskCreatePinnedToCore(tgTaskFn, "telegram", 12288, nullptr, 1, &s_task, 0);
  logPrintln("[telegram] задача создана (ядро 0)");
}

void telegramOnValue(const String &name, float value) {
  if (!g_config.tg_enabled) return;

  // Снимок для /status. Мьютекс берём с коротким таймаутом: если задачу
  // приостановили (Pause) прямо на удержании -- loop() не должен зависнуть.
  if (s_snapMutex && xSemaphoreTake(s_snapMutex, pdMS_TO_TICKS(20)) == pdTRUE) {
    if (name == "GridVoltage") s_snap.gridV = value;
    else if (name == "GridFrequency") s_snap.gridHz = value;
    else if (name == "PLoad") s_snap.loadW = value;
    else if (name == "LoadPercent") s_snap.loadPct = value;
    else if (name == "BatteryVoltage") s_snap.battV = value;
    else if (name == "BattCurrent") s_snap.battI = value;
    else if (name == "PvVoltage") s_snap.pvV = value;
    else if (name == "ChargerPower") s_snap.pvW = value;
    else if (name == "TransformerTemperature") s_snap.trafoC = value;
    else if (name == "AcRadiatorTemperature") s_snap.acRadC = value;
    else if (name == "EnergyUseMode") s_snap.mode = value;
    xSemaphoreGive(s_snapMutex);
  }

  // Каждую проверку запускаем ровно раз за цикл опроса -- на "своём" регистре
  if (name == "GridVoltage") onGrid(value);
  else if (name == "BatteryVoltage") onBattery(value);
  else if (name == "TransformerTemperature") onTemperature();
}

void telegramLoop() {
  if (!g_config.tg_enabled) return;
  static uint32_t lastCheck = 0;
  uint32_t now = millis();
  if (now - lastCheck < 2000) return;
  lastCheck = now;

  // Приветствие после загрузки: заодно говорит, что электричество вернулось, и почему
  // плата перезагружалась (brownout/panic/watchdog -- полезно для диагностики).
  static bool bootSent = false;
  if (!bootSent && now > 25000 && WiFi.status() == WL_CONNECTED &&
      g_config.tg_token.length() && g_config.tg_chat_id.length()) {
    bootSent = true;
    enqueue("🔄 Плату запущено\nПричина: %s\nПрошивка: %s\n🔌 Мережа: %s В, 🔋 АКБ: %s В\n/status — поточні показники",
            resetReasonText(), FIRMWARE_VERSION, num(s_snap.gridV, 0).c_str(), num(s_snap.battV, 1).c_str());
  }

  // Потеря связи с инвертором дольше N минут
  static uint32_t badSince = 0;
  static bool mbAlerted = false;
  if (modbusIsHealthy()) {
    if (mbAlerted) {
      mbAlerted = false;
      enqueue("✅ Зв'язок з інвертором відновлено");
    }
    badSince = 0;
  } else {
    if (badSince == 0) badSince = now ? now : 1;
    uint32_t limitMs = (uint32_t)max(1, g_config.tg_modbus_minutes) * 60000UL;
    if (g_config.tg_alert_modbus && !mbAlerted && now - badSince >= limitMs) {
      mbAlerted = true;
      enqueue("⚠️ Інвертор не відповідає по RS485 вже %s\nПеревірте живлення RS485-модуля та кабель.",
              fmtDuration(now - badSince).c_str());
    }
  }
}

const char *telegramStateCode() {
  switch (s_state) {
    case TG_OFF: return "off";
    case TG_NO_TOKEN: return "no_token";
    case TG_NO_WIFI: return "no_wifi";
    case TG_NO_TIME: return "no_time";
    case TG_OK: return "ok";
    case TG_TLS_FAIL: return "tls_fail";
    default: return "api_error";
  }
}

String telegramLastError() { return String(s_lastErr); }

bool telegramSendTest(String &errorOut) {
  if (!g_config.tg_enabled) { errorOut = "Telegram вимкнено в налаштуваннях"; return false; }
  if (g_config.tg_token.length() == 0 || g_config.tg_chat_id.length() == 0) {
    errorOut = "не задано токен або chat_id";
    return false;
  }
  enqueue("✅ Тестове повідомлення від MUST PV18\nСповіщення працюють. Команда /status покаже поточні показники.");
  return true;
}

void telegramTaskPause() {
  if (s_task) vTaskSuspend(s_task);
}

void telegramTaskResume() {
  if (s_task) vTaskResume(s_task);
}
