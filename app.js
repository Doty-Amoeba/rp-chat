/* RP Chat — однофайловый ролевой чат на RouterAI
   Хранит всё в localStorage. Ключ никуда не уходит, кроме самого RouterAI. */

'use strict';

/* ============================ ПРОМТЫ ============================ */

const PROMPT_EN = `Ты — {{char}}. Ты живёшь внутри истории вместе с {{user}} и никогда не выходишь из образа: не объясняешь правила, не комментируешь формат, не пишешь от своего лица.

ОБРАЗЕЦ ОТВЕТА (ровно такой формы, не копируй слова):

**Утренний свет**
*Она откладывает тряпку и вытирает руки о передник.* «Ты рано.» *Пауза.* «Я не ждала тебя так скоро.»

*Уши дёргаются, она отводит взгляд в сторону.*

КАК ПИСАТЬ:
1. Действия и жесты — в *звёздочках*. Каждое физическое действие в звёздочках.
2. Слова вслух — в «ёлочках». Каждая произнесённая фраза в кавычках.
3. Мысли — в _подчёркиваниях_, и только изредка.
4. Одна короткая жирная строка **вот так** в начале — заголовок сцены, не больше пяти слов.
5. Один-три абзаца. Показывай чувства через тело и паузы, а не словами «она грустила».
6. Ты пишешь только за {{char}}. {{user}} двигается и говорит сам.

ЯЗЫК: только русский, только кириллица. Любое русское слово латиницей — ошибка. Никаких английских, тайских, корейских, арабских слов и символов.

Продолжай сцену с того места, где она остановилась. Не пересказывай предыдущие сообщения и не повторяй свои реплики.`;

const PROMPT_RU = `Ты — {{char}}, персонаж истории. {{user}} — твой собеседник. Не выходи из роли.

Образец формы:
**Заголовок сцены**
*Действие.* «Реплика.» *Ещё действие.*

Правила:
1. Действия — в *звёздочках*.
2. Речь — в «ёлочках».
3. Мысли — в _подчёркиваниях_, редко.
4. Заголовок — одна короткая жирная строка, до пяти слов.
5. Один-три абзаца. Чувства показывай через действия.
6. Пиши только за {{char}}, не за {{user}}.

Язык: только русский, только кириллица. Латинские буквы в русских словах — грубая ошибка.

Продолжай сцену, не пересказывай её заново.`;

/* ============================ ХРАНИЛИЩЕ ============================ */

const LS = { chars: 'rp.chars', chats: 'rp.chats', settings: 'rp.settings', seen: 'rp.seenPrompt' };

const DEFAULT_SETTINGS = {
  apiBase: '',                 // '' -> авто (прокси при http, напрямую при file:)
  key: '',
  model: 'xiaomi/mimo-v2.6-pro',
  userName: 'Ты',
  temperature: '0.85',
  min_p: '0',
  top_p: '0.95',
  repetition_penalty: '1',
  presence_penalty: '0',
  frequency_penalty: '0',
  max_tokens: '700',
  provider: '',
  basicOnly: true,
  reasoning: 'off',
  prompt: PROMPT_EN,
  version: 8
};

const load = (k, fb) => {
  try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fb; } catch { return fb; }
};
const save = (k, v) => {
  try { localStorage.setItem(k, JSON.stringify(v)); }
  catch { alert('Не смогла сохранить: браузерное хранилище переполнено (скорее всего, большие аватарки).'); }
};

let chars = load(LS.chars, []);
let chats = load(LS.chats, {});
let settings = Object.assign({}, DEFAULT_SETTINGS, load(LS.settings, {}));

// миграция v7 -> v8: переводим на MiMo-V2.6-Pro.
// Остальные настройки НЕ трогаем — их пользователь мог подогнать под себя.
if (settings.version !== 8) {
  settings.model = 'xiaomi/mimo-v2.6-pro';
  // это reasoning-модель: для ролеплея размышления только мешают
  settings.reasoning = 'off';
  // провайдера не фиксируем — пусть RouterAI сам выберет, где модель доступна
  settings.provider = '';
  settings.version = 8;
  save(LS.settings, settings);
}

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

/* ============================ DOM ============================ */

const $ = id => document.getElementById(id);
const topTitle = $('topTitle'), topSub = $('topSub'), btnBack = $('btnBack');
const viewGallery = $('viewGallery'), viewEditor = $('viewEditor'), viewChat = $('viewChat');
const gallery = $('gallery'), messages = $('messages'), input = $('input'), btnSend = $('btnSend');
const veil = $('veil'), settingsPanel = $('settingsPanel');

let currentChar = null;   // объект персонажа
let editing = null;       // id редактируемого персонажа (null = новый)
let avatarData = '';      // dataURL в редакторе
let abortCtrl = null;     // для остановки генерации
let selectMode = false;   // режим выбора сообщений
const picked = new Set(); // индексы выбранных сообщений

