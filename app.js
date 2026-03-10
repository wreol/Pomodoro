/**
 * app.js — Pomodoro Timer 核心逻辑
 *
 * 架构概览：
 *   Constants   → 静态配置（圆周长、模式标签）
 *   State       → 运行时状态（当前模式、剩余秒数、计时器 ID）
 *   Settings    → 用户配置（从 localStorage 读写）
 *   Timer       → 计时核心（start / stop / tick / complete）
 *   UI Updates  → DOM 更新（时间显示、环形进度、会话圆点）
 *   Sound       → Web Audio API 合成提示音
 *   Notify      → 桌面通知（Notification API）
 *   Theme       → 深色/浅色主题切换
 *   Modal       → 设置弹窗（打开/关闭/保存）
 *   Events      → 所有事件绑定
 *   Init        → 初始化入口
 */

// ===== Constants =====

/** 进度环周长：2π × r(100) ≈ 628.3，用于计算 stroke-dashoffset */
const CIRCUMFERENCE = 2 * Math.PI * 100;

/** 各模式在计时器下方显示的中文标签 */
const MODE_LABELS = {
  pomodoro: '专注时间',
  short: '短暂休息',
  long: '长时休息',
};

// ===== State =====

/** 从 localStorage 加载一次用户设置 */
let settings = loadSettings();

/**
 * 应用运行时状态
 * @property {string}  mode         - 当前模式：'pomodoro' | 'short' | 'long'
 * @property {boolean} running      - 计时器是否在运行
 * @property {number}  remaining    - 剩余秒数
 * @property {number}  total        - 当前模式总秒数（用于计算进度百分比）
 * @property {number}  sessionsDone - 本轮已完成的番茄数（达到 settings.sessions 后触发长休息）
 * @property {number|null} timerId  - setInterval 返回的 ID，null 表示未运行
 */
let state = {
  mode: 'pomodoro',
  running: false,
  remaining: settings.pomodoro * 60,
  total: settings.pomodoro * 60,
  sessionsDone: 0,
  timerId: null,
};

// ===== DOM References =====

/** 简写 getElementById */
const $ = (id) => document.getElementById(id);

const timeDisplay  = $('time-display');   // 时间数字文本
const modeLabel    = $('mode-label');     // 模式标签文本
const ringProgress = $('ring-progress'); // SVG 进度弧 <circle>
const btnStart     = $('btn-start');      // 开始/暂停 按钮
const btnReset     = $('btn-reset');      // 重置按钮
const btnSkip      = $('btn-skip');       // 跳过按钮
const sessionCount = $('session-count'); // 当前组数显示
const sessionTotal = $('session-total'); // 总组数显示
const sessionDots  = $('session-dots');  // 圆点容器
const modalOverlay = $('modal-overlay'); // 设置弹窗遮罩
const timerRing    = document.querySelector('.timer-ring'); // 环形计时器容器

// ===== Settings =====

/**
 * 从 localStorage 读取用户设置，失败时返回默认值
 * @returns {Object} 设置对象
 */
function loadSettings() {
  try {
    const saved = localStorage.getItem('pomodoro-settings');
    if (saved) return JSON.parse(saved);
  } catch (_) {}
  // 默认设置
  return {
    pomodoro: 25,   // 专注时长（分钟）
    short: 5,       // 短休息时长（分钟）
    long: 15,       // 长休息时长（分钟）
    sessions: 4,    // 触发长休息前需完成的番茄数
    sound: true,    // 声音提醒
    notify: false,  // 桌面通知
    auto: false,    // 自动开始下一轮
    theme: 'dark',  // 主题
  };
}

/**
 * 将设置对象序列化后写入 localStorage
 * @param {Object} s - 设置对象
 */
function saveSettings(s) {
  localStorage.setItem('pomodoro-settings', JSON.stringify(s));
}

// ===== Timer Logic =====

/**
 * 根据模式名返回该模式的总秒数
 * @param {string} mode - 'pomodoro' | 'short' | 'long'
 * @returns {number} 秒数
 */
