// Дашборд MUST PV18 для прошивки must-esp32-bridge.
// Розмітка і стилі — з https://github.com/VladRoma/must_pv18-3224-settings (MIT);
// логіка переписана під API самої плати: /api/status, /api/config,
// /api/history, /api/modbus/write. Python-бекенд і BMS не потрібні.

const MIN_REFRESH_MS = 5000;
const RETRY_MS = 5000;
const HISTORY_POINTS = 300;     // скільки точок просимо в /api/history на кожен регістр
const LIVE_MAX = 1500;          // обмеження довжини рядів у браузері
const MIN_VALID_EPOCH = 1577836800; // 2020-01-01: усе, що раніше, — це час до синхронізації годинника

// --- Оцінка заряду LiFePO4 8S (25,6 В номінал) за напругою у спокої ---------
// BMS немає, тож це лише орієнтир. Крива LiFePO4 дуже пласка (26,0–26,6 В
// охоплюють 30–90 %), тому точність ±10–15 %, а під струмом ще гірше.
// Інша хімія акумулятора (наприклад, свинцевий) — змініть таблицю нижче.
const SOC_CURVE = [
  [20.0, 0], [24.0, 9], [25.0, 14], [25.6, 17], [25.8, 20], [26.0, 30],
  [26.2, 40], [26.4, 70], [26.6, 90], [26.8, 99], [27.2, 100],
];

const LABELS = {
  AbsorbVoltage: "Напруга абсорбції (поточна)", FloatVoltage: "Напруга підтримки (Float)",
  AbsorptionVoltage: "Напруга абсорбції (Bulk)", BatteryLowVoltage: "Нижній поріг напруги АКБ",
  BatteryHighVoltage: "Верхній поріг напруги АКБ", MaxChargerCurrent: "Макс. струм заряду",
  AbsorbChargerCurrent: "Струм фази абсорбції", BatteryAh: "Ємність АКБ",
  BatteryEqualizationVoltage: "Напруга вирівнювання",
  PvVoltage: "Напруга PV", BatteryVoltage: "Напруга АКБ", ChargerCurrent: "Струм заряду від PV",
  ChargerPower: "Потужність PV", RadiatorTemperature: "Температура радіатора (заряд)",
  ExternalTemperature: "Зовнішній датчик температури", RatedCurrent: "Номінальний струм",
  AccumulatedPower: "Всього згенеровано", AccumulatedTime: "Час роботи",
  InverterOutputVoltageSet: "Уставка вихідної напруги", InverterOutputFrequencySet: "Уставка вихідної частоти",
  EnergyUseMode: "Пріоритет джерела", InverterMaxDischargerCurrent: "Макс. струм розряду АКБ",
  BatteryStopDischargingVoltage: "Напруга зупинки розряду", BatteryStopChargingVoltage: "Напруга зупинки заряду",
  GridMaxChargerCurrentSet: "Макс. струм заряду від мережі", InverterBatteryLowVoltage: "Нижній поріг АКБ (інвертор)",
  InverterBatteryHighVoltage: "Верхній поріг АКБ (інвертор)", MaxCombineChargerCurrent: "Макс. сумарний струм заряду",
  AcVoltageGrade: "Номінальна напруга AC", RatedPower: "Номінальна потужність (ВА)",
  RatedPowerW: "Номінальна потужність (Вт)", InverterBatteryVoltage: "Напруга АКБ (інвертор)",
  InverterVoltage: "Вихідна напруга", GridVoltage: "Напруга мережі", BusVoltage: "Напруга шини DC",
  ControlCurrent: "Керуючий струм", InverterCurrent: "Струм інвертора", GridCurrent: "Струм мережі",
  LoadCurrent: "Струм навантаження", PInverter: "Активна потужність інвертора", PGrid: "Активна потужність мережі",
  PLoad: "Активна потужність навантаження", LoadPercent: "Завантаження", SInverter: "Повна потужність інвертора",
  SGrid: "Повна потужність мережі", Sload: "Повна потужність навантаження", Qinverter: "Реактивна, інвертор",
  Qgrid: "Реактивна, мережа", Qload: "Реактивна, навантаження", InverterFrequency: "Частота виходу",
  GridFrequency: "Частота мережі", AcRadiatorTemperature: "Температура радіатора AC",
  TransformerTemperature: "Температура трансформатора", DcRadiatorTemperature: "Температура радіатора DC",
  AccumulatedChargerPower: "Накопичено: заряд АКБ", AccumulatedDischargerPower: "Накопичено: розряд АКБ",
  AccumulatedBuyPower: "Накопичено: куплено з мережі", AccumulatedSellPower: "Накопичено: віддано в мережу",
  AccumulatedLoadPower: "Накопичено: навантаження", AccumulatedSelfUsePower: "Накопичено: власне споживання",
  AccumulatedPvSellPower: "Накопичено: PV в мережу", AccumulatedGridChargerPower: "Накопичено: заряд від мережі",
  BattPower: "Потужність АКБ", BattCurrent: "Струм АКБ",
  AmbientTemperature: "Температура (датчик)", AmbientHumidity: "Вологість (датчик)",
};