/* ============================ РАЗМЕТКА ============================ */

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Вырезает мусор от сбоев модели: чужие алфавиты и латиницу, приклеенную к русскому. */
function sanitizeText(raw) {
  if (!raw) return '';
  let t = raw;

  // 1. Чужие письменности: CJK, хангыль, кана, тайский, арабский, иврит, деванагари, армянский, грузинский
  t = t.replace(/[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\u0E00-\u0E7F\u0600-\u06FF\u0590-\u05FF\u0900-\u097F\u0530-\u058F\u10A0-\u10FF\uF900-\uFAFF\uFF00-\uFFEF]/g, '');

  // 2. Латиница, приклеенная прямо к кириллице: «отсосуSuperview» -> «отсосу»
  t = t.replace(/([а-яёА-ЯЁ])[A-Za-z]+/g, '$1');
  t = t.replace(/[A-Za-z]+([а-яёА-ЯЁ])/g, '$1');

  // 2a. Склейки с подчёркиванием: «вы_qual», «봉_minus», «сло_во» -> оставляем русскую часть
  t = t.replace(/([а-яёА-ЯЁ]+)_+[A-Za-z0-9]+/g, '$1');
  t = t.replace(/[A-Za-z0-9]+_+([а-яёА-ЯЁ]+)/g, '$1');
  t = t.replace(/_+/g, ' ');

  // 2b. Турецкие и прочие «почти-кириллические» буквы, которых в русском нет
  t = t.replace(/[ıİğĞşŞçÇöÖüÜäÄßæÆøØåÅđĐħĦłŁŧŦ]/g, '');

  // 2c. Латинские слова-обрывки, прилипшие внутри русского слова уже после чистки
  t = t.replace(/([а-яёА-ЯЁ]{2,})[A-Za-z]{1,}/g, '$1');

  // 3. Служебные обрывки вида "assistant", "user", "<|end|>", "Superview"
  t = t.replace(/<\/?[a-zA-Z|_]+>/g, '');
  t = t.replace(/\b(assistant|system|user|Superview|User|Assistant)\b/g, '');

  // 5. Выбрасываем «салат» из случайных латинских слов:
  //    если в строке латиницы больше, чем кириллицы, — это сбой, не текст.
  t = t.split('\n').map(line => {
    const latin = (line.match(/[A-Za-z]/g) || []).length;
    const cyr = (line.match(/[а-яёА-ЯЁ]/g) || []).length;
    if (latin > 3 && latin > cyr) return '';
    return line;
  }).join('\n');

  // 6. Если текст в основном русский — выкидываем латинские слова-обрывки
  //    длиной от 4 букв (именно они дают «slrboloff-naither» и «Shelitch»).
  const allCyr = (t.match(/[а-яёА-ЯЁ]/g) || []).length;
  const allLat = (t.match(/[A-Za-z]/g) || []).length;
  if (allCyr > allLat * 2) {
    t = t.replace(/\b[A-Za-z][A-Za-z'’-]{3,}\b/g, '');
  }

  // 7. Схлопываем пробелы и пустые строки
  t = t.replace(/[ \t]{2,}/g, ' ');
  t = t.replace(/\n{3,}/g, '\n\n');
  t = t.replace(/ +\n/g, '\n');
  t = t.replace(/  +/g, ' ');

  return t.trim();
}

/** Превращает текст модели в безопасный HTML с подсветкой. */
function renderText(raw) {
  let t = esc(sanitizeText(raw || ''));

  // #заголовки модели -> жирный
  t = t.replace(/^#{1,6}\s*(.+)$/gm, '**$1**');
  // **жирный** -> заголовок сцены
  t = t.replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>');
  // *действие*
  t = t.replace(/\*([^*\n]+?)\*/g, '<em>$1</em>');
  // _мысли_ (только отдельным словом, чтобы не ломать snake_case)
  t = t.replace(/(^|[\s(])_([^_\n]+?)_(?=[\s.,!?;:)]|$)/g, '$1<span class=\'thought\'>$2</span>');
  // речь — «ёлочки»
  t = t.replace(/«([^»]+?)»/g, '<span class=\'speech\'>«$1»</span>');
  // речь — обычные двойные кавычки
  t = t.replace(/"([^"\n]{1,900}?)"/g, '<span class=\'speech\'>"$1"</span>');
  // речь без кавычек в начале строки — тоже подсветим
  t = t.replace(/(^|\n)—\s*([^\n]+)/g, '$1<span class=\'speech\'>— $2</span>');

  return t;
}

/* ============================ НАВИГАЦИЯ ============================ */

function show(view) {
  [viewGallery, viewEditor, viewChat].forEach(v => v.classList.add('hidden'));
  view.classList.remove('hidden');
  btnBack.classList.toggle('hidden', view === viewGallery);
  const inChat = view === viewChat;
  $('btnSettings').classList.toggle('hidden', false);
  // кнопки управления чатом видны только в чате
  $('btnSelect').classList.toggle('hidden', !inChat || selectMode);
  $('btnRedo').classList.toggle('hidden', !inChat || selectMode);
  $('btnRestart').classList.toggle('hidden', !inChat || selectMode);
}

function apiBase() {
  if (settings.apiBase) return settings.apiBase.replace(/\/+$/, '');
  // RouterAI отдаёт Access-Control-Allow-Origin: * — можно ходить напрямую
  // из браузера откуда угодно: с локального файла, с localhost и с хостинга.
  return 'https://routerai.ru/api/v1';
}

/* ============================ ГАЛЕРЕЯ ============================ */

function renderGallery() {
  gallery.innerHTML = '';
  const add = document.createElement('button');
  add.className = 'addcard';
  add.innerHTML = '<b>+</b><span>Новый персонаж</span>';
  add.onclick = () => openEditor(null);
  gallery.appendChild(add);

  if (!chars.length) {
    const e = document.createElement('div');
    e.className = 'empty';
    e.style.gridColumn = '1 / -1';
    e.textContent = 'Пока пусто. Начни с кнопки «Новый персонаж» — и через минуту будет с кем поговорить.';
    gallery.appendChild(e);
  }

  chars.forEach(ch => {
    const card = document.createElement('div');
    card.className = 'card';
    card.tabIndex = 0;

    const ava = ch.avatar
      ? `<img class="ava" src="${ch.avatar}" alt="">`
      : `<div class="ava ph">${esc((ch.name || '?').trim().charAt(0).toUpperCase())}</div>`;

    card.innerHTML = `${ava}
      <div class="nm">${esc(ch.name)}</div>
      <div class="tg">${esc(ch.tag || (ch.desc || '').slice(0, 60) || 'без описания')}</div>`;

    card.onclick = () => openChat(ch);
    card.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openChat(ch); } };
    // долгий клик / правый клик — редактирование
    card.oncontextmenu = e => { e.preventDefault(); openEditor(ch.id); };

    const editBtn = document.createElement('button');
    editBtn.className = 'icon';
    editBtn.style.cssText = 'position:absolute;top:8px;right:8px;width:26px;height:26px;font-size:12px;opacity:.6';
    editBtn.textContent = '✎';
    editBtn.title = 'Редактировать';
    editBtn.onclick = e => { e.stopPropagation(); openEditor(ch.id); };
    card.appendChild(editBtn);

    gallery.appendChild(card);
  });
}