function getDuration(mode) {
  const map = { pomodoro: settings.pomodoro, short: settings.short, long: settings.long };
  return map[mode] * 60;
}

/**
 * 手动切换模式（点击 Tab 时调用）
 * - 停止当前计时
 * - 重置时间为目标模式时长
 * - 更新 UI（标签激活态、环形颜色、时间显示）
 * @param {string} mode
 */
function setMode(mode) {
  state.mode = mode;
  if (state.running) stopTimer();
  state.remaining = getDuration(mode);
  state.total = state.remaining;

  // 同步 Tab 激活状态及无障碍属性
  document.querySelectorAll('.tab').forEach(t => {
    t.classList.toggle('active', t.dataset.mode === mode);
    t.setAttribute('aria-selected', t.dataset.mode === mode);
  });

  // 切换环形颜色（通过 CSS class 实现）
  timerRing.className = 'timer-ring';
  if (mode !== 'pomodoro') timerRing.classList.add(`mode-${mode}`);

  modeLabel.textContent = MODE_LABELS[mode];
  updateDisplay();
  updateRing(1); // 重置为满圆
  btnStart.textContent = '开始';
}

/**
 * 启动计时器：每秒触发一次 tick()
 */
function startTimer() {
  state.running = true;
  btnStart.textContent = '暂停';
  timerRing.classList.add('running'); // 触发 CSS 发光脉冲动画
  state.timerId = setInterval(tick, 1000);
}

/**
 * 暂停计时器：清除 interval，保留剩余时间
 */
function stopTimer() {
  state.running = false;
  btnStart.textContent = '继续';
  timerRing.classList.remove('running');
  clearInterval(state.timerId);
  state.timerId = null;
}

/**
 * 每秒执行一次：
 * - 剩余为 0 时触发完成逻辑
 * - 否则减 1 秒并更新 UI
 */
function tick() {
  if (state.remaining <= 0) {
    onComplete();
    return;
  }
  state.remaining--;
  updateDisplay();
  updateRing(state.remaining / state.total);
}

/**
 * 计时结束时的处理：
 * 1. 停止计时器
 * 2. 播放提示音 / 发送通知
 * 3. 更新会话计数
 * 4. 决定下一个模式（短休息 / 长休息 / 专注）
 */
function onComplete() {
  clearInterval(state.timerId);
  state.timerId = null;
  state.running = false;
  timerRing.classList.remove('running');

  if (settings.sound)  playBeep();
  if (settings.notify) showNotification();

  if (state.mode === 'pomodoro') {
    state.sessionsDone++;
    updateSessionDots();

    // 完成指定轮数后触发长休息，并重置计数
    if (state.sessionsDone >= settings.sessions) {
      state.sessionsDone = 0;
      updateSessionDots();
      transitionTo('long');
    } else {
      transitionTo('short');
    }
  } else {
    // 休息结束后回到专注模式
    transitionTo('pomodoro');
  }
}

/**
 * 自动切换到指定模式（计时完成后的内部跳转）
 * 与 setMode 的区别：会根据 settings.auto 决定是否自动开始
 * @param {string} mode
 */
function transitionTo(mode) {
  state.mode = mode;
  state.remaining = getDuration(mode);
  state.total = state.remaining;

  document.querySelectorAll('.tab').forEach(t => {
    t.classList.toggle('active', t.dataset.mode === mode);
    t.setAttribute('aria-selected', t.dataset.mode === mode);
  });

  timerRing.className = 'timer-ring';
  if (mode !== 'pomodoro') timerRing.classList.add(`mode-${mode}`);

  modeLabel.textContent = MODE_LABELS[mode];
  updateDisplay();
  updateRing(1);

  if (settings.auto) {
    startTimer(); // 自动开始：无需用户操作
  } else {
    btnStart.textContent = '开始';
  }

  updateSessionLabel();
}

// ===== UI Updates =====

/**
 * 将剩余秒数格式化为 MM:SS 并写入 DOM 和 document.title
 */