const TABLE_GROUPS = {
  battery: [
    { title: "Параметри заряду (з інвертора)", names: [
      "BatteryVoltage", "InverterBatteryVoltage", "BattCurrent", "BattPower", "BatteryAh",
      "AbsorptionVoltage", "FloatVoltage", "BatteryEqualizationVoltage", "AbsorbVoltage",
      "BatteryStopChargingVoltage", "BatteryStopDischargingVoltage", "BatteryLowVoltage",
      "BatteryHighVoltage", "InverterBatteryLowVoltage", "InverterBatteryHighVoltage",
      "MaxChargerCurrent", "MaxCombineChargerCurrent", "GridMaxChargerCurrentSet",
      "InverterMaxDischargerCurrent", "AbsorbChargerCurrent"] },
  ],
  energy: [
    { title: "Лічильники енергії", names: [
      "AccumulatedPower", "AccumulatedChargerPower", "AccumulatedDischargerPower",
      "AccumulatedBuyPower", "AccumulatedSellPower", "AccumulatedLoadPower",
      "AccumulatedSelfUsePower", "AccumulatedPvSellPower", "AccumulatedGridChargerPower",
      "AccumulatedTime"] },
    { title: "PV і заряджання", names: [
      "PvVoltage", "ChargerCurrent", "ChargerPower", "RatedCurrent", "RadiatorTemperature"] },
    { title: "Мережа", names: [
      "GridVoltage", "GridCurrent", "GridFrequency", "PGrid", "SGrid", "Qgrid"] },
    { title: "Вихід інвертора і навантаження", names: [
      "InverterVoltage", "InverterCurrent", "InverterFrequency", "PInverter", "SInverter", "Qinverter",
      "PLoad", "Sload", "Qload", "LoadCurrent", "LoadPercent", "RatedPowerW", "RatedPower", "AcVoltageGrade"] },
    { title: "Температури та шина", names: [
      "TransformerTemperature", "AcRadiatorTemperature", "DcRadiatorTemperature",
      "ExternalTemperature", "BusVoltage", "ControlCurrent"] },
  ],
};

let cfgRegs = [];            // реєстри з /api/config (modbus.registers)
let regByName = {};
let pollIntervalMs = 15000;
let status = null;           // остання відповідь /api/status
let derived = {};
let refreshTimer = null;
let isConnected = false;
let settingsUnlocked = false;
let toastTimer = null;
let socChart = null;
let powerChart = null;
let configLoaded = false;
let historyLoaded = false;

const series = { soc: [], volt: [], pv: [], load: [], grid: [], batt: [] };

// ---------------------------------------------------------------- helpers ---

const $ = (id) => document.getElementById(id);

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function sgn16(v) {
  return v > 32767 ? v - 65536 : v;
}

function num(v, digits = 1) {
  if (v == null || Number.isNaN(v)) return "—";
  return Number(v).toLocaleString("uk-UA", { minimumFractionDigits: 0, maximumFractionDigits: digits });
}

function withUnit(v, unit, digits = 1) {
  if (v == null || Number.isNaN(v)) return "—";
  return `${num(v, digits)}${unit ? " " + unit : ""}`;
}