/* ============================ РЕДАКТОР ============================ */

function openEditor(id) {
  editing = id || null;
  const ch = id ? chars.find(c => c.id === id) : null;

  topTitle.textContent = ch ? 'Персонаж' : 'Новый персонаж';
  topSub.textContent = ch ? ch.name : '';

  $('fName').value = ch ? ch.name : '';
  $('fTag').value = ch ? (ch.tag || '') : '';
  $('fDesc').value = ch ? (ch.desc || '') : '';
  $('fScenario').value = ch ? (ch.scenario || '') : '';
  $('fFirst').value = ch ? (ch.first || '') : '';
  $('fExample').value = ch ? (ch.example || '') : '';

  avatarData = ch ? (ch.avatar || '') : '';
  paintAvatar();

  $('btnDelete').classList.toggle('hidden', !ch);
  show(viewEditor);
  $('fName').focus();
}

function paintAvatar() {
  const img = $('avaImg'), plus = $('avaPlus');
  if (avatarData) { img.src = avatarData; img.classList.remove('hidden'); plus.classList.add('hidden'); }
  else { img.classList.add('hidden'); plus.classList.remove('hidden'); }
}

// клик по аватарке -> выбор файла
$('avaBox').onclick = () => {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = 'image/*';
  inp.onchange = () => {
    const f = inp.files && inp.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => shrink(r.result, 320, d => { avatarData = d; paintAvatar(); });
    r.readAsDataURL(f);
  };
  inp.click();
};

/** Ужимает картинку, чтобы не забивать localStorage. */
function shrink(dataUrl, size, cb) {
  const img = new Image();
  img.onload = () => {
    const s = Math.min(size / img.width, size / img.height, 1);
    const cv = document.createElement('canvas');
    cv.width = Math.round(img.width * s);
    cv.height = Math.round(img.height * s);
    cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
    cb(cv.toDataURL('image/webp', 0.85));
  };
  img.onerror = () => cb(dataUrl);
  img.src = dataUrl;
}

$('btnSave').onclick = () => {
  const name = $('fName').value.trim();
  if (!name) { $('fName').focus(); $('fName').style.borderColor = '#f0859f'; return; }

  const data = {
    name,
    tag: $('fTag').value.trim(),
    desc: $('fDesc').value.trim(),
    scenario: $('fScenario').value.trim(),
    first: $('fFirst').value.trim(),
    example: $('fExample').value.trim(),
    avatar: avatarData
  };

  if (editing) {
    const i = chars.findIndex(c => c.id === editing);
    chars[i] = Object.assign(chars[i], data);
  } else {
    chars.unshift(Object.assign({ id: uid() }, data));
  }

  save(LS.chars, chars);
  renderGallery();
  show(viewGallery);
  topTitle.textContent = 'Персонажи';
  topSub.textContent = chars.length + ' шт.';
};

$('btnCancel').onclick = () => { show(viewGallery); topTitle.textContent = 'Персонажи'; topSub.textContent = ''; };

$('btnDelete').onclick = () => {
  if (!editing) return;
  const ch = chars.find(c => c.id === editing);
  if (!confirm(`Удалить «${ch.name}» вместе с историей переписки?`)) return;
  chars = chars.filter(c => c.id !== editing);
  delete chats[editing];
  save(LS.chars, chars); save(LS.chats, chats);
  renderGallery(); show(viewGallery);
  topTitle.textContent = 'Персонажи'; topSub.textContent = '';
};