function updateDisplay() {
  const m = Math.floor(state.remaining / 60);
  const s = state.remaining % 60;
  const str = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  timeDisplay.textContent = str;
  document.title = `${str} — Pomodoro`; // 标签页也显示倒计时
}

/**
 * 根据进度比例更新 SVG 进度弧的 stroke-dashoffset
 * fraction = 1 → 满圆（开始）
 * fraction = 0 → 空（结束）
 * @param {number} fraction - 0~1
 */
function updateRing(fraction) {
  const offset = CIRCUMFERENCE * (1 - fraction);
  ringProgress.style.strokeDashoffset = offset;
}

/**
 * 重新渲染会话圆点：已完成的填充 accent 色，未完成的为空心
 */
function updateSessionDots() {
  sessionDots.innerHTML = '';
  for (let i = 0; i < settings.sessions; i++) {
    const dot = document.createElement('div');
    dot.className = 'dot' + (i < state.sessionsDone ? ' filled' : '');
    sessionDots.appendChild(dot);
  }
}

/**
 * 更新"第 N 组，共 M 个番茄"的文字显示
 */
function updateSessionLabel() {
  const current = state.sessionsDone + 1;
  sessionCount.textContent = Math.min(current, settings.sessions);
  sessionTotal.textContent = settings.sessions;
}

// ===== Sound =====

/**
 * 使用 Web Audio API 合成三声短促的提示音（无需音频文件）
 * 频率 880Hz，每声间隔 0.3s，通过 GainNode 实现淡入淡出
 */
function playBeep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const times = [0, 0.3, 0.6]; // 三声的起始时间偏移
    times.forEach(t => {
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = 880;
      osc.type = 'sine';
      // 淡入（0 → 0.4）再淡出（0.4 → 0）
      gain.gain.setValueAtTime(0, ctx.currentTime + t);
      gain.gain.linearRampToValueAtTime(0.4, ctx.currentTime + t + 0.05);
      gain.gain.linearRampToValueAtTime(0, ctx.currentTime + t + 0.25);
      osc.start(ctx.currentTime + t);
      osc.stop(ctx.currentTime + t + 0.3);
    });
  } catch (_) {
    // 静默失败（部分浏览器限制 AudioContext）
  }
}

// ===== Notifications =====

/**
 * 发送桌面通知（需要 Notification.permission === 'granted'）
 * 通知内容根据当前（完成的）模式决定
 */
function showNotification() {
  if (!('Notification' in window)) return;
  const messages = {
    pomodoro: { title: '休息结束！',  body: '专注时间开始，加油！' },
    short:    { title: '番茄完成！',  body: '短暂休息一下吧。' },
    long:     { title: '番茄完成！',  body: '去好好休息一段时间吧！' },
  };
  const msg = messages[state.mode] || messages.short;
  if (Notification.permission === 'granted') {
    new Notification(msg.title, {
      body: msg.body,
      icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">🍅</text></svg>',
    });
  }
}

/**
 * 请求桌面通知权限
 * 若用户拒绝，将 checkbox 恢复为未勾选
 * @param {HTMLInputElement} el - 对应的 checkbox 元素
 */
function requestNotifyPermission(el) {
  if (!('Notification' in window)) {
    el.checked = false;
    return;
  }
  if (Notification.permission === 'granted') return;
  Notification.requestPermission().then(perm => {
    if (perm !== 'granted') el.checked = false;
  });
}

// ===== Theme =====

/**
 * 切换主题：设置 <html> 的 data-theme 属性，同步主题按钮激活态
 * @param {string} theme - 'dark' | 'light'
 */
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  document.querySelectorAll('.theme-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.theme === theme);
  });
}

// ===== Modal =====

/**
 * 打开设置弹窗：将当前 settings 值回填到表单，然后显示面板
 */
function openModal() {
  $('set-pomodoro').value  = settings.pomodoro;
  $('set-short').value     = settings.short;
  $('set-long').value      = settings.long;
  $('set-sessions').value  = settings.sessions;
  $('set-sound').checked   = settings.sound;
  $('set-notify').checked  = settings.notify;
  $('set-auto').checked    = settings.auto;
  document.querySelectorAll('.theme-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.theme === settings.theme);
  });
  modalOverlay.classList.add('open');
  modalOverlay.removeAttribute('aria-hidden');
}