function labelOf(name) {
  return LABELS[name] || (regByName[name] && regByName[name].name_ru) || name;
}

const UNIT_UA = { V: "В", A: "А", W: "Вт", VA: "ВА", var: "вар", Hz: "Гц", kWh: "кВт·год", Ah: "А·год", s: "с" };

function uaUnit(u) {
  return UNIT_UA[u] || u || "";
}

function unitOf(name) {
  return uaUnit(regByName[name] && regByName[name].unit);
}

function digitsFor(name) {
  const r = regByName[name];
  if (!r) return 1;
  const s = Number(r.scale);
  if (s >= 1) return 0;
  return s >= 0.1 ? 1 : 2;
}

function fmtReg(name) {
  const v = status && status.values ? status.values[name] : undefined;
  return withUnit(v, unitOf(name), digitsFor(name));
}

function val(name) {
  return status && status.values ? status.values[name] : undefined;
}

function estimateSoc(voltage) {
  if (voltage == null) return null;
  if (voltage <= SOC_CURVE[0][0]) return 0;
  for (let i = 1; i < SOC_CURVE.length; i++) {
    const [v1, s1] = SOC_CURVE[i];
    const [v0, s0] = SOC_CURVE[i - 1];
    if (voltage <= v1) return s0 + ((voltage - v0) / (v1 - v0)) * (s1 - s0);
  }
  return 100;
}

// Потік АКБ: + заряд, − розряд. BattPower — потужність без надійного знака,
// напрям беремо зі струму АКБ. Струм у регістрі цілий (0, ±1 А...), тож при
// |I| ≤ 1 А напрям — шум округлення: вважаємо АКБ в очікуванні, якщо PV її не
// заряджає. Без цієї «мертвої зони» індикатор стрибав би між зарядом і розрядом.
function batteryFlowW(power, current, chargerW) {
  const p = Math.abs(power || 0);
  if (Math.abs(current || 0) >= 2) return (current > 0 ? 1 : -1) * p;
  if ((chargerW || 0) > 20) return p;
  return 0;
}

// Потужність мережі PGrid в інверторі — 16-бітне число без знака в конфігурації,
// але насправді знакове: від'ємне значення = споживання з мережі. Повертаємо
// імпорт як додатне число, експорт — як від'ємне.
function gridImportW(pgrid) {
  if (pgrid == null) return null;
  return -sgn16(pgrid);
}

function derive() {
  const d = {};
  d.pv_w = val("ChargerPower");
  d.load_w = val("PLoad");
  d.grid_w = gridImportW(val("PGrid"));
  d.batt_v = val("BatteryVoltage");
  d.batt_i = val("BattCurrent");
  d.batt_w = batteryFlowW(val("BattPower"), val("BattCurrent"), val("ChargerPower"));
  d.soc = estimateSoc(d.batt_v);
  return d;
}

function socColor(v) {
  if (v == null) return "var(--muted)";
  if (v >= 60) return "var(--battery)";
  if (v >= 20) return "var(--warn)";
  return "var(--error)";
}

function setStatus(state, text) {
  const pill = $("status-pill");
  pill.className = "pill";
  if (state) pill.classList.add(state);
  pill.textContent = `● ${text}`;
}

// ------------------------------------------------------------------ cards ---

function metricCard(title, value, color, sub) {
  return `
    <article class="card">
      <div class="card-stripe" style="background:${color}"></div>
      <div class="card-body">
        <div class="metric-title">${esc(title)}</div>
        <div class="metric-value" style="color:${color}">${value}</div>
        ${sub ? `<div class="metric-sub">${sub}</div>` : ""}
      </div>
    </article>`;
}

function enumLabel(name) {
  const r = regByName[name];
  const v = val(name);
  if (v == null) return "—";
  if (r && r.enum_map && r.enum_map[String(Math.round(v))] != null) return r.enum_map[String(Math.round(v))];
  return num(v, 0);
}