btnBack.onclick = () => {
  if (!viewChat.classList.contains('hidden')) {
    stopGeneration();
    currentChar = null;
    show(viewGallery);
    topTitle.textContent = 'Персонажи';
    topSub.textContent = chars.length + ' шт.';
  } else {
    show(viewGallery);
    topTitle.textContent = 'Персонажи';
    topSub.textContent = '';
  }
};

/* ============================ ЧАТ ============================ */

function openChat(ch) {
  currentChar = ch;
  if (!chats[ch.id] || !chats[ch.id].length) {
    chats[ch.id] = [];
    if (ch.first) chats[ch.id].push({ role: 'assistant', content: ch.first });
    save(LS.chats, chats);
  }
  topTitle.textContent = ch.name;
  topSub.textContent = ch.tag || '';
  setSelectMode(false);
  paintChat();
  show(viewChat);
  input.focus();
}

/* ---- режим выбора сообщений ---- */

function setSelectMode(on) {
  selectMode = on;
  picked.clear();
  $('selBar').classList.toggle('hidden', !on);
  $('btnSend').classList.toggle('hidden', on);
  $('composer').classList.toggle('hidden', on);
  // видимость кнопок шапки — в одном месте, без рассинхрона
  show(viewChat);
  paintChat();
}

function updateSelBar() {
  $('selCount').textContent = 'Выбрано: ' + picked.size;
  $('btnSelDel').disabled = picked.size === 0;
}

function paintChat() {
  messages.innerHTML = '';
  const list = (currentChar && chats[currentChar.id]) || [];
  if (!list.length) {
    const e = document.createElement('div');
    e.className = 'empty';
    e.textContent = 'Напиши первое сообщение — история начнётся.';
    messages.appendChild(e);
    return;
  }
  list.forEach((m, i) => messages.appendChild(bubble(m.role, m.content, false, i)));
  if (selectMode) updateSelBar();
  scrollDown();
}

function bubble(role, content, isError, index) {
  const wrap = document.createElement('div');
  wrap.className = 'msg ' + (isError ? 'error' : role);

  // чекбокс в режиме выбора
  if (selectMode && typeof index === 'number') {
    wrap.classList.add('selectable');
    if (picked.has(index)) wrap.classList.add('picked');

    const chk = document.createElement('div');
    chk.className = 'chk';
    chk.textContent = '✓';
    wrap.appendChild(chk);

    wrap.onclick = e => {
      e.preventDefault();
      if (picked.has(index)) picked.delete(index);
      else picked.add(index);
      wrap.classList.toggle('picked', picked.has(index));
      updateSelBar();
    };
  }

  const mini = document.createElement('div');
  mini.className = 'mini';
  if (role === 'assistant' && currentChar && currentChar.avatar) {
    const im = document.createElement('img');
    im.src = currentChar.avatar;
    mini.appendChild(im);
  } else {
    mini.textContent = role === 'user' ? '🙂' : (currentChar ? currentChar.name.charAt(0).toUpperCase() : '?');
  }

  const b = document.createElement('div');
  b.className = 'bubble';

  const who = document.createElement('div');
  who.className = 'who';
  who.textContent = role === 'user' ? (settings.userName || 'Ты') : (currentChar ? currentChar.name : 'Персонаж');

  const body = document.createElement('div');
  body.className = 'body';
  if (isError) body.textContent = content;
  else body.innerHTML = renderText(content);

  b.append(who, body);

  // ---- кнопки под ответом ИИ ----
  // только у готовых ответов персонажа: не у ошибок, не во время стриминга
  if (role === 'assistant' && !isError && typeof index === 'number' && !selectMode) {
    const acts = document.createElement('div');
    acts.className = 'msgacts';

    const redo = document.createElement('button');
    redo.innerHTML = '⟳ Заново';
    redo.title = 'Сгенерировать этот ответ заново';
    redo.onclick = e => { e.stopPropagation(); regenerateAt(index); };

    const cont = document.createElement('button');
    cont.innerHTML = '→ Продолжить';
    cont.title = 'Продолжить историю с этого места — ввод останется пустым';
    cont.onclick = e => { e.stopPropagation(); continueFrom(index); };

    acts.append(redo, cont);
    // внутрь .body — именно на нём рамка, иначе кнопки висят снаружи неё
    body.appendChild(acts);
  }

  wrap.append(mini, b);
  return wrap;
}

/* ---- перегенерировать конкретный ответ ---- */
async function regenerateAt(i) {
  if (!currentChar || abortCtrl) return;
  const list = chats[currentChar.id];
  if (!list || i < 0 || i >= list.length) return;

  // если после этого ответа была ещё переписка — предупредим, что она уйдёт
  if (i < list.length - 1) {
    if (!confirm('Этот ответ будет сгенерирован заново.\nВсё, что было после него, удалится. Продолжить?')) return;
  }

  list.splice(i);           // убираем сам ответ и всё после него
  save(LS.chats, chats);
  paintChat();

  // если осталась реплика пользователя — отвечаем на неё заново
  const last = list[list.length - 1];
  if (!last || last.role === 'user') await generate();
}

