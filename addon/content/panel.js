(function attachResearchPanel(global) {
  'use strict';

  var XHTML_NS = 'http://www.w3.org/1999/xhtml';
  var INSTANCE_SEQUENCE = 0;

  var MODE_LABELS = {
    reading: '精读',
    question: '问答',
    review: '模拟审稿',
    explain: '解释',
    translate: '翻译',
  };

  var MODEL_MODES = {
    review: true,
    translate: true,
  };

  var hasOwn = Object.prototype.hasOwnProperty;

  function isObject(value) {
    return value !== null && typeof value === 'object';
  }

  function safeJson(value) {
    try {
      var encoded = JSON.stringify(value);
      return encoded === undefined ? '' : encoded;
    } catch (error) {
      return '[不可序列化内容]';
    }
  }

  function displayText(value, fallback) {
    if (value === null || value === undefined) return fallback || '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return safeJson(value);
  }

  function cloneObject(value) {
    if (!isObject(value)) return value;
    var clone = {};
    Object.keys(value).forEach(function copyKey(key) {
      clone[key] = value[key];
    });
    return clone;
  }

  function createElement(document, tagName, attributes, content) {
    var element = document.createElementNS(XHTML_NS, tagName);
    if (attributes) {
      Object.keys(attributes).forEach(function setAttribute(key) {
        var value = attributes[key];
        if (value === undefined || value === null || value === false) return;
        if (key === 'className') {
          element.setAttribute('class', String(value));
        } else if (key === 'textContent') {
          element.textContent = displayText(value);
        } else if (key === 'checked' || key === 'disabled' || key === 'hidden') {
          element[key] = Boolean(value);
        } else if (key === 'dataset' && isObject(value)) {
          Object.keys(value).forEach(function setDataset(datasetKey) {
            element.setAttribute('data-' + datasetKey, String(value[datasetKey]));
          });
        } else {
          element.setAttribute(key, String(value));
        }
      });
    }
    if (content !== undefined && content !== null) {
      element.textContent = displayText(content);
    }
    return element;
  }

  function clearChildren(element) {
    while (element && element.firstChild) {
      element.removeChild(element.firstChild);
    }
  }

  function setText(element, value, fallback) {
    if (element) element.textContent = displayText(value, fallback);
  }

  function setInputValue(element, value) {
    if (element) element.value = displayText(value);
  }

  function setHidden(element, hidden) {
    if (element) element.hidden = Boolean(hidden);
  }

  function setAction(element, action) {
    element.setAttribute('data-zrp-action', action);
    return element;
  }

  function modelConfigured(value) {
    if (value === null) return false;
    if (value === undefined) return undefined;
    if (typeof value === 'string') return value.trim().length > 0;
    if (Array.isArray(value)) return value.length > 0;
    return Boolean(value);
  }

  function modelName(value) {
    if (value === null || value === undefined || value === '') return '未配置';
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map(displayText).join('、');
    return displayText(value);
  }

  function formatPage(page, pageLabel) {
    if (pageLabel !== undefined && pageLabel !== null && String(pageLabel).trim() !== '') {
      return '第 ' + String(pageLabel) + ' 页';
    }
    return '第 ' + displayText(page, '?') + ' 页';
  }

  function formatExpiry(expiresAt) {
    if (!expiresAt) return '有效期未知';
    return '有效至 ' + displayText(expiresAt);
  }

  function parseDois(value) {
    var seen = Object.create(null);
    return displayText(value)
      .split(/[\n,;]+/)
      .map(function trimDoi(doi) {
        return doi.trim();
      })
      .filter(function uniqueDoi(doi) {
        if (!doi || seen[doi]) return false;
        seen[doi] = true;
        return true;
      })
      .map(function makeRequest(doi) {
        return { doi: doi };
      });
  }

  function getActionTarget(target, root) {
    var node = target;
    if (node && node.nodeType !== 1) node = node.parentElement;
    while (node && node !== root) {
      if (node.hasAttribute && node.hasAttribute('data-zrp-action')) return node;
      node = node.parentElement;
    }
    if (node === root && node.hasAttribute && node.hasAttribute('data-zrp-action')) return node;
    return null;
  }

  function mount(body, adapter) {
    if (!body || !body.ownerDocument) {
      throw new TypeError('ZoteroResearchPanel.mount 需要一个 DOM 容器');
    }

    var document = body.ownerDocument;
    var view = document.defaultView || global;
    var rpcAdapter = adapter || {};
    INSTANCE_SEQUENCE += 1;
    var instanceRadioName = 'zrp-sensitivity-' + String(INSTANCE_SEQUENCE);
    var destroyed = false;
    var state = {
      context: null,
      selection: null,
      analysis: null,
      notePreview: null,
      writeAuthorization: null,
      highlightPreview: null,
      highlightCommitted: false,
      highlightCommitAttempted: false,
      writeAttempted: false,
      cloudGrant: null,
      cloudStatusMessage: '',
      grantExpiryTimer: null,
      health: null,
      localModel: undefined,
      externalModel: undefined,
      contextGeneration: 0,
      requestSequence: 0,
      inFlight: new Map(),
    };
    var cleanups = [];
    var refs = {};

    var root = createElement(document, 'section', {
      className: 'zrp-panel',
      'data-zrp-root': 'true',
      'aria-label': '科研助手',
    });
    body.appendChild(root);

    function listen(element, eventName, handler) {
      element.addEventListener(eventName, handler);
      cleanups.push(function removeListener() {
        element.removeEventListener(eventName, handler);
      });
    }

    function addHeading(parent, level, text) {
      var heading = createElement(document, level, { className: 'zrp-heading' }, text);
      parent.appendChild(heading);
      return heading;
    }

    function addButton(parent, testId, label, action, className) {
      var button = createElement(document, 'button', {
        type: 'button',
        className: className || 'zrp-button',
        'data-testid': testId,
      }, label);
      setAction(button, action);
      parent.appendChild(button);
      return button;
    }

    function addCheck(parent, testId, label, options) {
      var wrapper = createElement(document, 'label', { className: 'zrp-check' });
      var input = createElement(document, 'input', {
        type: 'checkbox',
        'data-testid': testId,
      });
      if (options && options.name) input.setAttribute('name', options.name);
      if (options && options.value) input.setAttribute('value', options.value);
      wrapper.appendChild(input);
      wrapper.appendChild(createElement(document, 'span', null, label));
      parent.appendChild(wrapper);
      return input;
    }

    function addRadio(parent, testId, value, label, checked) {
      var wrapper = createElement(document, 'label', { className: 'zrp-check' });
      var input = createElement(document, 'input', {
        type: 'radio',
        name: instanceRadioName,
        value: value,
        checked: checked,
        'data-testid': testId,
      });
      wrapper.appendChild(input);
      wrapper.appendChild(createElement(document, 'span', null, label));
      parent.appendChild(wrapper);
      return input;
    }

    function buildUi() {
      var header = createElement(document, 'header', { className: 'zrp-header' });
      var brandLine = createElement(document, 'div', { className: 'zrp-brand-line' });
      brandLine.appendChild(createElement(document, 'span', { className: 'zrp-mark', 'aria-hidden': 'true' }, 'R'));
      brandLine.appendChild(createElement(document, 'h1', { className: 'zrp-brand' }, '科研助手'));
      header.appendChild(brandLine);
      refs.paperTitle = createElement(document, 'div', {
        className: 'zrp-paper-title',
        'data-testid': 'paper-title',
      }, '未选择文献');
      header.appendChild(refs.paperTitle);
      refs.paperStatus = createElement(document, 'div', {
        className: 'zrp-paper-status',
        'data-testid': 'paper-status',
      }, '未选择文献 · 默认敏感（仅本地）');
      header.appendChild(refs.paperStatus);
      refs.contextMeta = createElement(document, 'div', { className: 'zrp-meta' }, '');
      header.appendChild(refs.contextMeta);
      root.appendChild(header);

      var healthSection = createElement(document, 'section', { className: 'zrp-health zrp-card' });
      var healthHeading = createElement(document, 'div', { className: 'zrp-row zrp-row-between' });
      addHeading(healthHeading, 'h2', '连接与模型');
      addButton(healthHeading, 'settings', '设置', 'settings', 'zrp-button zrp-button-quiet');
      healthSection.appendChild(healthHeading);
      var healthLine = createElement(document, 'div', { className: 'zrp-health-line' });
      refs.healthStatus = createElement(document, 'span', {
        className: 'zrp-status-badge',
        'data-testid': 'health-status',
      }, '检查连接…');
      healthLine.appendChild(refs.healthStatus);
      refs.modelLocal = createElement(document, 'span', { className: 'zrp-model-label' }, '本地模型配置：检查中');
      healthLine.appendChild(refs.modelLocal);
      refs.modelExternal = createElement(document, 'span', { className: 'zrp-model-label' }, '云端模型配置：检查中');
      healthLine.appendChild(refs.modelExternal);
      healthSection.appendChild(healthLine);
      refs.noModelNotice = createElement(document, 'div', {
        className: 'zrp-notice zrp-notice-attention',
        role: 'status',
        'data-testid': 'no-model-notice',
      }, '');
      refs.noModelNotice.hidden = true;
      healthSection.appendChild(refs.noModelNotice);
      root.appendChild(healthSection);

      var selectionSection = createElement(document, 'section', { className: 'zrp-card' });
      addHeading(selectionSection, 'h2', '已选原文');
      refs.selectionSnapshot = createElement(document, 'div', {
        className: 'zrp-selection-snapshot',
        'data-testid': 'selection-snapshot',
      }, '暂无选文');
      selectionSection.appendChild(refs.selectionSnapshot);
      var selectionFooter = createElement(document, 'div', { className: 'zrp-row zrp-row-between' });
      refs.selectionPage = addButton(selectionFooter, 'selection-page', '暂无页码', 'navigate-selection', 'zrp-page-button');
      refs.selectionPage.hidden = true;
      refs.selectionMeta = createElement(document, 'span', { className: 'zrp-meta' }, '');
      selectionFooter.appendChild(refs.selectionMeta);
      selectionSection.appendChild(selectionFooter);
      root.appendChild(selectionSection);

      var privacySection = createElement(document, 'section', { className: 'zrp-card' });
      addHeading(privacySection, 'h2', '隐私与解析');
      var privacyFieldset = createElement(document, 'fieldset', { className: 'zrp-fieldset' });
      privacyFieldset.appendChild(createElement(document, 'legend', null, '本次处理范围'));
      refs.sensitivitySensitive = addRadio(
        privacyFieldset,
        'sensitivity-sensitive',
        'sensitive',
        '敏感：仅本地处理（默认）',
        true,
      );
      refs.sensitivityPublic = addRadio(
        privacyFieldset,
        'sensitivity-public',
        'public',
        '公开：仍需逐次明确决定是否使用云端',
        false,
      );
      privacySection.appendChild(privacyFieldset);
      refs.allowCloud = addCheck(
        privacySection,
        'allow-cloud',
        '我明确允许将本次问题、选文和检索证据发送到云端（论文公开不代表问题公开）',
      );
      refs.privacySummary = createElement(document, 'div', {
        className: 'zrp-privacy-summary',
        'data-testid': 'privacy-summary',
      }, '敏感内容不会发送到云端');
      privacySection.appendChild(refs.privacySummary);
      var parseRow = createElement(document, 'div', { className: 'zrp-parse-row' });
      refs.allowHeavy = addCheck(parseRow, 'allow-heavy', '允许本地重解析兜底');
      refs.forceHeavy = addCheck(parseRow, 'force-heavy', '强制本次使用重解析');
      privacySection.appendChild(parseRow);
      refs.parseHint = createElement(document, 'div', { className: 'zrp-meta' }, '重解析仅在本地配置存在时执行。');
      privacySection.appendChild(refs.parseHint);
      root.appendChild(privacySection);

      var querySection = createElement(document, 'section', { className: 'zrp-card' });
      addHeading(querySection, 'h2', '研究动作');
      var modeLabel = createElement(document, 'label', { className: 'zrp-label' }, '模式');
      refs.mode = createElement(document, 'select', {
        className: 'zrp-input',
        'data-testid': 'mode',
        'aria-label': '研究模式',
      });
      Object.keys(MODE_LABELS).forEach(function addMode(mode) {
        refs.mode.appendChild(createElement(document, 'option', { value: mode }, MODE_LABELS[mode]));
      });
      modeLabel.appendChild(refs.mode);
      querySection.appendChild(modeLabel);
      var questionLabel = createElement(document, 'label', { className: 'zrp-label' }, '问题或任务');
      refs.question = createElement(document, 'textarea', {
        className: 'zrp-input zrp-question',
        'data-testid': 'question',
        rows: '3',
        placeholder: '可输入研究问题；问答模式需要填写问题',
      });
      questionLabel.appendChild(refs.question);
      querySection.appendChild(questionLabel);
      refs.analysisSubmit = addButton(querySection, 'analysis-submit', '开始分析', 'analysis', 'zrp-button zrp-button-primary');
      refs.requestStatus = createElement(document, 'div', {
        className: 'zrp-request-status',
        role: 'status',
        'data-testid': 'request-status',
      }, '');
      querySection.appendChild(refs.requestStatus);
      refs.error = createElement(document, 'div', {
        className: 'zrp-error',
        role: 'alert',
        'data-testid': 'error',
      }, '');
      refs.error.hidden = true;
      querySection.appendChild(refs.error);
      root.appendChild(querySection);

      var resultSection = createElement(document, 'section', {
        className: 'zrp-card zrp-result',
        'data-testid': 'analysis-result',
      });
      resultSection.hidden = true;
      addHeading(resultSection, 'h2', '分析结果');
      refs.analysisMeta = createElement(document, 'div', { className: 'zrp-meta', 'data-testid': 'analysis-meta' }, '');
      resultSection.appendChild(refs.analysisMeta);
      refs.analysisNotice = createElement(document, 'div', {
        className: 'zrp-notice',
        role: 'status',
        'data-testid': 'analysis-notice',
      }, '');
      refs.analysisNotice.hidden = true;
      resultSection.appendChild(refs.analysisNotice);
      refs.sectionList = createElement(document, 'div', { className: 'zrp-section-list' });
      resultSection.appendChild(refs.sectionList);
      addHeading(resultSection, 'h3', '页码证据');
      refs.evidenceList = createElement(document, 'div', { className: 'zrp-evidence-list' });
      resultSection.appendChild(refs.evidenceList);
      root.appendChild(resultSection);

      var highlightSection = createElement(document, 'section', {
        className: 'zrp-card zrp-preview-card',
        'data-testid': 'highlight-preview',
      });
      highlightSection.hidden = true;
      refs.highlightPreview = highlightSection;
      addHeading(highlightSection, 'h2', '高亮预览');
      refs.highlightText = createElement(document, 'pre', { className: 'zrp-quote' }, '');
      highlightSection.appendChild(refs.highlightText);
      refs.highlightMeta = createElement(document, 'div', { className: 'zrp-preview-meta' }, '');
      highlightSection.appendChild(refs.highlightMeta);
      var highlightButtons = createElement(document, 'div', { className: 'zrp-row' });
      refs.highlightCommit = addButton(highlightButtons, 'highlight-commit', '确认并写入高亮', 'highlight-commit', 'zrp-button zrp-button-primary');
      highlightSection.appendChild(highlightButtons);
      refs.highlightStatus = createElement(document, 'div', { className: 'zrp-meta' }, '');
      highlightSection.appendChild(refs.highlightStatus);
      root.appendChild(highlightSection);

      var noteSection = createElement(document, 'section', { className: 'zrp-card' });
      addHeading(noteSection, 'h2', '笔记预览');
      var noteTitleLabel = createElement(document, 'label', { className: 'zrp-label' }, '笔记标题');
      refs.noteTitle = createElement(document, 'input', {
        className: 'zrp-input',
        type: 'text',
        'data-testid': 'note-title',
      });
      noteTitleLabel.appendChild(refs.noteTitle);
      noteSection.appendChild(noteTitleLabel);
      refs.notePreviewSubmit = addButton(noteSection, 'note-preview-submit', '生成笔记预览', 'note-preview', 'zrp-button');
      var notePreview = createElement(document, 'div', {
        className: 'zrp-note-preview',
        'data-testid': 'note-preview',
      });
      notePreview.hidden = true;
      refs.notePreview = notePreview;
      refs.notePreviewText = createElement(document, 'pre', { className: 'zrp-note-text' }, '');
      notePreview.appendChild(refs.notePreviewText);
      refs.notePreviewMeta = createElement(document, 'div', { className: 'zrp-preview-meta' }, '');
      notePreview.appendChild(refs.notePreviewMeta);
      refs.noteSave = addButton(notePreview, 'note-save', '确认内容并写入笔记', 'note-save', 'zrp-button');
      noteSection.appendChild(notePreview);
      var writeConfirmation = createElement(document, 'div', {
        className: 'zrp-write-confirmation zrp-notice',
        'data-testid': 'write-confirmation',
        role: 'status',
      });
      writeConfirmation.hidden = true;
      refs.writeConfirmation = writeConfirmation;
      refs.writeSummary = createElement(document, 'pre', { className: 'zrp-confirmation-text' }, '');
      writeConfirmation.appendChild(refs.writeSummary);
      refs.noteWriteConfirm = addButton(writeConfirmation, 'note-write-confirm', '确认摘要并写入笔记', 'note-write-confirm', 'zrp-button zrp-button-primary');
      noteSection.appendChild(writeConfirmation);
      refs.noteStatus = createElement(document, 'div', { className: 'zrp-meta' }, '');
      noteSection.appendChild(refs.noteStatus);
      root.appendChild(noteSection);

      var citationSection = createElement(document, 'section', { className: 'zrp-card' });
      addHeading(citationSection, 'h2', 'DOI核验');
      var doiLabel = createElement(document, 'label', { className: 'zrp-label' }, 'DOI（每行一个）');
      refs.doiInput = createElement(document, 'textarea', {
        className: 'zrp-input',
        'data-testid': 'doi-input',
        rows: '2',
        placeholder: '10.xxxx/xxxxx',
      });
      doiLabel.appendChild(refs.doiInput);
      citationSection.appendChild(doiLabel);
      refs.doiConsent = addCheck(
        citationSection,
        'doi-network-consent',
        '我明确允许本次使用公网公开元数据核验 DOI（不发送全文）',
      );
      addButton(citationSection, 'doi-submit', '核验 DOI', 'doi-audit', 'zrp-button');
      refs.doiStatus = createElement(document, 'pre', {
        className: 'zrp-doi-status',
        'data-testid': 'doi-status',
      }, '');
      citationSection.appendChild(refs.doiStatus);
      root.appendChild(citationSection);

      var cloudSection = createElement(document, 'section', { className: 'zrp-card' });
      addHeading(cloudSection, 'h2', 'Codex 临时读取授权');
      refs.codexConsent = addCheck(
        cloudSection,
        'codex-consent',
        '我明确允许 Codex 读取这篇公开论文 10 分钟（不自动包含 notes）',
      );
      addButton(cloudSection, 'grant-codex', '授权 10 分钟', 'grant-codex', 'zrp-button');
      refs.revokeCodex = addButton(cloudSection, 'revoke-codex', '撤销当前文献读取授权', 'revoke-codex', 'zrp-button zrp-button-danger');
      refs.cloudStatus = createElement(document, 'div', {
        className: 'zrp-meta',
        'data-testid': 'cloud-status',
      }, '授权状态未在本面板保留；请选择当前文献后可执行撤销。');
      cloudSection.appendChild(refs.cloudStatus);
      root.appendChild(cloudSection);
    }

    function clearError() {
      refs.error.hidden = true;
      refs.error.textContent = '';
    }

    function showError(message) {
      refs.error.hidden = false;
      refs.error.textContent = displayText(message, '请求失败');
    }

    function showRequestStatus(message) {
      setText(refs.requestStatus, message || '');
    }

    function currentSensitivity() {
      return refs.sensitivityPublic.checked ? 'public' : 'sensitive';
    }

    function cloudOptIn() {
      return currentSensitivity() === 'public' && refs.allowCloud.checked;
    }

    function contextIsCurrent(generation) {
      return !destroyed && generation === state.contextGeneration;
    }

    function requestIsCurrent(action, id, generation) {
      var current = state.inFlight.get(action);
      if (action === 'health') return !destroyed && current && current.id === id;
      return contextIsCurrent(generation) && current && current.id === id;
    }

    function setRequestBusy(action, busy, generation, id) {
      if (busy) {
        state.inFlight.set(action, { id: id, generation: generation });
      } else {
        var current = state.inFlight.get(action);
        if (current && current.id === id) state.inFlight.delete(action);
      }
      renderControls();
    }

    function runRequest(action, generation, operation, onSuccess, options) {
      var config = options || {};
      if (destroyed || state.inFlight.has(action)) return Promise.resolve(false);
      var id = state.requestSequence + 1;
      state.requestSequence = id;
      setRequestBusy(action, true, generation, id);
      if (config.status) showRequestStatus(config.status);
      clearError();
      var operationResult;
      try {
        operationResult = operation();
      } catch (error) {
        operationResult = Promise.reject(error);
      }
      return Promise.resolve(operationResult)
        .then(function handleSuccess(result) {
          if (requestIsCurrent(action, id, generation) && onSuccess) {
            onSuccess(result);
          }
          return result;
        })
        .catch(function handleError(error) {
          if (requestIsCurrent(action, id, generation)) {
            if (config.onError) {
              config.onError(error);
            } else {
              showError(displayText(error && error.message, '请求失败'));
            }
          }
          return undefined;
        })
        .finally(function finishRequest() {
          var current = state.inFlight.get(action);
          if (current && current.id === id) {
            state.inFlight.delete(action);
            if (config.clearCloud) {
              refs.allowCloud.checked = false;
              renderPrivacy();
            }
            if (config.clearDoiConsent) refs.doiConsent.checked = false;
            if (config.clearCodexConsent) refs.codexConsent.checked = false;
            setText(refs.requestStatus, '');
            renderControls();
          }
          if (config.onFinally && contextIsCurrent(generation)) config.onFinally();
        });
    }

    function renderContext() {
      var current = state.context;
      if (!current) {
        setText(refs.paperTitle, '未选择文献');
        setText(refs.paperStatus, '未选择文献 · 默认敏感（仅本地）');
        setText(refs.contextMeta, '');
        return;
      }
      setText(refs.paperTitle, current.title || '(无标题)');
      var privacy = currentSensitivity() === 'public' ? '公开' : '敏感（仅本地）';
      setText(refs.paperStatus, '当前文献 · ' + displayText(current.item_key, '未知') + ' · ' + privacy);
      setText(
        refs.contextMeta,
        'library ' + displayText(current.library_id, '未知') + ' · attachment ' + displayText(current.attachment_key, '未知'),
      );
    }

    function renderSelection() {
      var selected = state.selection;
      if (!selected || !displayText(selected.text).trim()) {
        setText(refs.selectionSnapshot, '暂无选文');
        refs.selectionPage.hidden = true;
        setText(refs.selectionMeta, '');
        return;
      }
      setText(refs.selectionSnapshot, selected.text);
      setText(refs.selectionPage, formatPage(selected.page, selected.page_label));
      refs.selectionPage.setAttribute('data-page', displayText(selected.page, ''));
      refs.selectionPage.setAttribute('data-attachment-key', displayText(selected.attachment_key, ''));
      refs.selectionPage.hidden = false;
      var position = selected.position ? ' · 已捕获坐标' : '';
      setText(refs.selectionMeta, 'attachment ' + displayText(selected.attachment_key, '未知') + position);
    }

    function renderPrivacy() {
      var publicMode = currentSensitivity() === 'public';
      if (!publicMode) refs.allowCloud.checked = false;
      refs.allowCloud.disabled = !publicMode || !state.context;
      refs.forceHeavy.disabled = !refs.allowHeavy.checked;
      if (!refs.allowHeavy.checked) refs.forceHeavy.checked = false;
      if (publicMode && refs.allowCloud.checked) {
        setText(refs.privacySummary, '本次明确允许：问题、选文和检索证据可发送到云端；notes 不包含在此授权内。');
      } else if (publicMode) {
        setText(refs.privacySummary, '公开论文仍按本地处理；只有勾选上方选项才允许本次云端处理。');
      } else {
        setText(refs.privacySummary, '敏感内容不会发送到云端。');
      }
      renderContext();
    }

    function modelModeAllowed() {
      var mode = refs.mode.value;
      if (!MODEL_MODES[mode]) return true;
      if (state.localModel === true) return true;
      if (state.localModel === false && state.externalModel === true && cloudOptIn()) return true;
      return state.localModel === undefined && state.externalModel === undefined;
    }

    function renderHealth() {
      var health = state.health;
      if (!health) return;
      var reachable = health.zotero ? health.zotero.reachable !== false : true;
      var connected = health.status === 'ok' && reachable;
      setText(refs.healthStatus, connected ? '已连接' : '连接异常/受限');
      refs.healthStatus.classList.toggle('zrp-status-ok', connected);
      refs.healthStatus.classList.toggle('zrp-status-bad', !connected);
      var models = isObject(health.models) ? health.models : {};
      state.localModel = modelConfigured(models.local);
      state.externalModel = modelConfigured(models.external);
      setText(refs.modelLocal, '本地模型配置：' + modelName(models.local));
      setText(refs.modelExternal, '云端模型配置：' + modelName(models.external));
      refs.modelLocal.setAttribute('title', 'health.models 仅表示配置状态，不代表联网可用性');
      refs.modelExternal.setAttribute('title', 'health.models 仅表示配置状态，不代表联网可用性');
      if (state.localModel === false && state.externalModel === false) {
        setText(refs.noModelNotice, '当前没有配置模型；精读/问答/解释仍可显示证据摘录，翻译和模拟审稿不会伪称完成。');
        refs.noModelNotice.hidden = false;
      } else if (state.localModel === false) {
        setText(refs.noModelNotice, '本地模型未配置；云端模型名称仅表示配置状态，只有公开内容与本次明确同意时才会使用。');
        refs.noModelNotice.hidden = false;
      } else {
        refs.noModelNotice.hidden = true;
      }
      renderControls();
    }

    function renderControls() {
      var hasContext = Boolean(state.context);
      var analysisBusy = isAnalysisBusy();
      var questionRequired = refs.mode.value === 'question' && !refs.question.value.trim();
      refs.analysisSubmit.disabled = !hasContext || analysisBusy || questionRequired || !modelModeAllowed();
      refs.notePreviewSubmit.disabled = !hasContext || !state.analysis || state.inFlight.has('notePreview');
      refs.noteSave.disabled = !state.notePreview || state.inFlight.has('authorizeWrite') || state.inFlight.has('writeNote');
      refs.noteWriteConfirm.disabled = !state.writeAuthorization || !state.writeAuthorization.authorized || state.writeAttempted || state.inFlight.has('writeNote');
      refs.highlightCommit.disabled = !state.highlightPreview || state.highlightCommitAttempted || state.inFlight.has('highlightCommit');
      refs.revokeCodex.hidden = false;
      refs.revokeCodex.disabled = !hasContext || state.inFlight.has('revokeCloud');
      var grantBusy = state.inFlight.has('grantCloud');
      var grantReady = hasContext && refs.codexConsent.checked && !grantBusy && !state.cloudGrant;
      var grantButton = root.querySelector('[data-testid="grant-codex"]');
      if (grantButton) {
        grantButton.disabled = !grantReady;
        grantButton.hidden = Boolean(state.cloudGrant);
      }
      refs.noteTitle.disabled = !hasContext;
      refs.codexConsent.disabled = !hasContext || state.inFlight.has('grantCloud') || state.inFlight.has('revokeCloud');
      refs.doiInput.disabled = state.inFlight.has('doiAudit');
      refs.doiConsent.disabled = state.inFlight.has('doiAudit');
      var doiButton = root.querySelector('[data-testid="doi-submit"]');
      if (doiButton) doiButton.disabled = state.inFlight.has('doiAudit');
    }

    function isAnalysisBusy() {
      return [
        'analysis',
        'notePreview',
        'authorizeWrite',
        'writeNote',
        'highlightPrepare',
        'highlightCommit',
        'grantCloud',
        'revokeCloud',
      ].some(function hasBusyAction(action) {
        return state.inFlight.has(action);
      });
    }

    function invalidateDocumentRequests() {
      var healthRequest = state.inFlight.get('health');
      state.inFlight.clear();
      if (healthRequest) state.inFlight.set('health', healthRequest);
    }

    function clearGrantExpiryTimer() {
      if (state.grantExpiryTimer !== null && typeof view.clearTimeout === 'function') {
        view.clearTimeout(state.grantExpiryTimer);
      }
      state.grantExpiryTimer = null;
    }

    function grantExpiryMs(grant) {
      if (!grant || grant.expires_at === undefined || grant.expires_at === null) return null;
      var timestamp = Date.parse(String(grant.expires_at));
      return Number.isFinite(timestamp) ? timestamp : null;
    }

    function scheduleGrantExpiry(grant, generation) {
      clearGrantExpiryTimer();
      var expiry = grantExpiryMs(grant);
      if (expiry === null || typeof view.setTimeout !== 'function') return;
      var delay = expiry - Date.now();
      if (delay <= 0) {
        if (contextIsCurrent(generation) && state.cloudGrant === grant) {
          state.cloudGrant = null;
          state.cloudStatusMessage = '当前面板中的授权回执已到期；可对当前文献执行撤销。';
          renderCloudGrant();
        }
        return;
      }
      state.grantExpiryTimer = view.setTimeout(function expireGrant() {
        state.grantExpiryTimer = null;
        if (contextIsCurrent(generation) && state.cloudGrant === grant) {
          state.cloudGrant = null;
          state.cloudStatusMessage = '当前面板中的授权回执已到期；可对当前文献执行撤销。';
          renderCloudGrant();
        }
      }, Math.min(delay, 2147483647));
    }

    function clearDocumentPreviews() {
      state.analysis = null;
      state.notePreview = null;
      state.writeAuthorization = null;
      state.writeAttempted = false;
      state.highlightPreview = null;
      state.highlightCommitted = false;
      state.highlightCommitAttempted = false;
      refs.analysisResult.hidden = true;
      refs.highlightPreview.hidden = true;
      refs.notePreview.hidden = true;
      refs.writeConfirmation.hidden = true;
      clearChildren(refs.sectionList);
      clearChildren(refs.evidenceList);
      setText(refs.analysisMeta, '');
      setText(refs.analysisNotice, '');
      refs.analysisNotice.hidden = true;
      setText(refs.highlightText, '');
      setText(refs.highlightMeta, '');
      setText(refs.highlightStatus, '');
      setText(refs.notePreviewText, '');
      setText(refs.notePreviewMeta, '');
      setText(refs.writeSummary, '');
      setText(refs.noteStatus, '');
    }

    function normalizeAnalysis(result, requestedMode, requestedAllowCloud) {
      var analysis = isObject(result) ? result : {};
      var requestedLocation = analysis.processing_location;
      var processingLocation = requestedLocation === 'local' || requestedLocation === 'external' || requestedLocation === 'none'
        ? requestedLocation
        : 'none';
      var warnings = Array.isArray(analysis.warnings) ? analysis.warnings.slice() : [];
      var privacyAnomaly = false;
      if (processingLocation === 'external' && !requestedAllowCloud) {
        privacyAnomaly = true;
        warnings.push('隐私异常：服务报告了未经本次明确同意的云端处理；已拒绝显示模型结论。请检查 bridge 配置。');
      }
      return {
        item_key: analysis.item_key,
        attachment_key: analysis.attachment_key || (state.context && state.context.attachment_key),
        title: analysis.title || (state.context && state.context.title),
        task: analysis.task,
        mode: analysis.mode || requestedMode || refs.mode.value,
        generated_by: analysis.generated_by,
        sensitivity: analysis.sensitivity || currentSensitivity(),
        processing_location: processingLocation,
        privacy_anomaly: privacyAnomaly,
        sections: Array.isArray(analysis.sections) ? analysis.sections : [],
        evidence: Array.isArray(analysis.evidence) ? analysis.evidence : [],
        warnings: warnings,
      };
    }

    function renderEvidence(evidence) {
      clearChildren(refs.evidenceList);
      if (!evidence.length) {
        refs.evidenceList.appendChild(createElement(document, 'div', { className: 'zrp-meta' }, '暂无可定位证据。'));
        return;
      }
      evidence.forEach(function renderOneEvidence(span, index) {
        var evidenceId = displayText(span && span.evidence_id, 'evidence-' + String(index + 1));
        var card = createElement(document, 'article', {
          className: 'zrp-evidence',
          'data-testid': 'evidence-' + evidenceId,
          'data-evidence-id': evidenceId,
        });
        var top = createElement(document, 'div', { className: 'zrp-row zrp-row-between' });
        top.appendChild(createElement(document, 'span', { className: 'zrp-evidence-id' }, evidenceId));
        var pageButton = addButton(top, 'evidence-page-' + evidenceId, formatPage(span && span.page, span && span.page_label), 'navigate-evidence', 'zrp-page-button');
        pageButton.setAttribute('data-evidence-id', evidenceId);
        pageButton.setAttribute('data-page', displayText(span && span.page, ''));
        pageButton.setAttribute('data-attachment-key', displayText((state.analysis && state.analysis.attachment_key) || (state.context && state.context.attachment_key), ''));
        card.appendChild(top);
        card.appendChild(createElement(document, 'pre', { className: 'zrp-quote' }, span && span.text));
        var footer = createElement(document, 'div', { className: 'zrp-row zrp-evidence-footer' });
        var score = span && span.score !== undefined ? '相关度 ' + displayText(span.score) : '';
        footer.appendChild(createElement(document, 'span', { className: 'zrp-meta' }, score));
        var highlight = addButton(footer, 'highlight-' + evidenceId, '准备高亮', 'highlight-prepare', 'zrp-button zrp-button-quiet');
        highlight.setAttribute('data-evidence-id', evidenceId);
        card.appendChild(footer);
        refs.evidenceList.appendChild(card);
      });
    }

    function renderAnalysis() {
      var result = state.analysis;
      refs.analysisResult.hidden = !result;
      if (!result) return;
      var resultMode = result.mode || refs.mode.value;
      var locationLabel = result.privacy_anomaly
        ? '隐私异常（拒绝显示模型结论）'
        : result.processing_location === 'local'
        ? '本地模型'
        : result.processing_location === 'external'
          ? '云端模型（本次已同意）'
          : '仅证据摘录';
      setText(
        refs.analysisMeta,
        displayText(result.task || MODE_LABELS[resultMode], '研究结果') + ' · 处理位置：' + locationLabel,
      );
      clearChildren(refs.sectionList);
      var evidenceOnly = result.processing_location === 'none' || result.privacy_anomaly;
      if (result.privacy_anomaly) {
        setText(refs.analysisNotice, '隐私异常：服务报告了未经本次明确同意的云端处理；已拒绝显示模型结论。请检查 bridge 配置。');
        refs.analysisNotice.hidden = false;
      } else if (evidenceOnly && MODEL_MODES[resultMode]) {
        setText(refs.analysisNotice, '当前没有可用模型，以下仅保留页码证据摘录；未完成' + MODE_LABELS[resultMode] + '。');
        refs.analysisNotice.hidden = false;
      } else if (evidenceOnly) {
        setText(refs.analysisNotice, '当前没有可用模型，以下仅显示页码证据摘录。');
        refs.analysisNotice.hidden = false;
      } else if (result.warnings.length) {
        setText(refs.analysisNotice, result.warnings.join('；'));
        refs.analysisNotice.hidden = false;
      } else {
        refs.analysisNotice.hidden = true;
      }
      if (!evidenceOnly) {
        if (result.sections.length) {
          result.sections.forEach(function renderSection(section) {
            var article = createElement(document, 'article', { className: 'zrp-analysis-section' });
            article.appendChild(createElement(document, 'h3', { className: 'zrp-section-title' }, section && section.title));
            article.appendChild(createElement(document, 'pre', { className: 'zrp-analysis-content' }, section && (section.content || section.summary)));
            var ids = section && section.evidence_ids;
            if (Array.isArray(ids) && ids.length) {
              article.appendChild(createElement(document, 'div', { className: 'zrp-meta' }, '证据：' + ids.map(function idText(id) {
                return displayText(id);
              }).join('、')));
            }
            refs.sectionList.appendChild(article);
          });
        } else {
          refs.sectionList.appendChild(createElement(document, 'div', { className: 'zrp-meta' }, '暂无模型结论，仅显示下方证据。'));
        }
      }
      renderEvidence(result.evidence);
      renderControls();
    }

    function renderHighlight() {
      var preview = state.highlightPreview;
      refs.highlightPreview.hidden = !preview;
      if (!preview) return;
      setText(refs.highlightText, preview.text);
      setText(refs.highlightMeta, formatPage(preview.page, preview.page_label) + ' · 颜色 ' + displayText(preview.color, '未指定') + ' · ' + formatExpiry(preview.expires_at));
      if (state.highlightCommitted) {
        setText(refs.highlightStatus, '高亮已提交。');
      } else if (state.highlightCommitAttempted) {
        setText(refs.highlightStatus, '写入结果未知，未自动重试。');
      } else {
        setText(refs.highlightStatus, '请核对精确原文、页码和颜色后再确认。');
      }
      renderControls();
    }

    function renderNote() {
      var preview = state.notePreview;
      refs.notePreview.hidden = !preview;
      refs.writeConfirmation.hidden = !(state.writeAuthorization && state.writeAuthorization.authorized);
      if (preview) {
        setText(refs.notePreviewText, preview.note_text || preview.note_html);
        setText(refs.notePreviewMeta, '校验码：' + displayText(preview.digest, '未知') + ' · ' + formatExpiry(preview.expires_at));
      }
      if (state.writeAuthorization && state.writeAuthorization.authorized && preview) {
        setText(
          refs.writeSummary,
          '将写入 Zotero 子笔记\n标题：' + displayText(preview.title) + '\n校验码：' + displayText(preview.digest) + '\n' + formatExpiry(preview.expires_at),
        );
      }
      renderControls();
    }

    function renderCloudGrant() {
      if (state.cloudGrant && grantExpiryMs(state.cloudGrant) !== null && grantExpiryMs(state.cloudGrant) <= Date.now()) {
        clearGrantExpiryTimer();
        state.cloudGrant = null;
        state.cloudStatusMessage = '当前面板中的授权回执已到期；可对当前文献执行撤销。';
      }
      if (!state.cloudGrant) {
        setText(refs.cloudStatus, state.cloudStatusMessage || '授权状态未在本面板保留；可对当前文献执行撤销。');
        renderControls();
        return;
      }
      state.cloudStatusMessage = '';
      setText(refs.cloudStatus, '已授权读取公开论文至 ' + displayText(state.cloudGrant.expires_at, '未知时间') + '（不包含 notes）');
      renderControls();
    }

    function buildNoteContent() {
      var result = state.analysis;
      if (!result) return '';
      var lines = [];
      if (result.processing_location !== 'none' && !result.privacy_anomaly) {
        result.sections.forEach(function sectionLine(section) {
          lines.push(displayText(section && section.title, '未命名部分'));
          lines.push(displayText(section && (section.content || section.summary)));
          if (section && Array.isArray(section.evidence_ids) && section.evidence_ids.length) {
            lines.push('证据链：' + section.evidence_ids.map(function sectionEvidenceId(id) {
              return displayText(id);
            }).join('、'));
          }
        });
      }
      if (result.evidence.length) {
        lines.push('页码证据');
        result.evidence.forEach(function evidenceLine(span) {
          var evidenceId = displayText(span && span.evidence_id, '未知证据');
          var physicalPage = '物理页码 ' + displayText(span && span.page, '未知');
          var source = displayText(span && span.source, '未知来源');
          lines.push('[' + evidenceId + '] ' + physicalPage + ' · source: ' + source);
          lines.push(displayText(span && span.text));
        });
      }
      return lines.filter(function nonEmpty(line) {
        return line !== '';
      }).join('\n\n');
    }

    function citationStatusText(status) {
      var key = displayText(status, 'unknown').trim().toLowerCase();
      var labels = {
        ok: '通过',
        valid: '有效',
        verified: '已核验',
        matched: '信息匹配',
        mismatch: '信息不一致',
        not_found: '未找到',
        notfound: '未找到',
        retracted: '发现撤稿/撤回风险',
        withdrawn: '发现撤稿/撤回风险',
        unknown: '未知（不能据此确认无撤稿）',
        error: '核验失败',
      };
      return labels[key] || displayText(status, '未知');
    }

    function citationIssues(result) {
      if (!isObject(result)) return '无';
      var issues = result.issues;
      if (issues === undefined || issues === null || issues === '') return '无';
      if (Array.isArray(issues)) {
        if (!issues.length) return '无';
        return issues.map(function issueText(issue) {
          return displayText(issue);
        }).join('；');
      }
      return displayText(issues);
    }

    function renderCitationAudit(report) {
      if (!isObject(report) || !Array.isArray(report.results)) {
        return '核验结果格式异常：未收到 results 数组。';
      }
      var lines = [];
      if (report.status !== undefined) lines.push('报告状态：' + citationStatusText(report.status));
      if (!report.results.length) {
        lines.push('本次没有返回 DOI 结果；未知状态不能表述为无撤稿。');
      }
      report.results.forEach(function renderCitationResult(result, index) {
        if (!isObject(result)) {
          lines.push('结果 ' + String(index + 1) + '：' + displayText(result));
          return;
        }
        lines.push('DOI：' + displayText(result.doi, '未知'));
        lines.push('状态：' + citationStatusText(result.status));
        lines.push('问题：' + citationIssues(result));
        if (result.details !== undefined) lines.push('详情：' + safeJson(result.details));
      });
      if (Array.isArray(report.warnings) && report.warnings.length) {
        lines.push('提醒：' + report.warnings.map(function warningText(warning) {
          return displayText(warning);
        }).join('；'));
      }
      return lines.join('\n');
    }

    function rpc(method, params) {
      if (!rpcAdapter || typeof rpcAdapter.rpc !== 'function') {
        return Promise.reject(new Error('RPC adapter 未提供 rpc 方法'));
      }
      return rpcAdapter.rpc(method, params);
    }

    function runAnalyze() {
      if (destroyed || !state.context || isAnalysisBusy()) return;
      var mode = refs.mode.value;
      var question = refs.question.value.trim();
      if (mode === 'question' && !question) {
        showError('问答模式需要先填写问题。');
        refs.question.focus();
        return;
      }
      if (!modelModeAllowed()) {
        showError('当前没有可用模型；' + MODE_LABELS[mode] + '不会伪称完成，请改用证据摘录模式。');
        return;
      }
      var current = cloneObject(state.context);
      var generation = state.contextGeneration;
      var selected = state.selection && state.selection.attachment_key === current.attachment_key
        ? cloneObject(state.selection)
        : null;
      invalidateDocumentRequests();
      clearDocumentPreviews();
      var params = {
        item_key: current.item_key,
        attachment_key: current.attachment_key,
        mode: mode,
        sensitivity: currentSensitivity(),
        allow_cloud: cloudOptIn(),
        allow_heavy_fallback: refs.allowHeavy.checked,
        force_heavy: refs.forceHeavy.checked,
      };
      if (question) params.question = question;
      if (selected) {
        params.selected_text = selected.text;
        params.selection_page = selected.page;
      }
      return runRequest(
        'analysis',
        generation,
        function requestAnalysis() {
          return rpc('analyze', params);
        },
        function acceptAnalysis(result) {
          state.analysis = normalizeAnalysis(result, mode, params.allow_cloud);
          renderAnalysis();
        },
        { status: '分析请求中…', clearCloud: true },
      );
    }

    function navigateTo(attachmentKey, page) {
      if (destroyed || !rpcAdapter || typeof rpcAdapter.navigate !== 'function') {
        showError('当前没有可用的 PDF 导航适配器。');
        return;
      }
      try {
        rpcAdapter.navigate(attachmentKey, Number(page));
      } catch (error) {
        showError(displayText(error && error.message, 'PDF 导航失败'));
      }
    }

    function getEvidenceById(evidenceId) {
      if (!state.analysis) return null;
      return state.analysis.evidence.find(function matchesEvidence(span, index) {
        return displayText(span && span.evidence_id, 'evidence-' + String(index + 1)) === evidenceId;
      }) || null;
    }

    function runHighlightPrepare(evidenceId) {
      if (destroyed || !state.context || state.inFlight.has('highlightPrepare')) return;
      var evidence = getEvidenceById(evidenceId);
      if (!evidence) {
        showError('找不到这条证据，未准备高亮。');
        return;
      }
      var generation = state.contextGeneration;
      var attachmentKey = (state.analysis && state.analysis.attachment_key) || state.context.attachment_key;
      var selection = state.selection && state.selection.attachment_key === attachmentKey ? cloneObject(state.selection) : undefined;
      var request = {
        attachment_key: attachmentKey,
        page: evidence.page,
        quote: displayText(evidence.text),
      };
      if (selection) request.selection = selection;
      state.highlightPreview = null;
      state.highlightCommitted = false;
      state.highlightCommitAttempted = false;
      renderHighlight();
      return runRequest(
        'highlightPrepare',
        generation,
        function prepare() {
          if (typeof rpcAdapter.prepareHighlight !== 'function') {
            return Promise.reject(new Error('adapter 未提供 prepareHighlight'));
          }
          return rpcAdapter.prepareHighlight(request);
        },
        function acceptPreview(result) {
          if (!isObject(result) || !result.token || !result.digest) {
            showError('高亮预览返回不完整，未提供写入按钮。');
            return;
          }
          state.highlightPreview = cloneObject(result);
          renderHighlight();
        },
        { status: '正在核对高亮坐标…' },
      );
    }

    function runHighlightCommit() {
      if (destroyed || !state.highlightPreview || state.highlightCommitAttempted || state.inFlight.has('highlightCommit')) return;
      var generation = state.contextGeneration;
      var preview = cloneObject(state.highlightPreview);
      state.highlightCommitAttempted = true;
      renderHighlight();
      return runRequest(
        'highlightCommit',
        generation,
        function commit() {
          if (typeof rpcAdapter.commitHighlight !== 'function') {
            return Promise.reject(new Error('adapter 未提供 commitHighlight'));
          }
          return rpcAdapter.commitHighlight(preview);
        },
        function acceptCommit(result) {
          if (isObject(result) && (result.status === 'created' || result.status === 'ok' || result.committed === true)) {
            state.highlightCommitted = true;
            setText(refs.highlightStatus, '高亮已提交。');
          } else {
            setText(refs.highlightStatus, '写入结果未知，未自动重试。');
          }
          renderHighlight();
        },
        {
          status: '正在写入高亮…',
          onError: function highlightWriteError(error) {
            setText(refs.highlightStatus, '写入结果未知，未自动重试。');
            showError(displayText(error && error.message, '高亮写入结果未知；未自动重试。'));
            renderHighlight();
          },
        },
      );
    }

    function runNotePreview() {
      if (destroyed || !state.context || !state.analysis || state.inFlight.has('notePreview')) return;
      var generation = state.contextGeneration;
      var current = cloneObject(state.context);
      var title = refs.noteTitle.value.trim() || (displayText(current.title, '科研文献') + ' — 阅读笔记');
      var content = buildNoteContent();
      state.notePreview = null;
      state.writeAuthorization = null;
      state.writeAttempted = false;
      renderNote();
      var params = {
        parent_item_key: current.item_key,
        title: title,
        content: content,
      };
      return runRequest(
        'notePreview',
        generation,
        function preview() {
          return rpc('preview_note', params);
        },
        function acceptPreview(result) {
          if (!isObject(result) || !result.preview_token || !result.digest) {
            showError('笔记预览返回不完整，未提供保存按钮。');
            return;
          }
          state.notePreview = cloneObject(result);
          setInputValue(refs.noteTitle, result.title || title);
          renderNote();
        },
        { status: '正在生成笔记预览…' },
      );
    }

    function runAuthorizeWrite() {
      if (destroyed || !state.notePreview || state.inFlight.has('authorizeWrite') || state.inFlight.has('writeNote')) return;
      var generation = state.contextGeneration;
      return runRequest(
        'authorizeWrite',
        generation,
        function authorize() {
          return rpc('authorize_write', {});
        },
        function acceptAuthorization(result) {
          if (isObject(result) && result.authorized === true) {
            state.writeAuthorization = cloneObject(result);
            setText(refs.noteStatus, 'Zotero 已授权本次本地写入；请再次确认预览内容和校验码。');
            renderNote();
          } else {
            state.writeAuthorization = null;
            setText(refs.noteStatus, 'Zotero 未授权写入；未执行 write_note。');
            showError(displayText(result && result.detail, '写入未获授权，未执行 write_note。'));
            renderNote();
          }
        },
        { status: '正在请求 Zotero 原生写入授权…' },
      );
    }

    function runWriteNote() {
      if (destroyed || !state.notePreview || !state.writeAuthorization || !state.writeAuthorization.authorized || state.writeAttempted || state.inFlight.has('writeNote')) return;
      var generation = state.contextGeneration;
      var preview = cloneObject(state.notePreview);
      state.writeAttempted = true;
      renderNote();
      var params = {
        preview_token: preview.preview_token,
        expected_digest: preview.digest,
        confirmed_by_user: true,
      };
      return runRequest(
        'writeNote',
        generation,
        function write() {
          return rpc('write_note', params);
        },
        function acceptWrite(result) {
          if (isObject(result) && result.status === 'created') {
            setText(refs.noteStatus, '笔记已写入 Zotero。');
          } else {
            setText(refs.noteStatus, '写入结果未知，未自动重试。');
            showError('write_note 返回未知结果；未自动重试。');
          }
          renderNote();
        },
        {
          status: '正在写入 Zotero 笔记…',
          onError: function noteWriteError(error) {
            setText(refs.noteStatus, '写入结果未知，未自动重试。');
            showError(displayText(error && error.message, '笔记写入结果未知；未自动重试。'));
            renderNote();
          },
        },
      );
    }

    function runDoiAudit() {
      if (destroyed || state.inFlight.has('doiAudit')) return;
      var requests = parseDois(refs.doiInput.value);
      if (!requests.length) {
        setText(refs.doiStatus, '请先输入至少一个 DOI。');
        return;
      }
      if (!refs.doiConsent.checked) {
        setText(refs.doiStatus, '未获得本次公网核验同意，未发送 DOI。');
        return;
      }
      var generation = state.contextGeneration;
      return runRequest(
        'doiAudit',
        generation,
        function audit() {
          return rpc('audit_citations', { requests: requests, allow_network: true });
        },
        function acceptAudit(result) {
          setText(refs.doiStatus, renderCitationAudit(result));
        },
        {
          status: '正在使用公网公开元数据核验…',
          clearDoiConsent: true,
        },
      );
    }

    function runGrantCloud() {
      if (destroyed || !state.context || !refs.codexConsent.checked || state.cloudGrant || state.inFlight.has('grantCloud')) return;
      var generation = state.contextGeneration;
      var itemKey = state.context.item_key;
      return runRequest(
        'grantCloud',
        generation,
        function grant() {
          return rpc('grant_cloud_access', {
            item_key: itemKey,
            confirmed_public: true,
            include_notes: false,
          });
        },
        function acceptGrant(result) {
          if (isObject(result) && (result.granted === true || result.expires_at)) {
            state.cloudGrant = cloneObject(result);
            state.cloudStatusMessage = '';
            scheduleGrantExpiry(state.cloudGrant, generation);
            renderCloudGrant();
          } else {
            showError('公开论文读取授权返回不完整，未标记为已授权。');
          }
        },
        {
          status: '正在申请 Codex 十分钟读取授权…',
          clearCodexConsent: true,
        },
      );
    }

    function runRevokeCloud() {
      if (destroyed || !state.context || state.inFlight.has('revokeCloud')) return;
      var generation = state.contextGeneration;
      var itemKey = state.context.item_key;
      return runRequest(
        'revokeCloud',
        generation,
        function revoke() {
          return rpc('revoke_cloud_access', { item_key: itemKey });
        },
        function acceptRevoke(result) {
          if (isObject(result) && result.revoked === true) {
            clearGrantExpiryTimer();
            state.cloudGrant = null;
            state.cloudStatusMessage = '当前文献读取授权已撤销。';
            renderCloudGrant();
          } else {
            state.cloudStatusMessage = '撤销结果未知；当前面板未改变授权状态。';
            setText(refs.cloudStatus, state.cloudStatusMessage);
            showError('撤销结果未知；当前面板未改变授权状态。');
          }
        },
        { status: '正在撤销 Codex 读取授权…' },
      );
    }

    function openSettings() {
      if (destroyed || typeof rpcAdapter.openSettings !== 'function') {
        showError('当前没有可用的设置适配器。');
        return;
      }
      try {
        rpcAdapter.openSettings();
      } catch (error) {
        showError(displayText(error && error.message, '打开设置失败'));
      }
    }

    function loadHealth() {
      if (destroyed || state.inFlight.has('health')) return;
      var generation = state.contextGeneration;
      return runRequest(
        'health',
        generation,
        function getHealth() {
          return rpc('health', {});
        },
        function acceptHealth(result) {
          state.health = isObject(result) ? result : {};
          renderHealth();
        },
        {
          status: '',
          onError: function healthError(error) {
            setText(refs.healthStatus, '连接失败');
            refs.healthStatus.classList.remove('zrp-status-ok');
            refs.healthStatus.classList.add('zrp-status-bad');
            setText(refs.noModelNotice, '无法读取模型配置；不会假称翻译或模拟审稿完成。');
            refs.noModelNotice.hidden = false;
            showError(displayText(error && error.message, 'health 请求失败'));
            renderControls();
          },
        },
      );
    }

    function onClick(event) {
      if (destroyed) return;
      var target = getActionTarget(event.target, root);
      if (!target) return;
      var action = target.getAttribute('data-zrp-action');
      if (action === 'analysis') runAnalyze();
      else if (action === 'navigate-selection') navigateTo(target.getAttribute('data-attachment-key'), target.getAttribute('data-page'));
      else if (action === 'navigate-evidence') navigateTo(target.getAttribute('data-attachment-key'), target.getAttribute('data-page'));
      else if (action === 'highlight-prepare') runHighlightPrepare(target.getAttribute('data-evidence-id'));
      else if (action === 'highlight-commit') runHighlightCommit();
      else if (action === 'note-preview') runNotePreview();
      else if (action === 'note-save') runAuthorizeWrite();
      else if (action === 'note-write-confirm') runWriteNote();
      else if (action === 'doi-audit') runDoiAudit();
      else if (action === 'grant-codex') runGrantCloud();
      else if (action === 'revoke-codex') runRevokeCloud();
      else if (action === 'settings') openSettings();
    }

    function onChange(event) {
      if (destroyed) return;
      var target = event.target;
      if (target === refs.sensitivitySensitive || target === refs.sensitivityPublic) {
        renderPrivacy();
        renderControls();
      } else if (target === refs.allowHeavy) {
        renderPrivacy();
        renderControls();
      } else if (target === refs.allowCloud) {
        renderPrivacy();
        renderControls();
      } else if (target === refs.mode || target === refs.question) {
        renderControls();
      } else if (target === refs.codexConsent) {
        renderControls();
      }
    }

    function onInput(event) {
      if (destroyed) return;
      if (event.target === refs.question) renderControls();
    }

    function setContext(nextContext) {
      if (destroyed) return;
      state.contextGeneration += 1;
      invalidateDocumentRequests();
      state.context = nextContext ? cloneObject(nextContext) : null;
      state.selection = null;
      clearGrantExpiryTimer();
      state.cloudGrant = null;
      state.cloudStatusMessage = '';
      refs.sensitivitySensitive.checked = true;
      refs.sensitivityPublic.checked = false;
      refs.allowCloud.checked = false;
      refs.codexConsent.checked = false;
      refs.doiConsent.checked = false;
      if (state.context) setInputValue(refs.noteTitle, displayText(state.context.title, '科研文献') + ' — 阅读笔记');
      else setInputValue(refs.noteTitle, '');
      clearDocumentPreviews();
      clearError();
      setText(refs.requestStatus, '');
      renderContext();
      renderSelection();
      renderPrivacy();
      renderCloudGrant();
      renderControls();
    }

    function setSelection(nextSelection) {
      if (destroyed) return;
      state.selection = nextSelection ? cloneObject(nextSelection) : null;
      renderSelection();
    }

    function focusQuestion() {
      if (destroyed || !refs.question) return;
      refs.question.focus();
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      state.contextGeneration += 1;
      state.inFlight.clear();
      clearGrantExpiryTimer();
      cleanups.splice(0).forEach(function cleanupListener(cleanup) {
        cleanup();
      });
      if (root.parentNode) root.parentNode.removeChild(root);
    }

    buildUi();
    refs.analysisResult = root.querySelector('[data-testid="analysis-result"]');
    listen(root, 'click', onClick);
    listen(root, 'change', onChange);
    listen(root, 'input', onInput);
    renderContext();
    renderSelection();
    renderPrivacy();
    renderControls();
    loadHealth();

    return {
      setContext: setContext,
      setSelection: setSelection,
      focusQuestion: focusQuestion,
      destroy: destroy,
    };
  }

  var publicApi = { mount: mount };
  global.ZoteroResearchPanel = publicApi;
  if (typeof module !== 'undefined' && module.exports) module.exports = publicApi;
}(typeof globalThis !== 'undefined' ? globalThis : this));