function renderOverviewCards() {
  $("info-cards").innerHTML = [
    metricCard("Пріоритет джерела", esc(enumLabel("EnergyUseMode")), "var(--info)", "режим роботи інвертора"),
    metricCard("Номінал", fmtReg("RatedPowerW"), "var(--accent)", `${fmtReg("RatedPower")} повної`),
    metricCard("Завантаження", fmtReg("LoadPercent"), "var(--load)", `${fmtReg("PLoad")} · ${fmtReg("Sload")}`),
    metricCard("Зв'язок", status && status.modbus_ok ? "Modbus OK" : "Modbus ✕",
      status && status.modbus_ok ? "var(--ok)" : "var(--error)",
      `Wi‑Fi ${status && status.wifi_ok ? "OK" : "✕"} · MQTT ${esc(status ? status.mqtt_state : "—")}`),
  ].join("");

  $("metric-cards").innerHTML = [
    metricCard("PV напруга", fmtReg("PvVoltage"), "var(--solar)", `струм ${fmtReg("ChargerCurrent")}`),
    metricCard("Мережа", fmtReg("GridVoltage"), "var(--grid)", `${fmtReg("GridFrequency")} · ${fmtReg("GridCurrent")}`),
    metricCard("Вихід інвертора", fmtReg("InverterVoltage"), "var(--load)", `${fmtReg("InverterFrequency")} · ${fmtReg("LoadCurrent")}`),
    metricCard("Шина DC", fmtReg("BusVoltage"), "var(--info)", "напруга шини"),
    metricCard("Трансформатор", fmtReg("TransformerTemperature"), "var(--warn)", "температура"),
    metricCard("Радіатор AC", fmtReg("AcRadiatorTemperature"), "var(--warn)", "температура"),
    metricCard("Радіатор заряду", fmtReg("RadiatorTemperature"), "var(--warn)", "температура"),
    metricCard("Куплено з мережі", fmtReg("AccumulatedBuyPower"), "var(--grid)", "лічильник"),
  ].join("");
}

function stateText(d) {
  const src = [];
  if (d.pv_w > 20) src.push("Сонце");
  if (d.grid_w > 20) src.push("Мережа");
  if (d.batt_w < -20) src.push("АКБ");
  let text = src.length ? `Живлення: ${src.join(" + ")}` : "Живлення: —";
  if (d.grid_w < -20) text += " · віддача в мережу";
  if (d.batt_w > 20) text += " · АКБ заряджається";
  return text;
}

function updateFlowLine(id, watts, color, reverse = false) {
  const line = $(id);
  if (!line) return;
  const idle = watts == null || Math.abs(watts) < 5;
  line.setAttribute("stroke", idle ? "#334155" : color);
  line.setAttribute("stroke-width", Math.min(6, 2 + Math.abs(watts || 0) / 800));
  if (reverse) {
    line.setAttribute("marker-start", "url(#arrow)");
    line.setAttribute("marker-end", "none");
  } else {
    line.removeAttribute("marker-start");
    line.setAttribute("marker-end", "url(#arrow)");
  }
  line.style.color = idle ? "#334155" : color;
}

function signedW(w) {
  if (w == null) return "—";
  const r = Math.round(w);
  return `${r > 0 ? "+" : r < 0 ? "−" : ""}${num(Math.abs(r), 0)} Вт`;
}

function updateOverview() {
  const d = derived;
  const soc = d.soc;
  const socEl = $("soc-value");
  socEl.textContent = soc == null ? "—" : `≈ ${Math.round(soc)} %`;
  socEl.style.color = socColor(soc);
  $("soc-fill").style.width = soc == null ? "0%" : `${Math.max(0, Math.min(soc, 100))}%`;
  $("soc-fill").style.background = socColor(soc);
  $("batt-v-value").textContent = withUnit(d.batt_v, "В", 1);
  $("hero-meta").textContent =
    `Струм: ${withUnit(d.batt_i, "А", 0)} · потужність: ${signedW(d.batt_w)}\n` +
    `Пороги: стоп-заряд ${fmtReg("BatteryStopChargingVoltage")}, стоп-розряд ${fmtReg("BatteryStopDischargingVoltage")}`;
  $("state-badge").textContent = stateText(d);

  $("flow-pv").textContent = withUnit(d.pv_w, "Вт", 0);
  $("flow-grid").textContent = d.grid_w == null ? "—" : `${d.grid_w < 0 ? "↑ " : ""}${num(Math.abs(d.grid_w), 0)} Вт`;
  $("flow-load").textContent = withUnit(d.load_w, "Вт", 0);
  $("flow-batt").textContent = signedW(d.batt_w);
  $("flow-soc").textContent = soc == null ? "—" : `≈ ${Math.round(soc)} %`;

  updateFlowLine("line-pv", d.pv_w, "#fcd34d");
  updateFlowLine("line-grid", d.grid_w, "#60a5fa", (d.grid_w || 0) < 0);
  updateFlowLine("line-load", d.load_w, "#f472b6");

  renderOverviewCards();
}