/* ---- продолжить историю с этого места ---- */
async function continueFrom(i) {
  if (!currentChar || abortCtrl) return;
  const list = chats[currentChar.id];
  if (!list || i < 0 || i >= list.length) return;

  if (i < list.length - 1) {
    if (!confirm('Продолжить с этого места?\nВсё, что было после него, удалится.')) return;
  }

  list.splice(i + 1);       // оставляем только этот ответ и всё до него
  save(LS.chats, chats);
  paintChat();

  // продолжение остаётся ОТДЕЛЬНЫМ сообщением — чтобы его можно было
  // удалить, не трогая предыдущий ответ
  await generate({ nudge: 'Продолжи свой предыдущий ответ с того места, где он оборвался. Не начинай заново, не повторяй уже написанное — просто допиши дальше.' });
}

const scrollDown = () => { messages.scrollTop = messages.scrollHeight; };

/* ---- кнопки режима выбора ---- */
$('btnSelect').onclick = () => setSelectMode(true);
$('btnSelCancel').onclick = () => setSelectMode(false);
$('btnSelAll').onclick = () => {
  const list = (currentChar && chats[currentChar.id]) || [];
  if (picked.size === list.length) { picked.clear(); }
  else { list.forEach((_, i) => picked.add(i)); }
  paintChat();
};
$('btnSelDel').onclick = () => {
  if (!currentChar || !picked.size) return;
  const list = chats[currentChar.id];
  const killed = picked.size;
  // удаляем с конца, чтобы индексы не съезжали
  [...picked].sort((a, b) => b - a).forEach(i => list.splice(i, 1));
  save(LS.chats, chats);
  setSelectMode(false);
  console.log('удалено сообщений: ' + killed);
};

/* ---- начать чат заново ---- */
$('btnRestart').onclick = () => {  if (!currentChar) return;
  if (!confirm(`Начать чат с «${currentChar.name}» заново?\n\nВся история разговора удалится, персонаж останется.`)) return;
  chats[currentChar.id] = [];
  if (currentChar.first) chats[currentChar.id].push({ role: 'assistant', content: currentChar.first });
  save(LS.chats, chats);
  setSelectMode(false);
  paintChat();
};

/* ---- перегенерировать последний ответ ---- */
$('btnRedo').onclick = async () => {
  if (!currentChar || abortCtrl) return;
  const list = chats[currentChar.id];
  if (!list || !list.length) return;

  // убираем последний ответ персонажа (или сообщение об ошибке)
  const last = list[list.length - 1];
  if (last && last.role === 'assistant') list.splice(list.length - 1, 1);
  if (!list.length) return;

  // если последним стоит реплика пользователя — генерируем ответ заново
  save(LS.chats, chats);
  paintChat();
  if (list[list.length - 1].role === 'user') await generate();
};

/* автоувеличение поля ввода */
input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 160) + 'px';
});

input.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});

btnSend.onclick = () => { abortCtrl ? stopGeneration() : sendMessage(); };

/* ============================ СБОРКА ЗАПРОСА ============================ */

function fill(str) {
  return (str || '')
    .replace(/\{\{char\}\}/gi, currentChar ? currentChar.name : 'Персонаж')
    .replace(/\{\{user\}\}/gi, settings.userName || 'Ты');
}

function buildMessages(nudge) {
  const out = [];
  out.push({ role: 'system', content: fill(settings.prompt) });

  const card = [];
  card.push(`Имя персонажа: ${currentChar.name}`);
  if (currentChar.tag) card.push(`В двух словах: ${currentChar.tag}`);
  // ВАЖНО: fill() — в описании бывает {{user}} и {{char}}, их надо подставить
  if (currentChar.desc) card.push(`Описание и предыстория:\n${fill(currentChar.desc)}`);
  if (currentChar.scenario) card.push(`Место действия и завязка:\n${fill(currentChar.scenario)}`);
  out.push({ role: 'system', content: card.join('\n\n') });

  // ПРИМЕР РЕЧИ — как НАСТОЯЩИЕ сообщения диалога, без служебных обёрток.
  // Раньше здесь было «Так говорит X. Копируй именно этот голос» — и модель
  // послушно копировала саму эту фразу вместо того, чтобы ей следовать.
  const demo = parseExample(currentChar.example);
  demo.forEach(m => out.push(m));

  // ФОРМАТ УЧИМ ПРИМЕРОМ — но только если у персонажа нет своего первого сообщения
  // и нет своего примера речи. Иначе получается два ассистентских ответа подряд.
  if (!currentChar.first && !demo.length) {
    out.push({ role: 'user', content: 'привет' });
    out.push({
      role: 'assistant',
      content: '**Первая встреча**\n*Она поднимает взгляд и смотрит прямо.*\n\n«Привет.» *короткая пауза* «Ты вовремя.»'
    });
  }

  // DeepSeek знает русский сам, но напоминание о формате не помешает
  out.push({
    role: 'system',
    content: 'Продолжай историю в том же формате: действия в *звёздочках*, речь в «ёлочках». Только русский язык, только кириллица. Не пересказывай этот текст и не цитируй его — просто продолжай сцену.'
  });

  (chats[currentChar.id] || []).forEach(m => out.push({ role: m.role, content: m.content }));

  // сначала обрезаем историю, потом добавляем подсказку —
  // иначе trimContext может выкинуть её как «старое» сообщение
  const trimmed = trimContext(out);

  // «Продолжить»: просим дописать с места обрыва, не повторяя написанное.
  // Ввод пользователя при этом остаётся пустым — реплику даём прямо здесь.
  if (nudge) trimmed.push({ role: 'user', content: nudge });

  return trimmed;
}

