// 左側素材庫：媒體、文字、貼圖、素材、濾鏡、轉場
import { store, on, emit, checkpoint, selected } from './state.js';
import { FILTER_PRESETS, TEXT_PRESETS, STICKERS, SHAPE_PRESETS, TRANSITIONS, filterString } from './effects.js';
import { $, h, fmtTime, toast, openModal } from './ui.js';
import { BUILTIN_TEMPLATES, getTemplate, slotsOf, textsOf, applyTemplate, saveTemplate, deleteTemplate, exportTemplateFile, importTemplateFile } from './templates.js';
import { importFiles } from './media.js';
import { detectDevice } from './device.js';
import { LANGS } from './translate.js';
import { VOICES, ttsPrefs } from './tts.js';
import { ASR_LANGS, rankModels, transcribe, translateCaptions, translationClips, translationFor, addCaptions, captionClips, applyStyleToAll, toSRT, parseSRT } from './captions.js';
import { removeMedia } from './media.js';

const TABS = [
  ['media', '📁', '媒體'],
  ['caption', 'CC', '字幕'],
  ['text', 'T', '文字'],
  ['template', '🧩', '範本'],
  ['sticker', '😀', '貼圖'],
  ['element', '◼', '素材'],
  ['filter', '🎨', '濾鏡'],
  ['transition', '✨', '轉場'],
];