function updateBattery() {
  const d = derived;
  const mode = d.batt_w > 20 ? "Заряд" : d.batt_w < -20 ? "Розряд" : "Спокій";
  const cards = [
    ["Напруга", withUnit(d.batt_v, "В", 1), "var(--battery)", "за даними інвертора"],
    ["Струм", withUnit(d.batt_i, "А", 0), "var(--battery)", "ціле значення з регістра"],
    ["Потужність", signedW(d.batt_w), "var(--battery)", "+ заряд · − розряд"],
    ["Заряд ≈", d.soc == null ? "—" : `${Math.round(d.soc)} %`, socColor(d.soc), "оцінка за напругою"],
    ["Ємність", fmtReg("BatteryAh"), "var(--info)", "з налаштувань інвертора"],
    ["Стан", mode, "var(--accent)", "визначено за потоком"],
  ];
  $("bms-cards").innerHTML = cards.map(([t, v, c, s]) => metricCard(t, v, c, s)).join("");
  renderTable("table-battery", TABLE_GROUPS.battery);
}

function renderTable(containerId, groups) {
  const rows = [];
  for (const g of groups) {
    rows.push(`<tr class="section-row"><td colspan="4">▸ ${esc(g.title)}</td></tr>`);
    for (const name of g.names) {
      if (!regByName[name]) continue;
      const v = val(name);
      rows.push(`
        <tr>
          <td>${esc(labelOf(name))}</td>
          <td>${v == null ? "—" : esc(num(v, digitsFor(name)))}</td>
          <td>${esc(unitOf(name))}</td>
          <td>${esc(regByName[name].address)}</td>
        </tr>`);
    }
  }
  $(containerId).innerHTML = `
    <table>
      <thead><tr><th>Параметр</th><th>Значення</th><th>Од.</th><th>Reg</th></tr></thead>
      <tbody>${rows.join("")}</tbody>
    </table>`;
}

// ----------------------------------------------------------------- charts ---

function clock(ms) {
  return new Date(ms).toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit" });
}

function chartOptions(unit, extraScales) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    parsing: false,
    interaction: { mode: "nearest", axis: "x", intersect: false },
    scales: {
      x: {
        type: "linear",
        ticks: { color: "#7d92ad", maxTicksLimit: 8, callback: (v) => clock(v) },
        grid: { color: "#243044" },
      },
      y: {
        position: "left",
        ticks: { color: "#7d92ad" },
        grid: { color: "#243044" },
        title: { display: Boolean(unit), text: unit, color: "#7d92ad" },
      },
      ...extraScales,
    },
    plugins: {
      legend: { labels: { color: "#eef2f7" } },
      tooltip: {
        callbacks: { title: (items) => new Date(items[0].parsed.x).toLocaleString("uk-UA") },
      },
    },
  };
}