/**
 * Обрезает историю, оставляя начало (промт + карточка + примеры) и последние
 * сообщения. Без этого длинный чат расплывается: модель теряет нить, начинает
 * повторяться и срывается в мусор на токенах.
 */
function trimContext(msgs) {
  const LIMIT = 24;          // сколько последних реплик оставлять
  const HEAD = msgs.findIndex(m => m.role === 'user' || m.role === 'assistant');
  if (HEAD === -1) return msgs;

  const head = msgs.slice(0, HEAD);       // системные: промт, карточка, примеры
  const body = msgs.slice(HEAD);          // живой диалог

  if (body.length <= LIMIT) return msgs;

  // режем с начала, но следим, чтобы диалог начинался с реплики пользователя
  let cut = body.length - LIMIT;
  while (cut < body.length && body[cut].role !== 'user') cut++;

  const kept = body.slice(cut);
  return head.concat([{
    role: 'system',
    content: 'Выше — начало разговора, оно сокращено. Продолжай с последней реплики.'
  }], kept);
}

function num(v) { const n = parseFloat(String(v).replace(',', '.')); return Number.isFinite(n) ? n : null; }

/**
 * Разбирает «пример речи» на настоящие сообщения диалога.
 * Поддерживает строки вида:
 *   Ты: привет
 *   Лепора: «Привет!» *машет рукой*
 *   {{user}}: ...
 *   {{char}}: ...
 * Строки без префикса считаются речью персонажа.
 */
function parseExample(raw) {
  if (!raw || !raw.trim()) return [];

  const userName = settings.userName || 'Ты';
  const charName = currentChar ? currentChar.name : 'Персонаж';
  const msgs = [];
  let buffer = { role: 'assistant', lines: [] };

  const flush = () => {
    const text = buffer.lines.join('\n').trim();
    if (text) msgs.push({ role: buffer.role, content: fill(text) });
    buffer = { role: 'assistant', lines: [] };
  };

  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([^:：]{1,40})\s*[:：]\s*(.*)$/);
    if (m) {
      const who = m[1].trim().toLowerCase();
      const uLow = userName.toLowerCase();
      const cLow = charName.toLowerCase();

      const isUser = (who === uLow || who === 'user' || who === 'ты'
                      || who === '{{user}}' || who === 'пользователь');
      const isChar = (who === cLow || who === 'assistant' || who === '{{char}}'
                      || who === 'персонаж');

      if (isUser || isChar) {
        flush();
        buffer.role = isUser ? 'user' : 'assistant';
        if (m[2].trim()) buffer.lines.push(m[2].trim());
        continue;
      }
    }
    // строка без метки — продолжение текущей реплики (или речь персонажа)
    if (line.trim() === '') {
      if (buffer.lines.length) buffer.lines.push('');
    } else {
      buffer.lines.push(line.trim());
    }
  }
  flush();

  return msgs;
}
/* ============================ ОТПРАВКА ============================ */

async function sendMessage() {
  if (!currentChar) return;
  const text = input.value.trim();
  if (!text) return;

  if (!settings.key) { openSettings('Сначала вставь API-ключ RouterAI — без него нейронка не ответит.'); return; }
  if (selectMode) return;

  const list = chats[currentChar.id];
  list.push({ role: 'user', content: text });
  save(LS.chats, chats);

  input.value = '';
  input.style.height = 'auto';
  messages.querySelector('.empty')?.remove();
  messages.appendChild(bubble('user', text));
  scrollDown();

  await generate();
}