/** 关闭设置弹窗 */
function closeModal() {
  modalOverlay.classList.remove('open');
  modalOverlay.setAttribute('aria-hidden', 'true');
}

/**
 * 读取表单数据，校验范围后保存并应用设置
 * - 若计时器未运行，立即用新时长刷新显示
 */
function saveSettingsFromModal() {
  const newSettings = {
    pomodoro: Math.max(1, Math.min(60, parseInt($('set-pomodoro').value) || 25)),
    short:    Math.max(1, Math.min(30, parseInt($('set-short').value)    || 5)),
    long:     Math.max(1, Math.min(60, parseInt($('set-long').value)     || 15)),
    sessions: Math.max(1, Math.min(10, parseInt($('set-sessions').value) || 4)),
    sound:    $('set-sound').checked,
    notify:   $('set-notify').checked,
    auto:     $('set-auto').checked,
    theme:    document.querySelector('.theme-btn.active')?.dataset.theme || 'dark',
  };

  settings = newSettings;
  saveSettings(settings);
  applyTheme(settings.theme);

  // 计时器未运行时立即更新显示
  if (!state.running) {
    state.remaining = getDuration(state.mode);
    state.total = state.remaining;
    updateDisplay();
    updateRing(1);
  }

  updateSessionDots();
  updateSessionLabel();
  closeModal();
}

// ===== Event Listeners =====

/** 开始/暂停 按钮 */
btnStart.addEventListener('click', () => {
  if (state.running) {
    stopTimer();
  } else {
    startTimer();
  }
});

/** 重置按钮：停止并将时间恢复为当前模式总时长 */
btnReset.addEventListener('click', () => {
  if (state.running) stopTimer();
  state.remaining = state.total;
  btnStart.textContent = '开始';
  updateDisplay();
  updateRing(1);
});

/** 跳过按钮：直接触发完成逻辑（等同于时间归零） */
btnSkip.addEventListener('click', () => {
  if (state.running) stopTimer();
  onComplete();
});

/** 模式 Tab 点击 */
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => setMode(tab.dataset.mode));
});

/** 设置弹窗：打开 / 关闭 / 保存 */
$('btn-settings').addEventListener('click', openModal);
$('btn-close-modal').addEventListener('click', closeModal);
$('btn-save-settings').addEventListener('click', saveSettingsFromModal);

/** 点击遮罩关闭弹窗 */
modalOverlay.addEventListener('click', (e) => {
  if (e.target === modalOverlay) closeModal();
});

/** 键盘快捷键：
 *   Escape → 关闭弹窗
 *   Space  → 开始/暂停（弹窗关闭时有效）
 */
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && modalOverlay.classList.contains('open')) {
    closeModal();
  }
  if (e.code === 'Space' && !modalOverlay.classList.contains('open') && e.target === document.body) {
    e.preventDefault();
    btnStart.click();
  }
});

/** 桌面通知开关：勾选时申请权限 */
$('set-notify').addEventListener('change', (e) => {
  if (e.target.checked) requestNotifyPermission(e.target);
});

/** 主题按钮（弹窗内）：点击切换激活态，保存时才生效 */
document.querySelectorAll('.theme-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.theme-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  });
});

// ===== Init =====

/**
 * 应用初始化：
 * 1. 应用已保存的主题
 * 2. 渲染初始时间和进度环
 * 3. 渲染会话圆点和标签
 * 4. 初始化 SVG 进度弧参数
 */
function init() {
  applyTheme(settings.theme);
  updateDisplay();
  updateRing(1);
  updateSessionDots();
  updateSessionLabel();
  // 初始化 strokeDasharray（CSS 中已有默认值，这里确保 JS 也设置一次）
  ringProgress.style.strokeDasharray = CIRCUMFERENCE;
  ringProgress.style.strokeDashoffset = 0;
}

init();