export function initLibrary(api) {
  const tabsEl = $('libTabs');
  const body = $('libBody');
  let tab = 'media';

  function renderTabs() {
    tabsEl.innerHTML = '';
    for (const [id, icon, label] of TABS) {
      tabsEl.append(h('button', { class: `lib-tab${id === tab ? ' on' : ''}`, onclick: () => { tab = id; renderTabs(); render(); } },
        h('span', { class: 'i' }, icon), h('span', {}, label)));
    }
  }

  const dragData = (type, payload) => (e) => {
    e.dataTransfer.setData(type, payload);
    e.dataTransfer.effectAllowed = 'copy';
  };

  function render() {
    body.innerHTML = '';
    ({ media, caption, template, text, sticker, element, filter, transition })[tab]();
  }

  // ---------- 字幕 ----------
  let savedModel = null;
  try { savedModel = localStorage.getItem('ezicut.asrModel'); } catch {}
  const trOpts = { src: 'zh-Hant', tgt: 'en', mode: 'bilingual', busy: false, status: '', progress: 0 };
  const asr = { source: '', model: savedModel, userPicked: !!savedModel, lang: 'chinese', traditional: true, busy: false, status: '', progress: 0 };
  let statusEl = null;
  let barEl = null;
  const setStatus = ({ text, progress }) => {
    asr.status = text;
    asr.progress = progress ?? 0;
    if (statusEl) statusEl.textContent = text;
    if (barEl) barEl.style.width = `${(asr.progress * 100).toFixed(1)}%`;
  };

  function caption() {
    const sources = store.project.clips
      .filter((c) => (c.type === 'video' || c.type === 'audio') && store.media.get(c.mediaId)?.hasAudio !== false)
      .sort((a, b) => a.start - b.start);
    const sel = selected();
    if (sel && sources.includes(sel)) asr.source = sel.id;
    if (!sources.some((c) => c.id === asr.source)) asr.source = sources[0]?.id || '';
    const srcSel = h('select', { disabled: asr.busy },
      sources.length ? sources.map((c) => h('option', { value: c.id }, `${fmtTime(c.start).slice(0, 5)}  ${store.media.get(c.mediaId)?.name || ''}`))
        : h('option', { value: '' }, '時間軸上沒有含聲音的片段'));
    srcSel.value = asr.source;
    srcSel.onchange = () => (asr.source = srcSel.value);
    const langSel = h('select', { disabled: asr.busy }, ASR_LANGS.map(([v, l]) => h('option', { value: v }, l)));
    langSel.value = asr.lang;
    langSel.onchange = () => {
      asr.lang = langSel.value;
      if (!asr.userPicked) asr.model = null; // 沒手動選過就依新語言重新推薦
      fillModels();
    };
    const deviceLine = h('div', { class: 'device-line' }, '偵測裝置中…');
    const modelBox = h('div', { class: 'model-list' });
    const fillModels = async () => {
      const dev = await detectDevice();
      const list = await rankModels(dev, asr.lang);
      deviceLine.innerHTML = '';
      deviceLine.append(h('b', {}, `${dev.tierName}`), `　${dev.summary}`);
      if (!list.some((m) => m.id === asr.model)) asr.model = list[0].id;
      modelBox.innerHTML = '';
      for (const m of list) {
        const input = h('input', { type: 'radio', name: 'asr-model', checked: m.id === asr.model, disabled: asr.busy || m.unsupported });
        input.onchange = () => {
          asr.model = m.id;
          asr.userPicked = true;
          try { localStorage.setItem('ezicut.asrModel', m.id); } catch {}
        };
        const badgeCls = m.badge.startsWith('★') ? 'rec' : m.badge === '不建議' || m.unsupported ? 'bad' : '';
        modelBox.append(h('label', { class: `model-item${m.unsupported ? ' off' : ''}` },
          input,
          h('div', { class: 'mi-body' },
            h('div', { class: 'mi-head' }, h('b', {}, `${m.title}・${m.name}`), h('span', { class: `badge ${badgeCls}` }, m.badge)),
            h('div', { class: 'mi-meta' },
              m.cached ? h('span', { class: 'ok' }, '✓ 已下載') : `下載 ${m.sizeMB >= 1000 ? (m.sizeMB / 1000).toFixed(1) + ' GB' : m.sizeMB + ' MB'}`,
              `・${m.speed}・${m.acc}`),
            m.warns.length ? h('div', { class: 'mi-warn' }, '⚠ ' + m.warns.join('、')) : null)));
      }
    };
    const trad = h('input', { type: 'checkbox', checked: asr.traditional, disabled: asr.busy });
    trad.onchange = () => (asr.traditional = trad.checked);
    statusEl = h('div', { class: 'dim small' }, asr.status);
    barEl = h('div', { class: 'bar', style: `width:${asr.progress * 100}%` });
    const go = h('button', { class: 'primary wide', disabled: asr.busy || !sources.length, onclick: async () => {
      const clip = store.project.clips.find((c) => c.id === asr.source);
      if (!clip) return;
      asr.busy = true;
      render();
      const t0 = performance.now();
      try {
        const segs = await transcribe(clip, { model: asr.model, language: asr.lang, traditional: asr.traditional }, setStatus);
        const n = addCaptions(segs);
        setStatus({ text: n ? `完成：${n} 句字幕，花 ${((performance.now() - t0) / 1000).toFixed(0)} 秒` : '沒有辨識到語音', progress: 1 });
      } catch (e) {
        console.error(e);
        setStatus({ text: '失敗：' + e.message });
      }
      asr.busy = false;
      render();
    } }, asr.busy ? '辨識中…' : '✨ 產生 AI 字幕');

    body.append(
      h('div', { class: 'section-title' }, 'AI 自動字幕'),
      h('div', { class: 'form' },
        h('label', {}, '來源片段', srcSel),
        h('label', {}, '語言', langSel),
        h('div', { class: 'sub-title' }, '辨識模型（依你的裝置排序）'),
        deviceLine,
        modelBox,
        h('label', { class: 'check' }, trad, ' 轉為繁體中文（台灣用語）'),
        go,
        h('div', { class: 'progress' }, barEl),
        statusEl),
      h('div', { class: 'hint' }, '語音辨識完全在你的電腦上進行，聲音不會上傳。模型第一次使用時會下載並快取。'),
    );

    const list = captionClips();
    const fileIn = h('input', { type: 'file', accept: '.srt,.vtt,text/plain', hidden: true, onchange: async () => {
      const f = fileIn.files[0];
      if (!f) return;
      const segs = parseSRT(await f.text());
      if (!segs.length) return toast('讀不到字幕內容，請確認是 SRT 格式');
      addCaptions(segs, { replace: false });
      toast(`已匯入 ${segs.length} 句字幕`);
    } });
    // ---- 翻譯 / 雙語字幕 ----
    const trList = translationClips();
    const trSrcSel = h('select', { disabled: trOpts.busy }, LANGS.map(([v, l]) => h('option', { value: v }, l)));
    trSrcSel.value = trOpts.src;
    trSrcSel.onchange = () => (trOpts.src = trSrcSel.value);
    const trTgtSel = h('select', { disabled: trOpts.busy }, LANGS.map(([v, l]) => h('option', { value: v }, l)));
    trTgtSel.value = trOpts.tgt;
    trTgtSel.onchange = () => (trOpts.tgt = trTgtSel.value);
    const modeSel = h('select', { disabled: trOpts.busy }, h('option', { value: 'bilingual' }, '雙語：譯文放在原文下方'), h('option', { value: 'replace' }, '直接取代原文'));
    modeSel.value = trOpts.mode;
    modeSel.onchange = () => (trOpts.mode = modeSel.value);
    const trStatus = h('div', { class: 'dim small' }, trOpts.status);
    const trBar = h('div', { class: 'bar', style: `width:${trOpts.progress * 100}%` });
    const setTr = ({ text, progress }) => {
      trOpts.status = text;
      if (progress != null) trOpts.progress = progress;
      trStatus.textContent = text;
      trBar.style.width = `${trOpts.progress * 100}%`;
    };
    body.append(
      h('div', { class: 'section-title' }, '翻譯 / 雙語字幕'),
      h('div', { class: 'form' },
        h('label', {}, '原文語言', trSrcSel),
        h('label', {}, '翻譯成', trTgtSel),
        h('label', {}, '方式', modeSel),
        h('button', { class: 'primary wide', disabled: trOpts.busy || !list.length, onclick: async () => {
          if (trOpts.src === trOpts.tgt) return toast('原文和目標語言一樣');
          trOpts.busy = true;
          trOpts.progress = 0;
          render();
          try {
            const r = await translateCaptions(trOpts.src, trOpts.tgt, trOpts.mode, setTr);
            setTr({ text: `完成：翻譯 ${r.count} 句（${r.engine}）`, progress: 1 });
          } catch (e) {
            console.error(e);
            setTr({ text: '失敗：' + e.message });
          }
          trOpts.busy = false;
          render();
        } }, trOpts.busy ? '翻譯中…' : '🌐 翻譯字幕'),
        h('div', { class: 'progress' }, trBar),
        trStatus),
      h('div', { class: 'hint' }, 'Chrome 會用瀏覽器內建的裝置端翻譯；其他瀏覽器改用 Opus-MT 模型在本機翻譯（每個語言組合約 110 MB，第一次下載後快取）。'),
    );

    // ---- 字幕配音 ----
    const voiceSel = h('select', {}, VOICES.map((v) => h('option', { value: v.id }, v.name)));
    voiceSel.value = ttsPrefs.voice;
    const voiceNote = h('div', { class: 'dim small' }, VOICES.find((v) => v.id === ttsPrefs.voice)?.note || '');
    voiceSel.onchange = () => {
      ttsPrefs.voice = voiceSel.value;
      voiceNote.textContent = VOICES.find((v) => v.id === ttsPrefs.voice)?.note || '';
    };
    const speedIn = h('input', { type: 'range', min: 0.6, max: 1.6, step: 0.05 });
    speedIn.value = ttsPrefs.speed;
    const speedLbl = h('span', { class: 'dim' }, `${ttsPrefs.speed}×`);
    speedIn.oninput = () => {
      ttsPrefs.speed = +speedIn.value;
      speedLbl.textContent = `${ttsPrefs.speed}×`;
    };
    const ttsSrc = h('select', {}, h('option', { value: 'orig' }, '原文字幕'), trList.length ? h('option', { value: 'tr' }, '譯文字幕') : null);
    body.append(
      h('div', { class: 'section-title' }, '字幕配音（文字轉語音）'),
      h('div', { class: 'form' },
        h('label', {}, '聲音', voiceSel),
        voiceNote,
        h('label', {}, '語速', h('div', { class: 'tool-row' }, speedIn, speedLbl)),
        h('label', {}, '念哪一軌', ttsSrc),
        h('button', { class: 'wide', disabled: !list.length, onclick: () => api.speakCaptions(ttsSrc.value === 'tr' ? trList : list, ttsPrefs.voice, ttsPrefs.speed) }, '🔊 幫字幕配音')),
      h('div', { class: 'hint' }, '配音放在「配音」軌；某句念不完會自動加快（最多 1.6 倍）避免蓋到下一句。'),
    );

    // ---- 字幕列表 ----
    const srtSel = h('select', { class: 'mini' }, h('option', { value: 'orig' }, '原文'), trList.length ? [h('option', { value: 'tr' }, '譯文'), h('option', { value: 'both' }, '雙語')] : null);
    body.append(
      h('div', { class: 'section-title row-between' }, `字幕列表（${list.length}）`),
      h('div', { class: 'chips' },
        h('button', { class: 'chip', onclick: () => fileIn.click() }, '匯入 SRT'),
        h('button', { class: 'chip', disabled: !list.length, onclick: () => {
          const which = srtSel.value;
          const a = h('a', { href: URL.createObjectURL(new Blob([toSRT(which)], { type: 'text/plain' })), download: `${store.project.name || 'captions'}${which === 'orig' ? '' : which === 'tr' ? '.譯文' : '.雙語'}.srt` });
          a.click();
        } }, '匯出 SRT'),
        srtSel,
        h('button', { class: 'chip', disabled: !list.length, onclick: () => {
          const s = selected();
          if (!s || !list.includes(s)) return toast('先在下面點一句字幕、調好樣式，再套用到全部');
          applyStyleToAll(s);
          toast('已套用到全部字幕');
        } }, '樣式套用全部'),
        h('button', { class: 'chip', disabled: !list.length, onclick: () => {
          if (!confirm(`刪除全部 ${list.length} 句字幕${trList.length ? '（含譯文）' : ''}？`)) return;
          checkpoint();
          const ids = new Set([...list, ...trList].map((c) => c.id));
          store.project.clips = store.project.clips.filter((c) => !ids.has(c.id));
          emit('project');
        } }, '全部刪除'),
        fileIn),
    );
    const editBox = (c) => {
      const ta = h('textarea', { rows: 1, spellcheck: false });
      ta.value = c.text.content;
      let dirty = false;
      ta.addEventListener('focus', () => { api.seek(c.start + 0.01); api.select(c.id); });
      ta.addEventListener('input', () => {
        if (!dirty) { checkpoint(); dirty = true; }
        c.text.content = ta.value;
        emit('props');
      });
      ta.addEventListener('change', () => { dirty = false; emit('layout'); });
      return ta;
    };
    const ul = h('div', { class: 'cap-list' });
    for (const c of list) {
      const tr = trList.length ? translationFor(c) : null;
      ul.append(h('div', { class: `cap-item${c.id === store.selection ? ' on' : ''}` },
        h('button', { class: 'cap-time', title: '跳到這句', onclick: () => { api.seek(c.start + 0.01); api.select(c.id); } }, fmtTime(c.start).slice(0, 8)),
        h('div', { class: 'cap-texts' }, editBox(c), tr && h('div', { class: 'cap-tr' }, editBox(tr)))));
    }
    body.append(ul);
    fillModels();
  }

  function media() {
    body.append(
      h('button', { class: 'import-btn', onclick: () => $('fileInput').click() },
        h('div', { class: 'big' }, '＋ 匯入媒體'),
        h('div', { class: 'dim' }, '影片 / 音樂 / 圖片，也可以直接拖曳到視窗')),
    );
    const list = [...store.media.values()];
    if (!list.length) return;
    const grid = h('div', { class: 'media-grid' });
    for (const m of list) {
      const thumb = m.type === 'audio'
        ? h('div', { class: 'thumb audio' }, '♫')
        : m.thumbUrl ? h('img', { class: 'thumb', src: m.thumbUrl, draggable: false }) : h('div', { class: 'thumb loading' }, '載入中…');
      grid.append(
        h('div', { class: `media-card${m.error ? ' err' : ''}`, draggable: true, title: m.name,
          ondragstart: dragData('text/x-media', m.id), ondblclick: () => api.addMediaClip(m) },
        thumb,
        h('div', { class: 'badge' }, m.type === 'image' ? '圖片' : fmtTime(m.duration).slice(0, 5)),
        h('div', { class: 'name' }, m.error ? '⚠ ' + m.name : m.name),
        h('button', { class: 'add', title: '加到播放頭位置', onclick: (e) => { e.stopPropagation(); api.addMediaClip(m); } }, '＋'),
        h('button', { class: 'del', title: '從素材庫移除', onclick: (e) => {
          e.stopPropagation();
          const used = store.project.clips.some((c) => c.mediaId === m.id);
          if (used && !confirm('這個媒體正在時間軸上使用，確定移除？')) return;
          removeMedia(m.id);
        } }, '✕'),
        ),
      );
    }
    body.append(h('div', { class: 'hint' }, '雙擊或按 ＋ 加入時間軸，也可以拖到指定軌道與時間'), grid);
  }

  function text() {
    body.append(h('div', { class: 'section-title' }, '文字樣式'));
    const grid = h('div', { class: 'preset-grid' });
    TEXT_PRESETS.forEach((p, i) => {
      const t = p.text;
      const style = [
        `font-family:"${t.font || 'Noto Sans TC'}"`,
        `font-weight:${t.weight || 700}`,
        t.gradient ? `background:linear-gradient(${t.color},${t.color2});-webkit-background-clip:text;color:transparent` : `color:${t.color || '#fff'}`,
        t.stroke ? `-webkit-text-stroke:${Math.min(2, t.stroke / 3)}px ${t.strokeColor}` : '',
        t.shadow ? `text-shadow:0 0 ${t.shadow / 4}px ${t.shadowColor || '#000'}` : '',
        t.bg ? `background:${t.bgColor || '#000'};padding:2px 6px;border-radius:4px` : '',
      ].join(';');
      grid.append(h('div', { class: 'preset-card', draggable: true, ondragstart: dragData('text/x-preset', `text:${i}`), onclick: () => api.addPreset('text', i) },
        h('div', { class: 'pv', style }, p.name), h('div', { class: 'name' }, p.name)));
    });
    body.append(grid);
  }

  // ---------- 範本（剪同款） ----------
  function tplCard(t, { builtin }) {
    const pv = builtin
      ? h('div', { class: 'tpl-pv', style: `background:linear-gradient(135deg,${t.color},#111827)` }, h('span', { class: 'tpl-icon' }, t.icon))
      : h('div', { class: 'tpl-pv' }, t.thumb ? h('img', { src: t.thumb }) : '🧩');
    const tpl = builtin ? null : t;
    const nSlots = builtin ? null : slotsOf(tpl).length;
    return h('div', { class: 'preset-card tpl-card', onclick: () => openTemplate(t.id) },
      pv,
      h('div', { class: 'name' }, t.name),
      h('div', { class: 'tpl-desc' }, builtin ? t.desc : `${nSlots} 個素材位置`),
      !builtin && h('button', { class: 'del', title: '刪除範本', onclick: async (e) => {
        e.stopPropagation();
        if (confirm(`刪除範本「${t.name}」？`)) await deleteTemplate(t.id);
      } }, '✕'));
  }

  function template() {
    const tplFile = h('input', { type: 'file', accept: '.json,application/json', hidden: true, onchange: async () => {
      const f = tplFile.files[0];
      if (!f) return;
      try {
        const t = await importTemplateFile(f);
        toast(`已匯入範本「${t.name}」`);
      } catch (e) {
        toast('匯入失敗：' + e.message);
      }
    } });
    body.append(
      h('div', { class: 'hint' }, '剪同款：選一個範本，換上自己的照片、影片和文字，就能做出同樣的效果。'),
      h('div', { class: 'section-title' }, '內建範本'),
      h('div', { class: 'preset-grid' }, BUILTIN_TEMPLATES.map((t) => tplCard(t, { builtin: true }))),
      h('div', { class: 'section-title' }, `我的範本（${store.templates.size}）`),
      h('div', { class: 'tool-row' },
        h('button', { class: 'primary', disabled: !store.project.clips.length, onclick: openSaveTemplate }, '＋ 把目前專案存成範本'),
        h('button', { onclick: () => tplFile.click() }, '匯入範本檔'),
        tplFile),
      store.templates.size ? h('div', { class: 'preset-grid' }, [...store.templates.values()].sort((a, b) => b.created - a.created).map((t) => tplCard(t, { builtin: false }))) : h('div', { class: 'hint' }, '還沒有自己的範本。把做好的影片存成範本，下次換素材就能重複使用，也能匯出分享給朋友。'),
    );
  }

  // 套用範本的表單：每個素材位置選一個媒體，文字可以改
  function openTemplate(id) {
    const tpl = getTemplate(id);
    const slots = slotsOf(tpl);
    const texts = textsOf(tpl);
    const pool = [...store.media.values()].filter((m) => (m.type === 'video' || m.type === 'image') && !m.error);
    const picks = slots.map((_, i) => pool[i] || null);
    const textVals = {};
    const slotRows = slots.map((s, i) => {
      const sel = h('select', {}, h('option', { value: '' }, '（空白）'), pool.map((m) => h('option', { value: m.id }, `${m.type === 'video' ? '🎬' : '🖼'} ${m.name}`)));
      sel.value = picks[i]?.id || '';
      sel.onchange = () => (picks[i] = store.media.get(sel.value) || null);
      const file = h('input', { type: 'file', accept: 'video/*,image/*', hidden: true, onchange: async () => {
        const [m] = await importFiles([file.files[0]]);
        if (!m) return;
        pool.push(m);
        sel.append(h('option', { value: m.id }, `${m.type === 'video' ? '🎬' : '🖼'} ${m.name}`));
        sel.value = m.id;
        picks[i] = m;
      } });
      return h('div', { class: 'tpl-slot' },
        h('span', { class: 'tpl-slot-no' }, i + 1),
        h('span', { class: 'dim' }, `${s.duration.toFixed(1)} 秒`),
        sel,
        h('button', { onclick: () => file.click() }, '選檔'),
        file);
    });
    const textRows = texts.map((c) => {
      const ta = h('input', { value: c.text.content });
      ta.oninput = () => (textVals[c.id] = ta.value);
      return h('label', { class: 'tpl-text' }, ta);
    });
    const go = h('button', { class: 'primary' }, '建立影片');
    const cancel = h('button', {}, '取消');
    const close = openModal(h('div', { class: 'export tpl-modal' },
      h('h2', {}, `剪同款：${tpl.name}`),
      h('div', { class: 'dim' }, `${tpl.project.width}×${tpl.project.height}・約 ${Math.max(...tpl.project.clips.map((c) => c.start + c.duration)).toFixed(1)} 秒`),
      slots.length > 0 && h('div', { class: 'section-title' }, `素材（${slots.length} 個位置，已依媒體庫順序自動填入）`),
      ...slotRows,
      textRows.length > 0 && h('div', { class: 'section-title' }, '文字'),
      ...textRows,
      h('div', { class: 'hint' }, '建立後會取代目前的時間軸（可按 Ctrl+Z 復原），之後一樣可以自由修改。'),
      h('div', { class: 'modal-actions' }, cancel, go)));
    cancel.onclick = close;
    go.onclick = async () => {
      go.disabled = true;
      await applyTemplate(tpl, picks, textVals);
      close();
      toast(`已套用範本「${tpl.name}」`);
    };
  }

  // 存成範本：勾選哪些畫面片段是「可替換素材」
  function openSaveTemplate() {
    const visuals = store.project.clips.filter((c) => (c.type === 'video' || c.type === 'image') && !c.caption).sort((a, b) => a.start - b.start);
    const chosen = new Set(visuals.map((c) => c.id));
    const name = h('input', { value: `${store.project.name} 範本` });
    const rows = visuals.map((c) => {
      const cb = h('input', { type: 'checkbox', checked: true });
      cb.onchange = () => (cb.checked ? chosen.add(c.id) : chosen.delete(c.id));
      return h('label', { class: 'row check' }, cb, h('span', {}, `${fmtTime(c.start).slice(0, 5)}　${store.media.get(c.mediaId)?.name || '素材'}`));
    });
    const save = h('button', { class: 'primary' }, '儲存範本');
    const cancel = h('button', {}, '取消');
    const close = openModal(h('div', { class: 'export' },
      h('h2', {}, '存成範本'),
      h('div', { class: 'row' }, h('label', {}, '名稱'), name),
      h('div', { class: 'section-title' }, '可替換的素材（套用時讓使用者換掉）'),
      ...(rows.length ? rows : [h('div', { class: 'dim' }, '時間軸上沒有影片或圖片')]),
      h('div', { class: 'hint' }, '沒勾的素材、音樂、貼圖會跟著範本一起保存；文字都可以在套用時修改。'),
      h('div', { class: 'modal-actions' }, cancel, save)));
    cancel.onclick = close;
    save.onclick = async () => {
      save.disabled = true;
      const t = await saveTemplate(name.value.trim() || '我的範本', [...chosen]);
      close();
      toast(`已存成範本「${t.name}」`);
      const a = h('a', { href: URL.createObjectURL(await exportTemplateFile(t)), download: `${t.name}.ezicut.json` });
      if (confirm('要同時下載範本檔，方便分享給朋友嗎？')) a.click();
    };
  }

  function sticker() {
    body.append(h('div', { class: 'section-title' }, '表情貼圖（點一下加入）'));
    const grid = h('div', { class: 'sticker-grid' });
    STICKERS.forEach((s, i) => grid.append(h('button', { class: 'sticker', draggable: true, ondragstart: dragData('text/x-preset', `sticker:${i}`), onclick: () => api.addPreset('sticker', i) }, s)));
    body.append(grid);
  }

  function element() {
    body.append(h('div', { class: 'section-title' }, '形狀與背景'));
    const grid = h('div', { class: 'preset-grid' });
    SHAPE_PRESETS.forEach((p, i) => {
      const s = p.shape;
      const bg = s.kind === 'gradient' ? `linear-gradient(135deg,${s.color},${s.color2})` : s.color;
      const shapeStyle = s.kind === 'circle' ? `width:40px;height:40px;border-radius:50%;background:${bg}`
        : s.kind === 'rect' ? `width:56px;height:34px;border-radius:${s.radius ? 10 : 2}px;background:${bg}`
        : s.kind === 'letterbox' ? `width:100%;height:100%;border-top:10px solid #000;border-bottom:10px solid #000;background:#556`
        : `width:100%;height:100%;background:${bg}`;
      grid.append(h('div', { class: 'preset-card', draggable: true, ondragstart: dragData('text/x-preset', `shape:${i}`), onclick: () => api.addPreset('shape', i) },
        h('div', { class: 'pv' }, h('div', { style: shapeStyle })), h('div', { class: 'name' }, p.name)));
    });
    body.append(grid);
  }

  function filter() {
    const c = selected();
    const sample = c && store.media.get(c.mediaId)?.thumbUrl;
    body.append(h('div', { class: 'section-title' }, c ? '套用到選取的片段' : '先在時間軸選一個片段'));
    const grid = h('div', { class: 'preset-grid' });
    FILTER_PRESETS.forEach((p, i) => {
      const f = { brightness: 100, contrast: 100, saturate: 100, hue: 0, blur: 0, grayscale: 0, sepia: 0, invert: 0, ...p.filters };
      const pv = sample
        ? h('img', { src: sample, style: `filter:${filterString(f)}` })
        : h('div', { class: 'sample-grad', style: `filter:${filterString(f)}` });
      grid.append(h('div', { class: 'preset-card filter', onclick: () => api.applyFilterPreset(i) }, h('div', { class: 'pv' }, pv), h('div', { class: 'name' }, p.name)));
    });
    body.append(grid);
  }

  function transition() {
    body.append(h('div', { class: 'section-title' }, '套用到選取片段的入場 / 出場'));
    const list = h('div', { class: 'trans-list' });
    for (const [id, label] of TRANSITIONS.slice(1)) {
      list.append(h('div', { class: 'trans-item' },
        h('span', { class: 'nm' }, label),
        h('button', { onclick: () => api.applyTransition(id, 'in') }, '入場'),
        h('button', { onclick: () => api.applyTransition(id, 'out') }, '出場'),
        h('button', { onclick: () => api.applyTransition(id, 'both') }, '兩者')));
    }
    body.append(list, h('div', { class: 'hint' }, '小技巧：兩個片段在不同軌道上重疊，前一個設「出場淡出」、後一個設「入場淡入」，就是交叉溶接。'));
  }

  on('media', () => tab === 'media' && render());
  on('templates', () => tab === 'template' && render());
  on('select', () => tab === 'filter' && render());
  const isTyping = () => document.activeElement?.closest?.('.cap-list');
  on('project', () => tab === 'caption' && !isTyping() && render());
  on('layout', () => tab === 'caption' && !isTyping() && render());
  renderTabs();
  render();
}