async function generate(opts) {
  if (!currentChar) return;

  const list = chats[currentChar.id];

  // защита от двойного запуска
  if (abortCtrl) return;

  const nudge = opts && opts.nudge;   // подсказка для «Продолжить»

  const holder = bubble('assistant', '…');
  messages.appendChild(holder);
  scrollDown();
  const bodyEl = holder.querySelector('.body');

  abortCtrl = new AbortController();
  btnSend.classList.add('stop');
  btnSend.textContent = '■';

  const payload = {
    model: settings.model,
    messages: buildMessages(nudge),
    stream: true
  };
  const t = num(settings.temperature); if (t !== null) payload.temperature = t;
  const tp = num(settings.top_p); if (tp !== null) payload.top_p = tp;
  const mx = num(settings.max_tokens); if (mx !== null) payload.max_tokens = mx;

  // Расширенные сэмплеры — ТОЛЬКО если их явно включили.
  // repetition_penalty на DeepSeek вызывает срыв в случайные токены,
  // min_p вместе с top_p двойное фильтрование — тоже во вред.
  if (!settings.basicOnly) {
    const mp = num(settings.min_p); if (mp !== null && mp > 0) payload.min_p = mp;
    const rp = num(settings.repetition_penalty); if (rp !== null && rp !== 1) payload.repetition_penalty = rp;
    const pp = num(settings.presence_penalty); if (pp !== null && pp !== 0) payload.presence_penalty = pp;
    const fp = num(settings.frequency_penalty); if (fp !== null && fp !== 0) payload.frequency_penalty = fp;
  }
  if (settings.provider) payload.provider = { only: [settings.provider] };

  // Стоп-последовательности: обрубаем попытку продолжить «за пользователя»
  payload.stop = ['\nuser:', '\nassistant:'];

  // DeepSeek V4 Flash — reasoning-модель. Для ролеплея размышления только вредят:
  // они съедают токены и ломают живой поток. По умолчанию просим не думать.
  if (settings.reasoning && settings.reasoning !== 'off') {
    payload.reasoning = { effort: settings.reasoning };
  }

  let full = '';

  try {
    const res = await fetch(apiBase() + '/chat/completions', {
      method: 'POST',
      signal: abortCtrl.signal,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + settings.key
      },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const errTxt = await res.text();
      throw new Error(`HTTP ${res.status} — ${errTxt.slice(0, 400)}`);
    }

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });

      const parts = buf.split('\n\n');
      buf = parts.pop();

      for (const part of parts) {
        const line = part.split('\n').find(l => l.startsWith('data:'));
        if (!line) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try {
          const json = JSON.parse(data);
          const choice = json.choices && json.choices[0];
          const d = choice && choice.delta;
          if (d && d.content) {
            full += d.content;
            bodyEl.innerHTML = renderText(full);
            scrollDown();
          } else if (d && d.reasoning && !full) {
            bodyEl.innerHTML = '<span style="opacity:.5;font-size:13px">думает…</span>';
          }
        } catch { /* кусок ещё не собрался — пропускаем */ }
      }
    }

    if (!full.trim()) full = '(модель вернула пустой ответ)';
    full = sanitizeText(full);
    list.push({ role: 'assistant', content: full });
    save(LS.chats, chats);
    // перерисовываем: только так у готового ответа появятся кнопки
    paintChat();
  } catch (err) {
    holder.remove();
    if (err.name === 'AbortError') {
      // ОСТАНОВКА: сохраняем то, что успело прийти, РОВНО ОДИН раз в историю
      const partial = sanitizeText(full);
      const body = partial.trim() ? partial + ' […]' : '';
      if (body) {
        list.push({ role: 'assistant', content: body });
        save(LS.chats, chats);
        paintChat();
      }
    } else {
      const hint = location.protocol === 'file:'
        ? '\n\nЕсли это ошибка сети/CORS — запусти server.py из этой папки и открой http://localhost:8765'
        : '';
      messages.appendChild(bubble('error', 'Не получилось: ' + err.message + hint, true));
    }
    scrollDown();
  } finally {
    abortCtrl = null;
    btnSend.classList.remove('stop');
    btnSend.textContent = '➤';
  }
}

function stopGeneration() {
  if (abortCtrl) abortCtrl.abort();
}

/* ============================ НАСТРОЙКИ ============================ */

function openSettings(warn) {
  $('sKey').value = settings.key;
  $('sModel').value = settings.model;
  $('sUser').value = settings.userName;
  $('sTemp').value = settings.temperature;
  $('sMinp').value = settings.min_p;
  $('sTopp').value = settings.top_p;
  $('sRep').value = settings.repetition_penalty;
  $('sPres').value = settings.presence_penalty;
  $('sMax').value = settings.max_tokens;
  $('sProvider').value = settings.provider || '';
  $('sBasic').checked = !!settings.basicOnly;
  $('sReasoning').value = settings.reasoning || 'off';
  $('sPreset').value = '';
  $('sPrompt').value = settings.prompt;
  settingsPanel.classList.add('open');
  veil.classList.add('on');
  if (warn) $('sKey').placeholder = warn;
  $('sKey').focus();
}

function closeSettings() {
  settingsPanel.classList.remove('open');
  veil.classList.remove('on');
}

$('btnSettings').onclick = () => openSettings();
$('btnCloseSettings').onclick = closeSettings;
veil.onclick = closeSettings;

$('btnSaveSettings').onclick = () => {
  settings.key = $('sKey').value.trim();
  settings.model = $('sModel').value.trim() || DEFAULT_SETTINGS.model;
  settings.userName = $('sUser').value.trim() || 'Ты';
  settings.temperature = $('sTemp').value;
  settings.min_p = $('sMinp').value;
  settings.top_p = $('sTopp').value;
  settings.repetition_penalty = $('sRep').value;
  settings.presence_penalty = $('sPres').value;
  settings.max_tokens = $('sMax').value;
  settings.provider = $('sProvider').value.trim();
  settings.basicOnly = $('sBasic').checked;
  settings.reasoning = $('sReasoning').value;
  settings.prompt = $('sPrompt').value;
  save(LS.settings, settings);
  closeSettings();
  if (currentChar) paintChat();
};

$('sPreset').onchange = () => {
  if ($('sPreset').value) $('sModel').value = $('sPreset').value;
};

$('btnPromptEn').onclick = () => { $('sPrompt').value = PROMPT_EN; };
$('btnPromptRu').onclick = () => { $('sPrompt').value = PROMPT_RU; };
$('btnPromptReset').onclick = () => { $('sPrompt').value = PROMPT_EN; };

/* ============================ СЕССИЯ ============================ */
/* Один файл со всем: персонажи, вся переписка, настройки и то,
   где пользователь остановился. Загрузил — и продолжаешь. */

