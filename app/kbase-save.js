/**
 * K-Base Save Integration
 * 在论文详情页注入「保存到 K-Base」按钮。
 * 点击后将论文数据发送到本地 paper_bridge 服务，
 * 自动下载 PDF + LLM 生成 .typ 深度总结，存入 K-Base。
 *
 * 依赖：paper_bridge 服务运行在 http://127.0.0.1:8766
 * 在 docsify-plugin.js doneEach() 中调用 KBaseSave.injectSaveButton()
 */
(function () {
  'use strict';

  var BRIDGE_URL = 'http://127.0.0.1:8766';
  var SAVE_STATE_KEY = 'dpr_kbase_saved_v1'; // 记录已保存的 paper_id

  /**
   * 从 YAML frontmatter 文本解析为对象。
   * 复用项目内置的 js-yaml（如果可用），否则使用简单行解析。
   */
  function parseFrontMatter(rawMarkdown) {
    if (!rawMarkdown) return {};
    var m = rawMarkdown.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!m) return {};
    var yamlText = m[1];
    try {
      if (window.jsyaml && typeof window.jsyaml.load === 'function') {
        return window.jsyaml.load(yamlText) || {};
      }
    } catch (e) { /* fall through */ }
    // 简单行解析
    var meta = {};
    var lines = yamlText.split('\n');
    var currentKey = '';
    var currentValue = '';
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var keyMatch = line.match(/^(\w[\w_]*):\s*(.*)/);
      if (keyMatch) {
        if (currentKey) {
          meta[currentKey] = currentValue.trim();
        }
        currentKey = keyMatch[1];
        currentValue = keyMatch[2];
      } else if (currentKey) {
        currentValue += '\n' + line;
      }
    }
    if (currentKey) {
      meta[currentKey] = currentValue.trim();
    }
    // 解析 tags
    if (meta.tags) {
      try {
        var parsed = JSON.parse(meta.tags);
        if (Array.isArray(parsed)) meta.tags = parsed;
      } catch (e) {
        // 可能是 "tag1, tag2" 格式
        meta.tags = meta.tags.split(',').map(function (t) { return t.trim(); });
      }
    }
    // 解析 score
    if (meta.score) {
      meta.score = parseFloat(meta.score);
    }
    return meta;
  }

  /**
   * 从当前页面收集论文数据。
   * 数据来源：YAML frontmatter + DOM 中的 AI 摘要
   */
  function collectPaperData() {
    // 1. 从 latestPaperRawMarkdown 解析 frontmatter
    var rawMd = window.latestPaperRawMarkdown || '';
    var meta = parseFrontMatter(rawMd);

    // 2. 从 DOM 补充信息
    var abstractEn = '';
    var abstractEl = document.querySelector('#abstract-en-content, .paper-abstract-en');
    if (abstractEl) abstractEn = abstractEl.textContent.trim();

    var tldrEl = document.querySelector('.paper-meta-row .col-left [data-field="tldr"], .paper-meta-row .tldr-text');
    if (tldrEl) meta._dom_tldr = tldrEl.textContent.trim();

    // 3. paper_id 从路由获取
    var paperId = '';
    try {
      if (window.$docsify && window.$docsify.vm && window.$docsify.vm.route) {
        var routePath = window.$docsify.vm.route.path || '';
        var parts = routePath.replace(/\.md$/, '').split('/');
        paperId = parts[parts.length - 1];
      }
    } catch (e) {}

    // 4. 从 PDF URL 推断 paper_id
    if (!paperId && meta.pdf) {
      var pdfMatch = meta.pdf.match(/([\d]+\.[\d]+(?:v\d+)?)/);
      if (pdfMatch) paperId = pdfMatch[1];
    }

    // 5. 构建完整的论文数据
    var paper = {
      paper_id: paperId || meta.paper_id || '',
      title: meta.title || document.title || '',
      title_zh: meta.title_zh || '',
      authors: meta.authors || '',
      date: meta.date ? String(meta.date) : '',
      pdf_url: meta.pdf || '',
      source: meta.source || meta.selection_source || 'arxiv',
      abstract_en: meta.abstract_en || meta.abstract || abstractEn,
      tldr: meta.tldr || meta._dom_tldr || '',
      ai_summary: meta.evidence || '',
      motivation: meta.motivation || '',
      method: meta.method || '',
      result: meta.result || '',
      conclusion: meta.conclusion || '',
      evidence: meta.evidence || '',
      tags: meta.tags || [],
      score: meta.score || 0,
      chat_history: [],
    };

    // 6. 可选：加载 AI 聊天历史
    try {
      if (window.PrivateDiscussionChat && typeof window.PrivateDiscussionChat.loadChatHistory === 'function') {
        // loadChatHistory 返回 Promise
      }
    } catch (e) {}

    return paper;
  }

  /**
   * 检查 paper_bridge 是否可达
   */
  function checkBridgeHealth() {
    return fetch(BRIDGE_URL + '/api/health', {
      method: 'GET',
      signal: AbortSignal.timeout(3000),
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        return data && data.status === 'ok';
      })
      .catch(function () {
        return false;
      });
  }

  /**
   * 保存论文到 K-Base
   */
  function saveToKBase(paperData) {
    return fetch(BRIDGE_URL + '/api/save-paper', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(paperData),
    }).then(function (r) {
      if (!r.ok) throw new Error('Server returned ' + r.status);
      return r.json();
    });
  }

  /**
   * 获取已保存论文列表
   */
  function getSavedPapers() {
    try {
      var saved = JSON.parse(localStorage.getItem(SAVE_STATE_KEY) || '{}');
      return saved;
    } catch (e) {
      return {};
    }
  }

  /**
   * 标记论文为已保存
   */
  function markSaved(paperId) {
    var saved = getSavedPapers();
    saved[paperId] = Date.now();
    localStorage.setItem(SAVE_STATE_KEY, JSON.stringify(saved));
  }

  /**
   * 检查论文是否已保存
   */
  function isPaperSaved(paperId) {
    return !!getSavedPapers()[paperId];
  }

  /**
   * 创建并注入保存按钮
   */
  function injectSaveButton() {
    // 查找按钮注入位置：meta row 右侧，或 title bar
    var container = document.querySelector('.dpr-title-bar');
    if (!container) {
      container = document.querySelector('.paper-meta-row');
    }
    if (!container) return;

    // 避免重复注入
    if (document.getElementById('dpr-kbase-save-btn')) return;

    var paperId = '';
    try {
      if (window.$docsify && window.$docsify.vm && window.$docsify.vm.route) {
        var routePath = window.$docsify.vm.route.path || '';
        var parts = routePath.replace(/\.md$/, '').split('/');
        paperId = parts[parts.length - 1];
      }
    } catch (e) {}

    // 创建按钮
    var btn = document.createElement('button');
    btn.id = 'dpr-kbase-save-btn';
    btn.className = 'dpr-kbase-save-btn';
    btn.title = '保存到 K-Base（下载PDF + 生成Typst总结）';
    btn.style.cssText = [
      'display:inline-flex;align-items:center;gap:4px;',
      'padding:4px 12px;border:1px solid #94a3b8;border-radius:6px;',
      'background:#fff;color:#334155;cursor:pointer;font-size:13px;',
      'transition:all .2s;margin-left:8px;',
    ].join('');
    btn.onmouseenter = function () {
      btn.style.borderColor = '#6366f1';
      btn.style.color = '#4f46e5';
    };
    btn.onmouseleave = function () {
      btn.style.borderColor = '#94a3b8';
      btn.style.color = '#334155';
    };

    // 根据是否已保存设置初始状态
    if (isPaperSaved(paperId)) {
      btn.innerHTML = '✅ 已保存';
      btn.style.borderColor = '#22c55e';
      btn.style.color = '#16a34a';
    } else {
      btn.innerHTML = '📥 保存到 K-Base';
    }

    // 点击事件
    btn.addEventListener('click', function () {
      if (btn.disabled) return;

      // 如果已保存，询问是否重新保存
      if (isPaperSaved(paperId)) {
        if (!confirm('这篇论文已经保存过，要重新保存吗？')) {
          return;
        }
      }

      // 检查 bridge 是否可达
      btn.disabled = true;
      btn.innerHTML = '⏳ 检测中...';

      checkBridgeHealth().then(function (ok) {
        if (!ok) {
          btn.innerHTML = '⚠️ 未连接 Bridge';
          btn.style.borderColor = '#ef4444';
          btn.style.color = '#dc2626';
          setTimeout(function () { btn.disabled = false; }, 2000);
          return;
        }

        // 收集数据并发送
        btn.innerHTML = '📦 收集中...';
        var paperData = collectPaperData();

        btn.innerHTML = '🚀 保存中...';
        return saveToKBase(paperData);
      }).then(function (result) {
        if (result && result.ok) {
          markSaved(paperId);
          btn.innerHTML = '✅ 已保存';
          btn.style.borderColor = '#22c55e';
          btn.style.color = '#16a34a';
          console.log('[KBase] Saved:', result);
        }
      }).catch(function (err) {
        console.error('[KBase] Save failed:', err);
        btn.innerHTML = '❌ 保存失败';
        btn.style.borderColor = '#ef4444';
        btn.style.color = '#dc2626';
      }).finally(function () {
        setTimeout(function () {
          btn.disabled = false;
          if (isPaperSaved(paperId)) {
            btn.innerHTML = '✅ 已保存';
            btn.style.borderColor = '#22c55e';
            btn.style.color = '#16a34a';
          } else {
            btn.innerHTML = '📥 保存到 K-Base';
            btn.style.borderColor = '#94a3b8';
            btn.style.color = '#334155';
          }
        }, 3000);
      });
    });

    container.appendChild(btn);
  }

  // 暴露到全局
  window.KBaseSave = {
    injectSaveButton: injectSaveButton,
    collectPaperData: collectPaperData,
    checkBridgeHealth: checkBridgeHealth,
    saveToKBase: saveToKBase,
    isPaperSaved: isPaperSaved,
  };
})();
