// ==UserScript==
// @name         CHD Course Helper Prototype
// @namespace    local.classhelper.chd
// @version      0.1.19
// @description  Add local course filters and timetable preview highlights to CHD EAMS pages.
// @match        http://bkjw.chd.edu.cn/eams/*
// @match        https://bkjw.chd.edu.cn/eams/*
// @match        https://ids.chd.edu.cn/authserver/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
  "use strict";

  const STORAGE_KEY = "chdCourseHelper.v1";
  const DAYS = ["星期一", "星期二", "星期三", "星期四", "星期五", "星期六", "星期日"];
  const DAY_ALIAS = new Map([
    ["星期一", 1],
    ["星期二", 2],
    ["星期三", 3],
    ["星期四", 4],
    ["星期五", 5],
    ["星期六", 6],
    ["星期日", 7],
    ["星期天", 7],
  ]);

  const DEFAULT_FILTERS = {
    noConflict: true,
    morningFriendly: false,
    hasSeat: false,
    noPrerequisite: false,
    examKaocha: false,
    examKaoshi: false,
    langChinese: false,
    langBilingual: false,
    buildingWX: false,
    buildingWM: false,
    buildingWH: false,
    buildingWT: false,
    buildingOther: false,
    hideUnmatched: false,
  };
  const DETAIL_FILTER_KEYS = ["noPrerequisite", "examKaocha", "examKaoshi", "langChinese", "langBilingual"];
  const BUILDING_FILTER_ITEMS = [
    { key: "buildingWX", label: "WX", value: "WX" },
    { key: "buildingWM", label: "WM", value: "WM" },
    { key: "buildingWH", label: "WH", value: "WH" },
    { key: "buildingWT", label: "WT", value: "WT" },
    { key: "buildingOther", label: "其他", value: "其他" },
  ];
  const DETAIL_FETCH_DELAY_MS = 5000;
  const DETAIL_FETCH_LIMIT = 20;
  const SCRIPT_VERSION = "0.1.19";
  const BACKGROUND_READ_PARAM = "chdCourseHelperBgRead";

  let state = {
    timetable: null,
    courses: [],
    selectedCourseId: null,
    observer: null,
    autoScanTimer: null,
    lastElectionSignature: "",
    detailFetch: {
      running: false,
      stopRequested: false,
    },
    timetableFetch: {
      running: false,
      attempted: false,
    },
    backgroundRead: {
      requestId: "",
      timer: null,
      openedWindow: null,
    },
    filters: {
      ...DEFAULT_FILTERS,
      ...(loadStore().filters || {}),
    },
  };

  function loadStore() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    } catch (error) {
      return {};
    }
  }

  function saveStore(store) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  }

  function saveFilters() {
    const store = loadStore();
    store.filters = { ...state.filters };
    saveStore(store);
  }

  function hasActiveDetailFilters() {
    return DETAIL_FILTER_KEYS.some((key) => state.filters[key]);
  }

  function isDetailFilter(key) {
    return DETAIL_FILTER_KEYS.includes(key);
  }

  function sleep(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function normalizeText(value) {
    return (value || "")
      .replace(/\u00a0/g, " ")
      .replace(/\r/g, "\n")
      .replace(/[ \t]+/g, " ")
      .replace(/\n[ \t]+/g, "\n")
      .replace(/[ \t]+\n/g, "\n")
      .trim();
  }

  function textOf(node) {
    return normalizeText(node ? node.innerText || node.textContent || "" : "");
  }

  function range(start, end) {
    const a = Number(start);
    const b = Number(end || start);
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const result = [];
    for (let n = lo; n <= hi; n += 1) result.push(n);
    return result;
  }

  function parseWeeks(text) {
    const weeks = new Set();
    const source = normalizeText(text);
    let match;

    const weekRangePattern = /(\d{1,2})\s*-\s*(\d{1,2})\s*周/g;
    while ((match = weekRangePattern.exec(source))) {
      range(match[1], match[2]).forEach((week) => weeks.add(week));
    }

    const parenRangePattern = /[（(]\s*(\d{1,2})\s*-\s*(\d{1,2})\s*[,，]/g;
    while ((match = parenRangePattern.exec(source))) {
      range(match[1], match[2]).forEach((week) => weeks.add(week));
    }

    const practicePattern = /实践周\s*[:：]\s*[［\[]([^\]］]+)[\]］]/g;
    while ((match = practicePattern.exec(source))) {
      const nums = match[1].match(/\d{1,2}/g) || [];
      nums.forEach((num) => weeks.add(Number(num)));
    }

    return Array.from(weeks).sort((a, b) => a - b);
  }

  function allWeeks() {
    return range(1, 20);
  }

  function parsePeriods(text) {
    const source = normalizeText(text);
    const match = source.match(/(\d{1,2})\s*(?:-\s*(\d{1,2}))?\s*节/);
    if (!match) return [];
    return range(match[1], match[2] || match[1]);
  }

  function weeksOverlap(a, b) {
    const left = a && a.length ? a : allWeeks();
    const right = b && b.length ? b : allWeeks();
    const rightSet = new Set(right);
    return left.some((week) => rightSet.has(week));
  }

  function periodsOverlap(a, b) {
    const rightSet = new Set(b || []);
    return (a || []).some((period) => rightSet.has(period));
  }

  function parseCandidateSchedule(text) {
    const source = normalizeText(text);
    const slots = [];
    const blockPattern = /(\d{1,2})\s*-\s*(\d{1,2})\s*周[\s\S]{0,80}?(星期[一二三四五六日天])\s*(\d{1,2})\s*(?:-\s*(\d{1,2}))?\s*节/g;
    let match;

    while ((match = blockPattern.exec(source))) {
      const day = DAY_ALIAS.get(match[3]);
      if (!day) continue;
      slots.push({
        weeks: range(match[1], match[2]),
        day,
        periods: range(match[4], match[5] || match[4]),
        raw: normalizeText(match[0]),
      });
    }

    return slots;
  }

  function parseScheduleBuildings(text) {
    const source = normalizeText(text).toUpperCase();
    const buildings = new Set();
    let match;

    const knownPattern = /(WX|WM|WH|WT)\s*\d*/g;
    while ((match = knownPattern.exec(source))) {
      buildings.add(match[1]);
    }

    const starredLocations = source.match(/\*[^\s,，;；]+/g) || [];
    starredLocations.forEach((locationText) => {
      const location = locationText.replace(/^\*/, "");
      if (!/^(WX|WM|WH|WT)\d*/.test(location)) buildings.add("其他");
    });

    if (/实验|机房|中心|基地|体育|图书馆|馆|场|室/.test(source)) {
      buildings.add("其他");
    }

    return buildings.size ? Array.from(buildings) : ["其他"];
  }

  function buildTableGrid(table) {
    const rows = Array.from(table.rows || []);
    const grid = [];

    rows.forEach((row, rowIndex) => {
      grid[rowIndex] = grid[rowIndex] || [];
      let colIndex = 0;

      Array.from(row.cells || []).forEach((cell) => {
        while (grid[rowIndex][colIndex]) colIndex += 1;

        const rowspan = Math.max(1, Number(cell.getAttribute("rowspan") || 1));
        const colspan = Math.max(1, Number(cell.getAttribute("colspan") || 1));

        for (let r = 0; r < rowspan; r += 1) {
          grid[rowIndex + r] = grid[rowIndex + r] || [];
          for (let c = 0; c < colspan; c += 1) {
            grid[rowIndex + r][colIndex + c] = {
              cell,
              originRow: rowIndex,
              originCol: colIndex,
              isOrigin: r === 0 && c === 0,
            };
          }
        }

        colIndex += colspan;
      });
    });

    return grid;
  }

  function findTimetableTable(doc = document) {
    return Array.from(doc.querySelectorAll("table")).find((table) => {
      const content = textOf(table);
      return DAYS.slice(0, 5).every((day) => content.includes(day)) && /节次|小节/.test(content);
    });
  }

  function parseTimetable(doc = document) {
    const table = findTimetableTable(doc);
    if (!table) return null;

    const grid = buildTableGrid(table);
    const headerRowIndex = grid.findIndex((row) => row.some((item) => item && DAYS.includes(textOf(item.cell))));
    if (headerRowIndex < 0) return null;

    const dayColumns = new Map();
    grid[headerRowIndex].forEach((item, colIndex) => {
      if (!item) return;
      const dayIndex = DAYS.indexOf(textOf(item.cell)) + 1;
      if (dayIndex > 0) dayColumns.set(colIndex, dayIndex);
    });

    const slots = [];
    const cellsBySlot = new Map();

    for (let rowIndex = headerRowIndex + 1; rowIndex < grid.length; rowIndex += 1) {
      const row = grid[rowIndex] || [];
      const periodText = textOf(row[0] && row[0].cell);
      const period = Number((periodText.match(/\d{1,2}/) || [])[0]);
      if (!period) continue;

      dayColumns.forEach((day, colIndex) => {
        const item = row[colIndex];
        if (!item || !item.cell) return;

        const key = slotKey(day, period);
        if (!cellsBySlot.has(key)) cellsBySlot.set(key, item.cell);

        const content = textOf(item.cell);
        if (!content || /^\d+$/.test(content)) return;

        const weeks = parseWeeks(content);
        slots.push({
          day,
          periods: [period],
          weeks: weeks.length ? weeks : allWeeks(),
          title: firstUsefulLine(content),
          raw: content,
          cell: item.cell,
        });
      });
    }

    return { table, grid, slots, cellsBySlot, source: "页面课表" };
  }

  function attachVisibleCells(timetable, visibleTimetable) {
    if (!timetable) return null;
    return {
      ...timetable,
      cellsBySlot: visibleTimetable && visibleTimetable.cellsBySlot ? visibleTimetable.cellsBySlot : new Map(),
    };
  }

  function normalizeStoredTimetable(stored, visibleTimetable) {
    if (!stored || !Array.isArray(stored.slots)) return null;
    return attachVisibleCells({
      capturedAt: stored.capturedAt,
      source: stored.source || "缓存课表",
      params: stored.params || null,
      slots: stored.slots,
    }, visibleTimetable);
  }

  function serializeTimetable(timetable, source, params) {
    return {
      capturedAt: new Date().toISOString(),
      source: source || timetable.source || "课表缓存",
      params: params || timetable.params || null,
      slots: timetable.slots.map(({ day, periods, weeks, title, raw, room }) => ({ day, periods, weeks, title, raw, room })),
    };
  }

  function getCookieValue(name) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = document.cookie.match(new RegExp(`(?:^|; )${escaped}=([^;]*)`));
    return match ? decodeURIComponent(match[1]) : "";
  }

  function getControlValues(doc = document) {
    const values = {};
    Array.from(doc.querySelectorAll("input,select,textarea")).forEach((control) => {
      const name = control.getAttribute("name");
      if (!name) return;
      values[name] = control.value || "";
    });
    return values;
  }

  function extractValueFromHtml(html, name) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const patterns = [
      new RegExp(`name=["']${escaped}["'][^>]*value=["']([^"']*)["']`, "i"),
      new RegExp(`value=["']([^"']*)["'][^>]*name=["']${escaped}["']`, "i"),
      new RegExp(`${escaped}\\s*[:=]\\s*["']?([\\w.-]+)`, "i"),
    ];
    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match) return match[1];
    }
    return "";
  }

  function collectTimetableParams(doc = document, html = "") {
    const values = doc ? getControlValues(doc) : {};
    const source = html || (doc && doc.documentElement ? doc.documentElement.innerHTML : "");
    return {
      ignoreHead: values.ignoreHead || extractValueFromHtml(source, "ignoreHead") || "1",
      "setting.kind": values["setting.kind"] || extractValueFromHtml(source, "setting.kind") || "std",
      startWeek: values.startWeek || extractValueFromHtml(source, "startWeek") || "",
      "project.id": values["project.id"] || extractValueFromHtml(source, "project.id") || "1",
      "semester.id": values["semester.id"] || extractValueFromHtml(source, "semester.id") || getCookieValue("semester.id") || "",
      ids: values.ids || extractValueFromHtml(source, "ids") || "",
    };
  }

  function validTimetableParams(params) {
    return Boolean(params && params.ids && params["semester.id"]);
  }

  function normalizeTimetableParams(params) {
    return {
      ignoreHead: params.ignoreHead || "1",
      "setting.kind": params["setting.kind"] || "std",
      startWeek: params.startWeek || "",
      "project.id": params["project.id"] || "1",
      "semester.id": params["semester.id"] || getCookieValue("semester.id") || "",
      ids: params.ids || "",
    };
  }

  function parseTimetableRequestBody(body) {
    if (!body) return null;

    let params = null;
    if (typeof body === "string") {
      params = new URLSearchParams(body);
    } else if (body instanceof URLSearchParams) {
      params = body;
    } else if (typeof FormData !== "undefined" && body instanceof FormData) {
      params = new URLSearchParams(body);
    }

    if (!params) return null;
    return normalizeTimetableParams({
      ignoreHead: params.get("ignoreHead") || "",
      "setting.kind": params.get("setting.kind") || "",
      startWeek: params.get("startWeek") || "",
      "project.id": params.get("project.id") || "",
      "semester.id": params.get("semester.id") || "",
      ids: params.get("ids") || "",
    });
  }

  function saveTimetableParams(params) {
    const normalized = normalizeTimetableParams(params || {});
    if (!validTimetableParams(normalized)) return false;
    const store = loadStore();
    store.timetableParams = normalized;
    saveStore(store);
    return true;
  }

  function configureTimetableParams() {
    const store = loadStore();
    const current = normalizeTimetableParams(store.timetableParams || collectTimetableParams(document));
    const ids = window.prompt("请输入课表参数 ids（网络负载里的 ids）", current.ids || "");
    if (ids === null) return;

    const semesterId = window.prompt("请输入 semester.id", current["semester.id"] || getCookieValue("semester.id") || "");
    if (semesterId === null) return;

    const params = normalizeTimetableParams({
      ...current,
      ids: normalizeText(ids),
      "semester.id": normalizeText(semesterId),
    });

    if (!saveTimetableParams(params)) {
      setStatus("课表参数未保存：ids 或 semester.id 为空");
      return;
    }

    setStatus(`已保存课表参数 ids=${params.ids}, semester.id=${params["semester.id"]}`);
    fetchFullTimetable(true);
  }

  function getBackgroundReadId() {
    return new URLSearchParams(location.search).get(BACKGROUND_READ_PARAM) || "";
  }

  function isBackgroundReadPage() {
    return Boolean(getBackgroundReadId());
  }

  function updateBackgroundReadStore(update) {
    const store = loadStore();
    store.backgroundRead = {
      ...(store.backgroundRead || {}),
      ...update,
      updatedAt: new Date().toISOString(),
    };
    saveStore(store);
  }

  function startBackgroundTimetableRead() {
    const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const url = new URL("/eams/courseTableForStd.action", location.href);
    url.searchParams.set(BACKGROUND_READ_PARAM, requestId);

    updateBackgroundReadStore({
      id: requestId,
      status: "opening",
      message: "正在打开课表页",
    });

    const opened = window.open(url.href, "_blank");
    if (!opened) {
      setStatus("后台读取被浏览器拦截，请允许弹出窗口后重试");
      updateBackgroundReadStore({
        id: requestId,
        status: "blocked",
        message: "浏览器拦截了课表页",
      });
      return;
    }

    state.backgroundRead.requestId = requestId;
    state.backgroundRead.openedWindow = opened;
    setStatus("已打开后台课表页，正在等待完整课表数据");

    if (state.backgroundRead.timer) window.clearInterval(state.backgroundRead.timer);
    state.backgroundRead.timer = window.setInterval(() => {
      const result = (loadStore().backgroundRead || {});
      if (result.id !== requestId) return;

      if (result.status === "success") {
        window.clearInterval(state.backgroundRead.timer);
        state.backgroundRead.timer = null;
        scanPage();
        setStatus("后台读取完成，已刷新筛选");
      } else if (result.status === "failed") {
        window.clearInterval(state.backgroundRead.timer);
        state.backgroundRead.timer = null;
        setStatus(`后台读取失败：${result.message || "未读取到完整课表"}`);
      } else if (result.message) {
        setStatus(result.message);
      }
    }, 700);

    window.setTimeout(() => {
      if (state.backgroundRead.timer) {
        window.clearInterval(state.backgroundRead.timer);
        state.backgroundRead.timer = null;
        setStatus("后台读取超时，可再点一次后台读取或手动设置参数");
      }
    }, 20000);
  }

  function finishBackgroundTimetableRead(timetable) {
    if (!isBackgroundReadPage() || !timetable || !timetable.slots.length) return;
    const requestId = getBackgroundReadId();
    updateBackgroundReadStore({
      id: requestId,
      status: "success",
      message: "完整课表已读取，正在关闭后台页",
      count: timetable.slots.length,
      source: timetable.source,
    });
    setStatus("后台读取完成，页面即将关闭");
    window.setTimeout(() => window.close(), 800);
  }

  function isTimetableRequestUrl(url) {
    return /(?:^|\/)courseTableForStd!courseTable\.action(?:[?#]|$)/.test(String(url || ""));
  }

  function setupTimetableRequestCapture() {
    if (window.__chdCourseHelperCaptureInstalled) return;
    window.__chdCourseHelperCaptureInstalled = true;

    if (window.fetch) {
      const nativeFetch = window.fetch;
      window.fetch = function patchedFetch(input, init) {
        const url = typeof input === "string" ? input : input && input.url;
        if (isTimetableRequestUrl(url) && init && init.body) {
          saveTimetableParams(parseTimetableRequestBody(init.body));
        }
        return nativeFetch.apply(this, arguments).then((response) => {
          if (isTimetableRequestUrl(url)) {
            response.clone().text().then((html) => {
              saveFullTimetableFromHtml(html, parseTimetableRequestBody(init && init.body), "完整课表请求响应");
            }).catch(() => {});
          }
          return response;
        });
      };
    }

    const nativeOpen = XMLHttpRequest.prototype.open;
    const nativeSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function patchedOpen(method, url) {
      this.__chdCourseHelperUrl = url;
      return nativeOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function patchedSend(body) {
      if (isTimetableRequestUrl(this.__chdCourseHelperUrl)) {
        const params = parseTimetableRequestBody(body);
        saveTimetableParams(params);
        this.addEventListener("load", () => {
          if (typeof this.responseText !== "string") return;
          saveFullTimetableFromHtml(this.responseText, params, "完整课表请求响应");
        }, { once: true });
      }
      return nativeSend.apply(this, arguments);
    };
  }

  async function fetchTimetableParams() {
    const current = collectTimetableParams(document);
    if (validTimetableParams(current)) return current;

    const store = loadStore();
    if (validTimetableParams(store.timetableParams)) return store.timetableParams;

    const response = await fetch(new URL("/eams/courseTableForStd.action", location.href).href, {
      credentials: "include",
    });
    if (!response.ok) throw new Error(`课表入口 HTTP ${response.status}`);

    const html = await response.text();
    const doc = new DOMParser().parseFromString(html, "text/html");
    const params = collectTimetableParams(doc, html);
    if (!validTimetableParams(params)) throw new Error("未找到课表参数 ids/semester.id");

    saveTimetableParams(params);
    return params;
  }

  function splitJsArgs(text) {
    const args = [];
    let current = "";
    let quote = "";
    let escaped = false;
    let depth = 0;

    for (const char of text) {
      if (quote) {
        current += char;
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === quote) {
          quote = "";
        }
        continue;
      }

      if (char === "\"" || char === "'") {
        quote = char;
        current += char;
        continue;
      }
      if (char === "(" || char === "[" || char === "{") depth += 1;
      if (char === ")" || char === "]" || char === "}") depth -= 1;
      if (char === "," && depth === 0) {
        args.push(current.trim());
        current = "";
      } else {
        current += char;
      }
    }

    if (current.trim()) args.push(current.trim());
    return args;
  }

  function readJsString(arg) {
    const source = (arg || "").trim();
    if (!/^["']/.test(source)) return "";
    const quote = source[0];
    let result = "";
    for (let i = 1; i < source.length; i += 1) {
      const char = source[i];
      if (char === quote) break;
      if (char === "\\" && i + 1 < source.length) {
        const next = source[i + 1];
        if (next === "n") result += "\n";
        else if (next === "t") result += "\t";
        else result += next;
        i += 1;
      } else {
        result += char;
      }
    }
    return result;
  }

  function extractLastCourseName(prefix) {
    const matches = Array.from(prefix.matchAll(/var\s+courseName\s*=\s*(["'][\s\S]*?["'])\s*;/g));
    const last = matches[matches.length - 1];
    return last ? readJsString(last[1]) : "";
  }

  function extractWeekFrom(html) {
    const patterns = [
      /marshalValidWeeks\s*\([^,]+,\s*(\d{1,2})\s*,/i,
      /\.marshal\s*\([^,]+,\s*(\d{1,2})\s*,/i,
      /var\s+from\s*=\s*(\d{1,2})\s*;/i,
    ];
    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match) return Number(match[1]);
    }
    return 1;
  }

  function parseValidWeeksBits(bits, from) {
    const weeks = [];
    if (!/^[01]{8,}$/.test(bits || "")) return weeks;
    for (let index = 0; index < bits.length; index += 1) {
      if (bits.charAt(index) !== "1") continue;
      const week = index - from + 2;
      if (week >= 1 && week <= 30) weeks.push(week);
    }
    return weeks;
  }

  function buildIndexSlotMap(doc) {
    const table = findTimetableTable(doc);
    if (!table) return new Map();

    const grid = buildTableGrid(table);
    const headerRowIndex = grid.findIndex((row) => row.some((item) => item && DAYS.includes(textOf(item.cell))));
    if (headerRowIndex < 0) return new Map();

    const dayColumns = new Map();
    grid[headerRowIndex].forEach((item, colIndex) => {
      if (!item) return;
      const dayIndex = DAYS.indexOf(textOf(item.cell)) + 1;
      if (dayIndex > 0) dayColumns.set(colIndex, dayIndex);
    });

    const indexMap = new Map();
    for (let rowIndex = headerRowIndex + 1; rowIndex < grid.length; rowIndex += 1) {
      const row = grid[rowIndex] || [];
      const periodText = textOf(row[0] && row[0].cell);
      const period = Number((periodText.match(/\d{1,2}/) || [])[0]);
      if (!period) continue;

      dayColumns.forEach((day, colIndex) => {
        const item = row[colIndex];
        if (!item || !item.cell) return;
        const idMatch = (item.cell.id || "").match(/^TD(\d+)_/);
        if (idMatch) indexMap.set(Number(idMatch[1]), { day, period });
      });
    }
    return indexMap;
  }

  function evaluateIndexExpression(expression, unitCount) {
    const compact = normalizeText(expression).replace(/\s/g, "");
    let match = compact.match(/^(\d+)\*unitCount\+(\d+)$/);
    if (match) return Number(match[1]) * unitCount + Number(match[2]);
    match = compact.match(/^(\d+)\+(\d+)\*unitCount$/);
    if (match) return Number(match[1]) + Number(match[2]) * unitCount;
    if (/^\d+$/.test(compact)) return Number(compact);
    return null;
  }

  function fallbackSlotFromIndex(index, unitCount) {
    if (!unitCount || index == null) return null;
    return {
      day: Math.floor(index / unitCount) + 1,
      period: (index % unitCount) + 1,
    };
  }

  function parseFullTimetableHtml(html, params) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const unitCountMatch = html.match(/var\s+unitCount\s*=\s*(\d+)\s*;/);
    const unitCount = unitCountMatch ? Number(unitCountMatch[1]) : 11;
    const from = extractWeekFrom(html);
    const indexSlotMap = buildIndexSlotMap(doc);
    const slots = [];
    const calls = Array.from(html.matchAll(/activity\s*=\s*new\s+TaskActivity\s*\(([\s\S]*?)\)\s*;/g));

    calls.forEach((match, callIndex) => {
      const args = splitJsArgs(match[1]);
      const prefix = html.slice(Math.max(0, match.index - 900), match.index);
      const afterStart = match.index + match[0].length;
      const afterEnd = callIndex + 1 < calls.length ? calls[callIndex + 1].index : html.length;
      const after = html.slice(afterStart, afterEnd);
      const name = readJsString(args[3]) || extractLastCourseName(prefix);
      const lessonNo = readJsString(args[4]);
      const room = readJsString(args[6]);
      const weekBits = readJsString(args[7]);
      const experiItemName = readJsString(args[11]);
      const weeks = parseValidWeeksBits(weekBits, from);
      const rawTitle = normalizeText([name, experiItemName, room].filter(Boolean).join(" "));
      const indexes = Array.from(after.matchAll(/index\s*=\s*([^;]+)\s*;/g))
        .map((item) => evaluateIndexExpression(item[1], unitCount))
        .filter((index) => index != null);

      indexes.forEach((index) => {
        const slot = indexSlotMap.get(index) || fallbackSlotFromIndex(index, unitCount);
        if (!slot || !slot.day || !slot.period || slot.day > 7) return;
        slots.push({
          day: slot.day,
          periods: [slot.period],
          weeks: weeks.length ? weeks : allWeeks(),
          title: name || lessonNo || "已排课程",
          room,
          raw: rawTitle || match[0],
        });
      });
    });

    if (!slots.length) return null;
    return {
      source: indexSlotMap.size ? "完整课表接口" : "完整课表接口（公式推断）",
      params,
      slots,
      cellsBySlot: new Map(),
    };
  }

  function saveFullTimetableFromHtml(html, params, source) {
    if (!/new\s+TaskActivity\s*\(/.test(html || "")) return false;

    const fullTimetable = parseFullTimetableHtml(html, params || {});
    if (!fullTimetable || !fullTimetable.slots.length) return false;

    fullTimetable.source = source || fullTimetable.source;
    const store = loadStore();
    if (validTimetableParams(params)) store.timetableParams = normalizeTimetableParams(params);
    store.timetable = serializeTimetable(fullTimetable, fullTimetable.source, params);
    saveStore(store);

    finishBackgroundTimetableRead(fullTimetable);
    return true;
  }

  function parseFullTimetableFromCurrentPage(visibleTimetable) {
    const html = document.documentElement ? document.documentElement.innerHTML : "";
    if (!/new\s+TaskActivity\s*\(/.test(html)) return null;

    const params = collectTimetableParams(document, html);
    const fullTimetable = parseFullTimetableHtml(html, params);
    if (!fullTimetable) return null;

    fullTimetable.source = "当前完整课表页面";
    return attachVisibleCells(fullTimetable, visibleTimetable);
  }

  async function fetchFullTimetable(force = false) {
    if (state.timetableFetch.running) return;
    if (!force && state.timetableFetch.attempted) return;
    if (!findElectionTable()) return;

    state.timetableFetch.running = true;
    state.timetableFetch.attempted = true;
    if (force) setStatus("正在读取完整课表，用真实周数校验冲突");

    try {
      const params = await fetchTimetableParams();
      const response = await fetch(new URL("/eams/courseTableForStd!courseTable.action", location.href).href, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        },
        body: new URLSearchParams(params).toString(),
      });
      if (!response.ok) throw new Error(`完整课表 HTTP ${response.status}`);

      const html = await response.text();
      const fullTimetable = parseFullTimetableHtml(html, params);
      if (!fullTimetable || !fullTimetable.slots.length) throw new Error("未解析到完整课表课程");

      const store = loadStore();
      store.timetableParams = params;
      store.timetable = serializeTimetable(fullTimetable, fullTimetable.source, params);
      saveStore(store);

      const visibleTimetable = parseTimetable();
      state.timetable = attachVisibleCells(fullTimetable, visibleTimetable);
      applyFilters();
      if (force) setStatus("完整课表已更新");
      maybeStartDetailFetch();
    } catch (error) {
      setStatus(`完整课表读取失败，暂用缩略课表：${error && error.message ? error.message : error}`);
    } finally {
      state.timetableFetch.running = false;
    }
  }

  function firstUsefulLine(text) {
    const lines = normalizeText(text).split("\n").map((line) => line.trim()).filter(Boolean);
    return lines.find((line) => !/^\(?\d{1,2}\s*[-,，]/.test(line) && !line.includes("实践周")) || lines[0] || "";
  }

  function slotKey(day, period) {
    return `${day}-${period}`;
  }

  function findElectionTable() {
    return Array.from(document.querySelectorAll("table")).find((table) => {
      const content = textOf(table);
      return content.includes("课程序号") && content.includes("课程名称") && content.includes("课程安排") && content.includes("操作");
    });
  }

  function getHeaderMap(table) {
    const rows = Array.from(table.rows || []);
    for (const row of rows) {
      const labels = Array.from(row.cells || []).map((cell) => textOf(cell));
      if (labels.includes("课程名称") && labels.some((label) => label.includes("课程安排"))) {
        const map = {};
        labels.forEach((label, index) => {
          if (label.includes("课程序号")) map.serial = index;
          if (label.includes("课程代码")) map.code = index;
          if (label.includes("课程名称")) map.name = index;
          if (label.includes("课程类别")) map.category = index;
          if (label.includes("学分")) map.credit = index;
          if (label.includes("教师姓名")) map.teacher = index;
          if (label.includes("周课时")) map.weekHours = index;
          if (label.includes("校区")) map.campus = index;
          if (label.includes("备注")) map.note = index;
          if (label.includes("已选")) map.capacity = index;
          if (label.includes("课程安排")) map.schedule = index;
          if (label.includes("操作")) map.action = index;
        });
        return { map, headerRow: row };
      }
    }
    return { map: {}, headerRow: null };
  }

  function parseCapacity(text) {
    const match = normalizeText(text).match(/(\d+)\s*\/\s*(\d+)/);
    if (!match) return { selected: null, limit: null, hasSeat: null };
    const selected = Number(match[1]);
    const limit = Number(match[2]);
    return { selected, limit, hasSeat: selected < limit };
  }

  function getCachedDetail(course, details) {
    return details[course.serial] || details[course.code] || details[course.name] || null;
  }

  function findDetailUrl(row, nameCell) {
    const candidates = Array.from((nameCell || row).querySelectorAll("a"));
    const link = candidates.find((anchor) => {
      const href = anchor.getAttribute("href") || "";
      const onclick = anchor.getAttribute("onclick") || "";
      return /info\.action|course\.id/.test(href + onclick);
    });

    if (!link) return "";

    const href = link.getAttribute("href") || "";
    if (href && !href.startsWith("javascript:")) {
      return new URL(href, location.href).href;
    }

    const onclick = link.getAttribute("onclick") || "";
    const urlMatch = onclick.match(/['"]([^'"]*(?:info\.action|course\.id)[^'"]*)['"]/);
    if (urlMatch) return new URL(urlMatch[1], location.href).href;

    return "";
  }

  function parseElectionRows() {
    const table = findElectionTable();
    if (!table) return [];

    const { map, headerRow } = getHeaderMap(table);
    if (!headerRow || map.name == null || map.schedule == null) return [];

    const store = loadStore();
    const details = store.details || {};
    const rows = Array.from(table.rows || []);
    const startIndex = rows.indexOf(headerRow) + 1;
    const courses = [];

    rows.slice(startIndex).forEach((row, index) => {
      const cells = Array.from(row.cells || []);
      const name = textOf(cells[map.name]);
      const scheduleText = textOf(cells[map.schedule]);
      if (!name || !scheduleText || !/\d{1,2}\s*-\s*\d{1,2}\s*周/.test(scheduleText)) return;

      const serial = textOf(cells[map.serial]);
      const code = textOf(cells[map.code]);
      const detail = getCachedDetail({ serial, code, name }, details);
      const course = {
        id: `${serial || code || name}-${index}`,
        serial,
        code,
        name,
        category: textOf(cells[map.category]),
        credit: textOf(cells[map.credit]),
        teacher: textOf(cells[map.teacher]),
        weekHours: textOf(cells[map.weekHours]),
        campus: textOf(cells[map.campus]),
        note: textOf(cells[map.note]),
        capacity: parseCapacity(textOf(cells[map.capacity])),
        scheduleText,
        slots: parseCandidateSchedule(scheduleText),
        buildings: parseScheduleBuildings(scheduleText),
        detail,
        detailUrl: findDetailUrl(row, cells[map.name]),
        row,
        nameCell: cells[map.name],
      };
      row.dataset.chdCourseHelperId = course.id;
      courses.push(course);
    });

    return courses;
  }

  function findConflicts(course, timetable) {
    if (!course.slots.length) return [{ type: "unknown", message: "无法解析课程时间" }];
    if (!timetable || !timetable.slots.length) return [];

    const conflicts = [];
    course.slots.forEach((candidate) => {
      timetable.slots.forEach((occupied) => {
        if (candidate.day !== occupied.day) return;
        if (!periodsOverlap(candidate.periods, occupied.periods)) return;
        if (!weeksOverlap(candidate.weeks, occupied.weeks)) return;
        conflicts.push({
          type: "conflict",
          day: candidate.day,
          periods: candidate.periods.filter((period) => occupied.periods.includes(period)),
          weeks: candidate.weeks.filter((week) => occupied.weeks.includes(week)),
          occupiedTitle: occupied.title,
        });
      });
    });
    return conflicts;
  }

  function hasEarlyMorningPeriods(course) {
    return (course.slots || []).some((slot) => (slot.periods || []).some((period) => period === 1 || period === 2));
  }

  function getSelectedBuildings() {
    return BUILDING_FILTER_ITEMS
      .filter((item) => state.filters[item.key])
      .map((item) => item.value);
  }

  function formatBuildings(buildings) {
    return (buildings && buildings.length ? buildings : ["未知"]).join("/");
  }

  function evaluateCourse(course) {
    const conflicts = findConflicts(course, state.timetable);
    const noConflict = conflicts.length === 0;
    const earlyMorning = hasEarlyMorningPeriods(course);
    const selectedBuildings = getSelectedBuildings();
    const activeBuildingFilter = selectedBuildings.length > 0;
    const courseBuildings = course.buildings || [];
    const buildingMatch = !activeBuildingFilter || (
      courseBuildings.length > 0 &&
      courseBuildings.every((building) => selectedBuildings.includes(building))
    );
    const detail = course.detail || {};
    const detailKnown = Boolean(course.detail);
    const examMode = normalizeText(detail.examMode || "");
    const language = normalizeText(detail.language || "");
    const prerequisite = normalizeText(detail.prerequisite || "");
    const activeExamFilter = state.filters.examKaocha || state.filters.examKaoshi;
    const activeLangFilter = state.filters.langChinese || state.filters.langBilingual;

    const checks = {
      noConflict,
      morningFriendly: !earlyMorning,
      building: buildingMatch,
      hasSeat: course.capacity.hasSeat !== false,
      noPrerequisite: detailKnown && (!prerequisite || prerequisite === "无"),
      exam: !activeExamFilter || (Boolean(examMode) && (
        (state.filters.examKaocha && examMode.includes("考查")) ||
        (state.filters.examKaoshi && examMode.includes("考试"))
      )),
      language: !activeLangFilter || (Boolean(language) && (
        (state.filters.langChinese && language.includes("中文")) ||
        (state.filters.langBilingual && language.includes("双语"))
      )),
    };

    const matched =
      (!state.filters.noConflict || checks.noConflict) &&
      (!state.filters.morningFriendly || checks.morningFriendly) &&
      (!activeBuildingFilter || checks.building) &&
      (!state.filters.hasSeat || checks.hasSeat) &&
      (!state.filters.noPrerequisite || checks.noPrerequisite) &&
      (!activeExamFilter || checks.exam) &&
      (!activeLangFilter || checks.language);

    const reasons = [];
    if (state.filters.noConflict && !checks.noConflict) {
      reasons.push("时间冲突");
    }
    if (state.filters.hasSeat && !checks.hasSeat) reasons.push("无余量");
    if (state.filters.morningFriendly && !checks.morningFriendly) reasons.push("含1-2节");
    if (activeBuildingFilter && !checks.building) reasons.push(`教学楼=${formatBuildings(courseBuildings)}`);
    if (noConflict) {
      if (state.filters.noPrerequisite && !checks.noPrerequisite) {
        reasons.push(detailKnown ? `有先修：${prerequisite || "未知"}` : "详情未知：先修");
      }
      if (activeExamFilter && !checks.exam) {
        reasons.push(detailKnown ? `考试方式=${examMode || "空"}` : "详情未知：考试方式");
      }
      if (activeLangFilter && !checks.language) {
        reasons.push(detailKnown ? `授课语言=${language || "空"}` : "详情未知：授课语言");
      }
    }

    return {
      conflicts,
      noConflict,
      earlyMorning,
      activeBuildingFilter,
      courseBuildings,
      matched,
      detail,
      detailKnown,
      activeExamFilter,
      activeLangFilter,
      reasons,
      examMode,
      language,
      prerequisite,
    };
  }

  function injectStyles() {
    if (document.getElementById("chd-course-helper-style")) return;

    const style = document.createElement("style");
    style.id = "chd-course-helper-style";
    style.textContent = `
      #chd-course-helper-panel {
        border: 1px solid #1683d8;
        background: #f6fbff;
        color: #111;
        font-size: 14px;
        margin: 10px 0;
        padding: 10px 12px;
        line-height: 1.5;
      }
      #chd-course-helper-panel .chd-helper-title {
        align-items: center;
        display: flex;
        font-size: 16px;
        font-weight: 700;
        gap: 10px;
        margin-bottom: 8px;
      }
      #chd-course-helper-panel .chd-helper-controls {
        align-items: center;
        display: flex;
        flex-wrap: wrap;
        gap: 8px 14px;
      }
      #chd-course-helper-panel .chd-helper-row-break {
        flex-basis: 100%;
        height: 0;
      }
      #chd-course-helper-panel label {
        align-items: center;
        display: inline-flex;
        gap: 4px;
        white-space: nowrap;
      }
      #chd-course-helper-panel button {
        background: #fff;
        border: 1px solid #7fb3df;
        border-radius: 3px;
        cursor: pointer;
        padding: 4px 10px;
      }
      #chd-course-helper-panel button:hover {
        background: #e8f4ff;
      }
      #chd-course-helper-panel .chd-filter-menu {
        display: inline-block;
        position: relative;
      }
      #chd-course-helper-panel .chd-filter-menu-button {
        min-width: 98px;
        text-align: left;
      }
      #chd-course-helper-panel .chd-filter-menu-button::after {
        content: "▾";
        float: right;
        margin-left: 8px;
      }
      #chd-course-helper-panel .chd-filter-menu.open .chd-filter-menu-button::after {
        content: "▴";
      }
      #chd-course-helper-panel .chd-filter-menu-list {
        background: #fff;
        border: 1px solid #7fb3df;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.16);
        display: none;
        left: 0;
        min-width: 120px;
        padding: 6px 8px;
        position: absolute;
        top: calc(100% + 4px);
        z-index: 10000;
      }
      #chd-course-helper-panel .chd-filter-menu.open .chd-filter-menu-list {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      #chd-course-helper-status {
        color: #285d8f;
        margin-left: auto;
      }
      tr.chd-helper-match {
        background: #c9ffd0 !important;
      }
      tr.chd-helper-conflict {
        background: #ffe1e1 !important;
      }
      tr.chd-helper-unmatched {
        background: #eee !important;
        color: #666 !important;
      }
      tr.chd-helper-hidden {
        display: none !important;
      }
      tr.chd-helper-selected {
        outline: 3px solid #21a366;
        outline-offset: -3px;
      }
      .chd-helper-preview-ok {
        box-shadow: inset 0 0 0 9999px rgba(116, 232, 140, 0.48) !important;
      }
      .chd-helper-preview-conflict {
        box-shadow: inset 0 0 0 9999px rgba(255, 128, 128, 0.50) !important;
      }
      .chd-helper-debug {
        display: inline-flex;
        flex-direction: column;
        align-items: center;
        gap: 2px;
        margin-top: 5px;
        max-width: 100%;
      }
      .chd-helper-badge {
        display: inline-block;
        padding: 1px 5px;
        border-radius: 3px;
        font-size: 12px;
        max-width: 190px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .chd-helper-badge-ok {
        background: #dff7e4;
        color: #116b2b;
      }
      .chd-helper-badge-bad {
        background: #ffdede;
        color: #8a1f1f;
      }
      .chd-helper-badge-unknown {
        background: #fff1c6;
        color: #6e5200;
      }
      .chd-helper-badge-info {
        background: #e6f1ff;
        color: #184f86;
      }
    `;
    document.head.appendChild(style);
  }

  function createCheckbox(key, label) {
    const wrapper = document.createElement("label");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.dataset.chdFilterKey = key;
    input.checked = Boolean(state.filters[key]);
    input.addEventListener("change", () => {
      handleFilterChange(key, input.checked);
    });
    wrapper.append(input, document.createTextNode(label));
    return wrapper;
  }

  function handleFilterChange(key, checked) {
    state.filters[key] = checked;

    if (checked && isDetailFilter(key)) {
      state.filters.noConflict = true;
    }

    saveFilters();
    syncFilterInputs();
    applyFilters();
    maybeStartDetailFetch();
  }

  function createFilterMenu(title, items) {
    const wrapper = document.createElement("span");
    wrapper.className = "chd-filter-menu";

    const button = document.createElement("button");
    button.type = "button";
    button.className = "chd-filter-menu-button";
    button.dataset.chdMenuTitle = title;
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      document.querySelectorAll(".chd-filter-menu.open").forEach((menu) => {
        if (menu !== wrapper) menu.classList.remove("open");
      });
      wrapper.classList.toggle("open");
    });

    const list = document.createElement("span");
    list.className = "chd-filter-menu-list";
    list.addEventListener("click", (event) => event.stopPropagation());

    items.forEach((item) => {
      const label = document.createElement("label");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.dataset.chdFilterKey = item.key;
      input.checked = Boolean(state.filters[item.key]);
      input.addEventListener("change", () => handleFilterChange(item.key, input.checked));
      label.append(input, document.createTextNode(item.label));
      list.append(label);
    });

    wrapper.append(button, list);
    updateFilterMenuTitle(button, items);
    return wrapper;
  }

  function updateFilterMenuTitle(button, items) {
    const selected = items.filter((item) => state.filters[item.key]).map((item) => item.label);
    button.textContent = selected.length ? `${button.dataset.chdMenuTitle}：${selected.join("/")}` : button.dataset.chdMenuTitle;
  }

  function syncFilterInputs() {
    document.querySelectorAll("[data-chd-filter-key]").forEach((input) => {
      const key = input.dataset.chdFilterKey;
      input.checked = Boolean(state.filters[key]);
    });
    document.querySelectorAll(".chd-filter-menu-button").forEach((button) => {
      const title = button.dataset.chdMenuTitle;
      if (title === "考试方式") {
        updateFilterMenuTitle(button, [
          { key: "examKaocha", label: "考查" },
          { key: "examKaoshi", label: "考试" },
        ]);
      }
      if (title === "授课语言") {
        updateFilterMenuTitle(button, [
          { key: "langChinese", label: "中文" },
          { key: "langBilingual", label: "双语" },
        ]);
      }
      if (title === "教学楼位置") {
        updateFilterMenuTitle(button, BUILDING_FILTER_ITEMS);
      }
    });
  }

  function ensurePanel() {
    injectStyles();
    let panel = document.getElementById("chd-course-helper-panel");
    if (panel) return panel;

    panel = document.createElement("div");
    panel.id = "chd-course-helper-panel";
    panel.innerHTML = `
      <div class="chd-helper-title">
        <span>选课辅助筛选 v${SCRIPT_VERSION}</span>
        <span id="chd-course-helper-status"></span>
      </div>
      <div class="chd-helper-controls" id="chd-course-helper-controls"></div>
    `;

    const controls = panel.querySelector("#chd-course-helper-controls");
    const scanButton = document.createElement("button");
    scanButton.type = "button";
    scanButton.textContent = "读取/刷新";
    scanButton.addEventListener("click", scanPage);

    const backgroundTimetableButton = document.createElement("button");
    backgroundTimetableButton.type = "button";
    backgroundTimetableButton.textContent = "后台读取课表";
    backgroundTimetableButton.addEventListener("click", startBackgroundTimetableRead);

    const cacheDetailButton = document.createElement("button");
    cacheDetailButton.type = "button";
    cacheDetailButton.textContent = "缓存当前详情";
    cacheDetailButton.addEventListener("click", cacheCurrentDetail);

    const fetchDetailsButton = document.createElement("button");
    fetchDetailsButton.type = "button";
    fetchDetailsButton.textContent = "读取匹配详情";
    fetchDetailsButton.addEventListener("click", () => startDetailFetch());

    const stopDetailsButton = document.createElement("button");
    stopDetailsButton.type = "button";
    stopDetailsButton.textContent = "停止详情读取";
    stopDetailsButton.addEventListener("click", stopDetailFetch);

    const detailActionBreak = document.createElement("span");
    detailActionBreak.className = "chd-helper-row-break";

    controls.append(
      scanButton,
      backgroundTimetableButton,
      createCheckbox("noConflict", "时间无冲突"),
      createCheckbox("morningFriendly", "早八友好课表"),
      createCheckbox("hasSeat", "有余量"),
      createCheckbox("noPrerequisite", "无先修课程"),
      createFilterMenu("考试方式", [
        { key: "examKaocha", label: "考查" },
        { key: "examKaoshi", label: "考试" },
      ]),
      createFilterMenu("授课语言", [
        { key: "langChinese", label: "中文" },
        { key: "langBilingual", label: "双语" },
      ]),
      createFilterMenu("教学楼位置", BUILDING_FILTER_ITEMS),
      createCheckbox("hideUnmatched", "只看匹配"),
      detailActionBreak,
      fetchDetailsButton,
      stopDetailsButton,
      cacheDetailButton
    );

    const target = findElectionTable() || findTimetableTable() || document.body.firstElementChild;
    if (target && target.parentNode) {
      target.parentNode.insertBefore(panel, target);
    } else {
      document.body.prepend(panel);
    }

    document.addEventListener("click", closeFilterMenus);

    return panel;
  }

  function closeFilterMenus() {
    document.querySelectorAll(".chd-filter-menu.open").forEach((menu) => {
      menu.classList.remove("open");
    });
  }

  function setStatus(message) {
    const status = document.getElementById("chd-course-helper-status");
    if (status) status.textContent = message;
  }

  function scanPage() {
    ensurePanel();
    const store = loadStore();
    const visibleTimetable = parseTimetable();
    const currentFullTimetable = parseFullTimetableFromCurrentPage(visibleTimetable);
    if (currentFullTimetable) {
      store.timetable = serializeTimetable(currentFullTimetable, currentFullTimetable.source, currentFullTimetable.params);
      if (validTimetableParams(currentFullTimetable.params)) store.timetableParams = normalizeTimetableParams(currentFullTimetable.params);
      saveStore(store);
      finishBackgroundTimetableRead(currentFullTimetable);
    }
    const storedTimetable = normalizeStoredTimetable(store.timetable, visibleTimetable);
    const storedIsFull = storedTimetable && /^完整课表/.test(storedTimetable.source || "");
    const storedIsCurrentFull = storedTimetable && storedTimetable.source === "当前完整课表页面";
    state.timetable = currentFullTimetable || (storedIsFull || storedIsCurrentFull ? storedTimetable : null) || visibleTimetable || storedTimetable || null;
    state.courses = parseElectionRows();
    state.lastElectionSignature = getElectionSignature();

    if (visibleTimetable && !findElectionTable() && !currentFullTimetable) {
      store.timetable = serializeTimetable(visibleTimetable, visibleTimetable.source);
      saveStore(store);
    }

    bindCourseRows();
    applyFilters();

    fetchFullTimetable(false);
    maybeStartDetailFetch();
  }

  function getElectionSignature() {
    const table = findElectionTable();
    if (!table) return "";
    return Array.from(table.querySelectorAll("tbody tr"))
      .slice(0, 8)
      .map((row) => normalizeText(row.innerText).slice(0, 120))
      .join("|");
  }

  function scheduleAutoScan() {
    if (state.autoScanTimer) window.clearTimeout(state.autoScanTimer);
    state.autoScanTimer = window.setTimeout(() => {
      if (state.detailFetch.running) return;
      const signature = getElectionSignature();
      if (!signature || signature === state.lastElectionSignature) return;
      state.lastElectionSignature = signature;
      clearPreview();
      state.selectedCourseId = null;
      scanPage();
    }, 600);
  }

  function setupAutoScanObserver() {
    if (state.observer) return;
    const target = document.querySelector("#courseTable, #electableLessonList_data") || document.body;
    state.observer = new MutationObserver((mutations) => {
      const changed = mutations.some((mutation) => {
        const targetNode = mutation.target;
        if (targetNode && targetNode.closest && targetNode.closest("#chd-course-helper-panel")) return false;
        return mutation.addedNodes.length || mutation.removedNodes.length || mutation.type === "childList";
      });
      if (changed) scheduleAutoScan();
    });
    state.observer.observe(target, {
      childList: true,
      subtree: true,
    });
  }

  function maybeStartDetailFetch() {
    if (!hasActiveDetailFilters()) return;
    if (!findElectionTable()) return;
    if (!state.courses.length) return;
    startDetailFetch();
  }

  function stopDetailFetch() {
    if (!state.detailFetch.running) {
      setStatus("当前没有正在读取的详情");
      return;
    }
    state.detailFetch.stopRequested = true;
    setStatus("正在停止详情读取，当前课程完成后停止");
  }

  async function startDetailFetch() {
    if (state.detailFetch.running) return;
    if (!state.courses.length) scanPage();
    if (state.detailFetch.running) return;
    if (!state.courses.length) return;

    state.filters.noConflict = true;
    syncFilterInputs();
    saveFilters();
    applyFilters();

    const queue = state.courses
      .filter((course) => !course.detail)
      .filter((course) => course.detailUrl)
      .filter((course) => findConflicts(course, state.timetable).length === 0)
      .slice(0, DETAIL_FETCH_LIMIT);

    if (!queue.length) {
      setStatus("没有需要补充详情的时间无冲突课程");
      return;
    }

    state.detailFetch.running = true;
    state.detailFetch.stopRequested = false;

    let done = 0;
    for (let index = 0; index < queue.length; index += 1) {
      const course = queue[index];
      if (state.detailFetch.stopRequested) break;
      setStatus(`正在低频读取详情 ${index + 1}/${queue.length}：${course.name}`);

      try {
        const detailFields = await fetchCourseDetail(course);
        if (detailFields) {
          course.detail = detailFields;
          done += 1;
          applyFilters();
        }
      } catch (error) {
        markDetailFailure(course, error);
      }

      if (!state.detailFetch.stopRequested && index < queue.length - 1) {
        await sleep(DETAIL_FETCH_DELAY_MS);
      }
    }

    state.detailFetch.running = false;
    state.detailFetch.stopRequested = false;
    state.courses = parseElectionRows();
    bindCourseRows();
    applyFilters();
    setStatus(`详情读取结束，已补充 ${done} 门；本页可选课 ${state.courses.length} 门`);
  }

  async function fetchCourseDetail(course) {
    const response = await fetch(course.detailUrl, {
      credentials: "include",
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const html = await response.text();
    if (/authserver\/login|登录|密码/.test(html) && !html.includes("考试方式")) {
      throw new Error("登录状态可能已失效");
    }

    const doc = new DOMParser().parseFromString(html, "text/html");
    const detail = readDetailFieldsFromDocument(doc);
    if (!Object.keys(detail.fields).length) {
      throw new Error("未识别到详情字段");
    }

    return saveCourseDetail(course, detail);
  }

  function saveCourseDetail(course, detail) {
    const store = loadStore();
    store.details = store.details || {};

    const detailFields = {
      ...detail.fields,
      capturedAt: new Date().toISOString(),
    };
    const keys = [course.serial, course.code, course.name, detail.key, detail.name]
      .map((key) => normalizeText(key))
      .filter(Boolean);

    keys.forEach((key) => {
      store.details[key] = detailFields;
    });
    saveStore(store);

    return detailFields;
  }

  function markDetailFailure(course, error) {
    const store = loadStore();
    store.detailFailures = store.detailFailures || {};
    const key = course.serial || course.code || course.name;
    if (key) {
      store.detailFailures[key] = {
        message: error && error.message ? error.message : String(error),
        capturedAt: new Date().toISOString(),
      };
      saveStore(store);
    }
  }

  function bindCourseRows() {
    state.courses.forEach((course) => {
      if (course.row.dataset.chdCourseHelperBound === "1") return;
      course.row.dataset.chdCourseHelperBound = "1";
      course.row.addEventListener("click", (event) => {
        const actionText = textOf(event.target);
        if (actionText === "选课") return;
        selectCourse(course.id);
      });
    });
  }

  function applyFilters() {
    state.courses.forEach((course) => {
      const result = evaluateCourse(course);
      const row = course.row;
      row.classList.remove("chd-helper-match", "chd-helper-conflict", "chd-helper-unmatched", "chd-helper-hidden");

      if (result.matched) row.classList.add("chd-helper-match");
      if (state.filters.noConflict && !result.noConflict) row.classList.add("chd-helper-conflict");
      if (!result.matched) row.classList.add("chd-helper-unmatched");
      if (!result.matched && state.filters.hideUnmatched) row.classList.add("chd-helper-hidden");

      addBadge(course, result);
    });
  }

  function addBadge(course, result) {
    if (!course.nameCell) return;
    clearBadge(course.nameCell);

    const panel = document.createElement("span");
    panel.className = "chd-helper-debug";

    if (!course.slots.length) {
      panel.append(createBadge("unknown", "时间未知"));
    } else if (hasActiveDetailFilters() && result.noConflict && !course.detail) {
      panel.append(createBadge("unknown", "详情未知"));
    } else if (result.noConflict) {
      panel.append(createBadge("ok", "时间无冲突"));
    } else {
      const first = result.conflicts[0];
      const badge = createBadge("bad", `冲突：${DAYS[first.day - 1]} ${first.periods.join(",")}节`);
      badge.title = result.conflicts
        .map((item) => `${DAYS[item.day - 1]} ${item.periods.join(",")}节，${item.weeks.slice(0, 8).join(",")}周：${item.occupiedTitle}`)
        .join("\n");
      panel.append(badge);
    }

    if (result.activeBuildingFilter) {
      panel.append(createBadge("info", `地点：${formatBuildings(result.courseBuildings)}`));
    }

    if (result.noConflict && result.detailKnown) {
      if (result.examMode) panel.append(createBadge("info", `考试：${result.examMode}`));
      if (result.language) panel.append(createBadge("info", `语言：${result.language}`));
      panel.append(createBadge(result.prerequisite && result.prerequisite !== "无" ? "unknown" : "info", `先修：${result.prerequisite || "无"}`));
    } else if (result.noConflict && hasActiveDetailFilters()) {
      panel.append(createBadge("unknown", course.detailUrl ? "等待读取详情" : "无详情链接"));
    }

    result.reasons.slice(0, 2).forEach((reason) => {
      panel.append(createBadge("bad", `不匹配：${reason}`));
    });

    course.nameCell.append(document.createElement("br"), panel);
  }

  function createBadge(type, text) {
    const badge = document.createElement("span");
    badge.className = `chd-helper-badge chd-helper-badge-${type}`;
    badge.textContent = text;
    badge.title = text;
    return badge;
  }

  function clearBadge(cell) {
    cell.querySelectorAll(".chd-helper-debug").forEach((panel) => {
      const previous = panel.previousSibling;
      if (previous && previous.nodeName === "BR") previous.remove();
      panel.remove();
    });
    cell.querySelectorAll(":scope > .chd-helper-badge").forEach((badge) => {
      const previous = badge.previousSibling;
      if (previous && previous.nodeName === "BR") previous.remove();
      badge.remove();
    });

    while (cell.lastChild && cell.lastChild.nodeName === "BR") {
      cell.lastChild.remove();
    }
  }

  function clearPreview() {
    document.querySelectorAll(".chd-helper-preview-ok,.chd-helper-preview-conflict").forEach((cell) => {
      cell.classList.remove("chd-helper-preview-ok", "chd-helper-preview-conflict");
    });
    document.querySelectorAll("tr.chd-helper-selected").forEach((row) => {
      row.classList.remove("chd-helper-selected");
    });
  }

  function selectCourse(courseId) {
    const course = state.courses.find((item) => item.id === courseId);
    if (!course) return;

    if (state.selectedCourseId === courseId) {
      clearPreview();
      state.selectedCourseId = null;
      return;
    }

    clearPreview();
    state.selectedCourseId = courseId;
    course.row.classList.add("chd-helper-selected");

    if (!state.timetable) return;

    course.slots.forEach((slot) => {
      slot.periods.forEach((period) => {
        const key = slotKey(slot.day, period);
        const cell = state.timetable.cellsBySlot.get(key);
        if (!cell) return;

        const hasConflict = state.timetable.slots.some((occupied) => (
          occupied.day === slot.day &&
          occupied.periods.includes(period) &&
          weeksOverlap(slot.weeks, occupied.weeks)
        ));

        cell.classList.add(hasConflict ? "chd-helper-preview-conflict" : "chd-helper-preview-ok");
      });
    });
  }

  function readDetailFieldsFromDocument(doc = document) {
    const labels = {
      prerequisite: ["先修课程"],
      language: ["授课语言"],
      examMode: ["考试方式"],
      englishName: ["英文名"],
      department: ["建议开课院系"],
      category: ["建议课程类别"],
      description: ["课程简介"],
      note: ["备注"],
      valid: ["是否有效"],
      updatedAt: ["修改时间"],
    };
    const cells = Array.from(doc.querySelectorAll("td, th"));
    const fields = {};

    cells.forEach((cell, index) => {
      const labelText = textOf(cell).replace(/[：:]\s*$/, "");
      Object.entries(labels).forEach(([key, names]) => {
        if (!names.includes(labelText)) return;
        const next = cells[index + 1];
        const value = textOf(next);
        if (value && !fields[key]) fields[key] = value;
      });
    });

    const bodyText = textOf(doc.body);
    const codeMatch = bodyText.match(/代码\s*[：:]\s*([A-Za-z0-9.]+)/);
    const nameMatch = bodyText.match(/名称\s*[：:]\s*([^\n]+)/);

    return {
      key: codeMatch ? codeMatch[1] : "",
      name: nameMatch ? normalizeText(nameMatch[1]) : "",
      fields,
    };
  }

  function cacheCurrentDetail(options = {}) {
    const detail = readDetailFieldsFromDocument();
    if (!Object.keys(detail.fields).length) {
      if (!options.silent) setStatus("没有在当前页面发现课程详情字段");
      return false;
    }

    const key = detail.key || detail.name;
    if (!key) {
      if (!options.silent) setStatus("已识别详情字段，但未找到课程代码/名称，暂未缓存");
      return false;
    }

    const detailFields = saveCourseDetail({ code: detail.key, name: detail.name }, detail);
    setStatus(`已缓存详情：${detail.name || key}`);
    state.courses.forEach((course) => {
      if (course.code === detail.key || course.name === detail.name) course.detail = detailFields;
    });
    applyFilters();
    return true;
  }

  function boot() {
    if (location.hostname === "ids.chd.edu.cn") return;
    setupTimetableRequestCapture();
    if (isBackgroundReadPage()) {
      updateBackgroundReadStore({
        id: getBackgroundReadId(),
        status: "waiting",
        message: "后台课表页已打开，正在等待课表数据",
      });
    }
    ensurePanel();
    setupAutoScanObserver();
    [800, 2200, 5000].forEach((delay) => window.setTimeout(() => {
      scanPage();
      cacheCurrentDetail({ silent: true });
    }, delay));
  }

  if (location.hostname !== "ids.chd.edu.cn") {
    setupTimetableRequestCapture();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