function initCharts() {
  socChart = new Chart($("soc-chart"), {
    type: "line",
    data: {
      datasets: [
        { label: "Заряд ≈, %", data: series.soc, borderColor: "#34d399", backgroundColor: "rgba(52,211,153,0.15)",
          fill: true, tension: 0.25, pointRadius: 0, yAxisID: "y" },
        { label: "Напруга, В", data: series.volt, borderColor: "#38bdf8", tension: 0.25, pointRadius: 0, yAxisID: "y2" },
      ],
    },
    options: (() => {
      const o = chartOptions("%", {
        // suggestedMin/Max: вісь не стискається до соток вольта, що виглядало б як обвал
        y2: { position: "right", suggestedMin: 24, suggestedMax: 29.5, ticks: { color: "#38bdf8" }, grid: { drawOnChartArea: false },
              title: { display: true, text: "В", color: "#38bdf8" } },
      });
      o.scales.y.min = 0;
      o.scales.y.max = 100;
      return o;
    })(),
  });

  powerChart = new Chart($("power-chart"), {
    type: "line",
    data: {
      datasets: [
        { label: "PV", key: "pv", data: series.pv, borderColor: "#fcd34d", tension: 0.25, pointRadius: 0 },
        { label: "Навантаження", key: "load", data: series.load, borderColor: "#f472b6", tension: 0.25, pointRadius: 0 },
        { label: "Мережа (імпорт +)", key: "grid", data: series.grid, borderColor: "#60a5fa", tension: 0.25, pointRadius: 0 },
        { label: "АКБ (заряд +)", key: "batt", data: series.batt, borderColor: "#34d399", tension: 0.25, pointRadius: 0 },
      ],
    },
    options: chartOptions("Вт"),
  });
}

function trim(arr) {
  while (arr.length > LIVE_MAX) arr.shift();
}

function pushLive() {
  const x = Date.now();
  const d = derived;
  const add = (key, y) => { if (y != null && !Number.isNaN(y)) series[key].push({ x, y }); };
  add("soc", d.soc);
  add("volt", d.batt_v);
  add("pv", d.pv_w);
  add("load", d.load_w);
  add("grid", d.grid_w);
  add("batt", d.batt_w);
  Object.values(series).forEach(trim);
}

function updateCharts() {
  if (!socChart) return;
  socChart.update();
  for (const ds of powerChart.data.datasets) {
    ds.hidden = !document.querySelector(`input[data-series="${ds.key}"]`)?.checked;
  }
  powerChart.update();
  const n = series.load.length;
  const span = n > 1 ? Math.round((series.load[n - 1].x - series.load[0].x) / 60000) : 0;
  $("chart-info").textContent = `Точок: ${n} · ~${span} хв історії`;
}