function buildSession(includeKey) {
  const st = Object.assign({}, settings);
  if (!includeKey) delete st.key;

  return {
    app: 'rp-chat',
    v: 2,
    at: new Date().toISOString(),
    chars: chars,
    chats: chats,
    settings: st,
    // где остановился — чтобы открыть сразу тот же чат
    current: currentChar ? currentChar.id : null
  };
}

function saveSession() {
  try {
    const includeKey = $('sExportKey') ? $('sExportKey').checked : false;
    const data = buildSession(includeKey);

    const size = JSON.stringify(data).length;
    const charsN = data.chars.length;
    const msgsN = Object.values(data.chats || {}).reduce((a, l) => a + (l ? l.length : 0), 0);

    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const d = new Date();
    const stamp = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' +
                  String(d.getDate()).padStart(2, '0') + '_' + String(d.getHours()).padStart(2, '0') + '-' +
                  String(d.getMinutes()).padStart(2, '0');

    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'rp-chat-' + stamp + '.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);

    // короткая вспышка на иконке, чтобы было видно: сохранилось
    const b = $('btnSaveSession');
    if (b) {
      b.classList.add('saving');
      b.textContent = '✓';
      setTimeout(() => { b.classList.remove('saving'); b.textContent = '💾'; }, 1100);
    }

    return { charsN, msgsN, size, includeKey };
  } catch (e) {
    alert('Не смог собрать файл: ' + e.message);
    return null;
  }
}

function loadSession(file) {
  const r = new FileReader();
  r.onload = () => {
    let d;
    try { d = JSON.parse(r.result); }
    catch { alert('Не смог прочитать файл — он повреждён или это не JSON.'); return; }

    if (!d || !Array.isArray(d.chars)) { alert('Это не файл сессии RP Chat.'); return; }

    const nChars = d.chars.length;
    const nChats = Object.keys(d.chats || {}).length;
    const nMsgs = Object.values(d.chats || {}).reduce((a, l) => a + (l ? l.length : 0), 0);
    const hasKey = !!(d.settings && d.settings.key);

    const txt =
      'В файле:\n' +
      '• персонажей: ' + nChars + '\n' +
      '• чатов: ' + nChats + ' (' + nMsgs + ' сообщений)\n' +
      '• API-ключ: ' + (hasKey ? 'есть' : 'нет') + '\n\n' +
      'ВНИМАНИЕ: то, что сейчас на этом устройстве, будет заменено.\nПродолжить?';

    if (!confirm(txt)) return;

    // страхуемся: перед заменой сохраним текущее состояние в отдельный ключ
    try {
      save('rp.backup', {
        at: new Date().toISOString(),
        chars: load(LS.chars, []),
        chats: load(LS.chats, {}),
        settings: load(LS.settings, {})
      });
    } catch (e) { /* место кончилось — не критично */ }

    save(LS.chars, d.chars);
    save(LS.chats, d.chats || {});

    if (d.settings) {
      const merged = Object.assign({}, DEFAULT_SETTINGS, d.settings);
      // если в файле ключа не было — не затираем свой
      if (!merged.key && settings.key) merged.key = settings.key;
      save(LS.settings, merged);
    }

    // вернёмся туда, где остановились
    if (d.current) save('rp.current', d.current);

    alert('Сессия загружена! Сейчас перезагружу страницу.');
    location.reload();
  };
  r.readAsText(file);
}

$('btnSaveSession').onclick = () => {
  const r = saveSession();
  if (r) {
    topSub.textContent = 'сохранено ✓';
    setTimeout(() => { topSub.textContent = chars.length ? chars.length + ' шт.' : ''; }, 2200);
  }
};

$('btnExport').onclick = () => {
  const r = saveSession();
  if (r) alert('Готово!\n\nПерсонажей: ' + r.charsN + '\nСообщений: ' + r.msgsN +
               '\nКлюч в файле: ' + (r.includeKey ? 'да' : 'нет') +
               '\n\nФайл лежит в папке «Загрузки».');
};

$('btnImport').onclick = () => $('fileImport').click();
$('fileImport').onchange = e => {
  const f = e.target.files && e.target.files[0];
  if (f) loadSession(f);
  e.target.value = '';
};

$('btnClearChat').onclick = () => {
  if (!currentChar) return;
  if (!confirm('Очистить всю переписку с ' + currentChar.name + '?')) return;
  chats[currentChar.id] = [];
  if (currentChar.first) chats[currentChar.id].push({ role: 'assistant', content: currentChar.first });
  save(LS.chats, chats);
  paintChat();
  closeSettings();
};

/* ============================ СТАРТ ============================ */

renderGallery();
topSub.textContent = chars.length ? chars.length + ' шт.' : '';

// вернуться в тот чат, где остановился (после загрузки сессии)
const resumeId = load('rp.current', null);
if (resumeId) {
  const rc = chars.find(c => c.id === resumeId);
  if (rc) {
    openChat(rc);
  }
  // отметка одноразовая: дальше открывается галерея
  localStorage.removeItem('rp.current');
}

// подсказка про ключ при первом запуске
if (!settings.key && !load(LS.seen, false)) {
  save(LS.seen, true);
  setTimeout(() => openSettings(), 400);
}

// Esc закрывает панель
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    closeSettings();
    if (selectMode) setSelectMode(false);
  }
});