async function fetchHistory(name) {
  const res = await fetch(`/api/history?register=${encodeURIComponent(name)}&points=${HISTORY_POINTS}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`history ${name}: ${res.status}`);
  const j = await res.json();
  // Точки, записані на старті до синхронізації годинника (NTP), мають мітку ~1970 р.
  // і розтягнули б вісь часу на десятиліття — відкидаємо все, що раніше 2020 року.
  return (j.points || []).filter((p) => p.t > MIN_VALID_EPOCH).map((p) => ({ x: p.t * 1000, y: p.v }));
}

function nearest(points, x) {
  if (!points.length) return null;
  let best = points[0];
  for (const p of points) {
    if (Math.abs(p.x - x) < Math.abs(best.x - x)) best = p;
    if (p.x > x && Math.abs(p.x - x) > Math.abs(best.x - x)) break;
  }
  return best.y;
}

// Підтягуємо накопичену в PSRAM історію плати, щоб графіки не починалися з нуля
// після перезавантаження сторінки.
async function loadHistory() {
  const names = ["BatteryVoltage", "ChargerPower", "PLoad", "PGrid", "BattPower", "BattCurrent"];
  const h = {};
  for (const n of names) h[n] = await fetchHistory(n);   // по черзі — не навантажуємо плату

  for (const p of h.BatteryVoltage) {
    series.volt.push(p);
    series.soc.push({ x: p.x, y: estimateSoc(p.y) });
  }
  for (const p of h.ChargerPower) series.pv.push(p);
  for (const p of h.PLoad) series.load.push(p);
  for (const p of h.PGrid) series.grid.push({ x: p.x, y: gridImportW(p.y) });
  for (const p of h.BattPower) {
    const cur = nearest(h.BattCurrent, p.x);
    const pv = nearest(h.ChargerPower, p.x);
    series.batt.push({ x: p.x, y: batteryFlowW(p.y, cur, pv) });
  }
  Object.values(series).forEach(trim);
  historyLoaded = true;
}

// --------------------------------------------------------------- settings ---

function showToast(text, ok = true) {
  const toast = $("settings-toast");
  toast.textContent = text;
  toast.className = ok ? "toast ok" : "toast error";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add("hidden"), 5000);
}

function settingInput(reg) {
  if (reg.enum_map && Object.keys(reg.enum_map).length) {
    const select = document.createElement("select");
    const cur = val(reg.name);
    for (const [code, text] of Object.entries(reg.enum_map)) {
      const opt = document.createElement("option");
      opt.value = code;
      opt.textContent = text;
      if (cur != null && String(Math.round(cur)) === code) opt.selected = true;
      select.appendChild(opt);
    }
    return select;
  }
  const input = document.createElement("input");
  input.type = "number";
  input.step = reg.step > 0 ? String(reg.step) : "any";
  if (reg.max > reg.min) {
    input.min = String(reg.min);
    input.max = String(reg.max);
  }
  const cur = val(reg.name);
  input.value = cur == null ? "" : String(Number(cur.toFixed(digitsFor(reg.name))));
  return input;
}

function rangeText(reg) {
  if (reg.enum_map || !(reg.max > reg.min)) return "";
  return `${reg.min}…${reg.max}${reg.unit ? " " + uaUnit(reg.unit) : ""}`;
}

function renderSettingsEditor() {
  const root = $("settings-editor");
  const writable = cfgRegs.filter((r) => r.writable && r.count === 1);
  if (!writable.length) {
    root.innerHTML = `<div class="card banner">Немає регістрів, дозволених для запису</div>`;
    return;
  }
  const groups = [
    ["Заряджання та акумулятор", writable.filter((r) => r.address < 20000)],
    ["Інвертор і джерела живлення", writable.filter((r) => r.address >= 20000)],
  ];

  root.innerHTML = "";
  for (const [title, rows] of groups) {
    if (!rows.length) continue;
    const block = document.createElement("section");
    block.className = "settings-section";
    block.innerHTML = `<h3>${esc(title)}</h3>`;
    const wrap = document.createElement("div");
    wrap.className = "settings-wrap";
    const head = document.createElement("div");
    head.className = "setting-row head";
    head.innerHTML = "<div>Параметр</div><div>Зараз</div><div>Нове значення</div><div></div>";
    wrap.appendChild(head);

    for (const reg of rows) {
      const row = document.createElement("div");
      row.className = "setting-row";
      const range = rangeText(reg);
      row.innerHTML = `
        <div>${esc(labelOf(reg.name))}<div class="range">${esc(reg.name)}${range ? " · " + esc(range) : ""}</div></div>
        <div class="current" data-current="${esc(reg.name)}">${reg.enum_map ? esc(enumLabel(reg.name)) : fmtReg(reg.name)}</div>`;
      const inputWrap = document.createElement("div");
      const input = settingInput(reg);
      input.addEventListener("input", () => row.classList.add("dirty"));
      inputWrap.appendChild(input);
      const btnWrap = document.createElement("div");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = "Зберегти";
      btn.addEventListener("click", () => saveSetting(reg, input, btn, row));
      btnWrap.appendChild(btn);
      row.appendChild(inputWrap);
      row.appendChild(btnWrap);
      wrap.appendChild(row);
    }
    block.appendChild(wrap);
    root.appendChild(block);
  }
}

function refreshCurrentValues() {
  document.querySelectorAll("[data-current]").forEach((el) => {
    const name = el.getAttribute("data-current");
    const reg = regByName[name];
    el.textContent = reg && reg.enum_map ? enumLabel(name) : fmtReg(name);
  });
}

async function saveSetting(reg, input, button, row) {
  const raw = input.value;
  if (raw === "" || Number.isNaN(Number(raw))) {
    showToast("Введіть значення", false);
    return;
  }
  const value = Number(raw);
  if (!reg.enum_map && reg.max > reg.min && (value < reg.min || value > reg.max)) {
    showToast(`Поза діапазоном ${reg.min}…${reg.max}`, false);
    return;
  }
  const shown = reg.enum_map ? (reg.enum_map[String(value)] || value) : `${value}${reg.unit ? " " + uaUnit(reg.unit) : ""}`;
  const now = reg.enum_map ? enumLabel(reg.name) : fmtReg(reg.name);
  if (!confirm(`Записати в інвертор?\n\n${labelOf(reg.name)}\nЗараз: ${now}\nНове: ${shown}`)) return;

  button.disabled = true;
  try {
    const res = await fetch("/api/modbus/write", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: reg.name, value }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(text || `HTTP ${res.status}`);
    row.classList.remove("dirty");
    showToast(`Записано: ${labelOf(reg.name)} = ${shown}`);
    await refresh(true);
  } catch (err) {
    showToast(err.message || "Помилка запису", false);
  } finally {
    button.disabled = false;
  }
}

function setSettingsUnlocked(unlocked) {
  settingsUnlocked = unlocked;
  $("settings-gate").classList.toggle("hidden", unlocked);
  $("settings-unlocked").classList.toggle("hidden", !unlocked);
  if (unlocked) renderSettingsEditor();
}

// ----------------------------------------------------------------- driver ---

async function loadConfig() {
  const res = await fetch("/api/config", { cache: "no-store" });
  if (!res.ok) throw new Error(`config: ${res.status}`);
  const cfg = await res.json();
  cfgRegs = (cfg.modbus && cfg.modbus.registers) || [];
  regByName = Object.fromEntries(cfgRegs.map((r) => [r.name, r]));
  pollIntervalMs = Math.max(MIN_REFRESH_MS, (cfg.modbus && cfg.modbus.poll_interval_ms) || 15000);
  const m = cfg.modbus || {};
  $("conn-line").textContent =
    `RS485 · slave ${m.slave_id} · ${m.uart_baud} 8N1 · RX GPIO${m.uart_rx_pin} / TX GPIO${m.uart_tx_pin}`;
  configLoaded = true;
}

async function refresh(manual = false) {
  clearTimeout(refreshTimer);
  if (manual) setStatus("loading", "Читання…");
  try {
    if (!configLoaded) await loadConfig();
    const res = await fetch("/api/status", { cache: "no-store" });
    if (!res.ok) throw new Error(`status: ${res.status}`);
    status = await res.json();
    derived = derive();

    if (!historyLoaded) {
      try { await loadHistory(); } catch (e) { console.warn("history:", e); historyLoaded = true; }
    }
    pushLive();

    updateOverview();
    updateBattery();
    renderTable("table-energy", TABLE_GROUPS.energy);
    updateCharts();
    if (settingsUnlocked) refreshCurrentValues();

    $("updated-at").textContent = `Оновлено: ${new Date().toLocaleString("uk-UA")}`;
    isConnected = true;
    if (status.modbus_ok) setStatus("ok", "Підключено");
    else setStatus("error", "Інвертор не відповідає");
  } catch (err) {
    console.error(err);
    isConnected = false;
    setStatus("error", "Немає з'єднання з платою");
  } finally {
    $("refresh-hint").textContent = isConnected
      ? `Автооновлення кожні ${Math.round(pollIntervalMs / 1000)} с`
      : "Повтор підключення кожні 5 с";
    refreshTimer = setTimeout(refresh, isConnected ? pollIntervalMs : RETRY_MS);
  }
}

function setupTabs() {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
      document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
      tab.classList.add("active");
      $(`panel-${tab.dataset.tab}`).classList.add("active");
      if (tab.dataset.tab === "chart") updateCharts();
      try { history.replaceState(null, "", `#${tab.dataset.tab}`); } catch (e) { /* не критично */ }
    });
  });
  // Відкрити вкладку за адресою, напр. /dash#chart
  const wanted = location.hash.replace("#", "");
  const target = document.querySelector(`.tab[data-tab="${wanted}"]`);
  if (target) target.click();
}

document.addEventListener("DOMContentLoaded", () => {
  setupTabs();
  initCharts();
  $("refresh-btn").addEventListener("click", () => refresh(true));
  document.querySelectorAll("input[data-series]").forEach((cb) => cb.addEventListener("change", updateCharts));
  $("settings-unlock").addEventListener("click", () => setSettingsUnlocked(true));
  $("settings-lock").addEventListener("click", () => setSettingsUnlocked(false));
  refresh(true);
});
