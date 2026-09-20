// ==UserScript==
// @name         Zotero 网页 AI 中继
// @namespace    zotero-research
// @version      1.1.1
// @updateURL    https://github.com/daxiaxiong88/zotero-research/releases/latest/download/zotero-research-webai.meta.js
// @downloadURL  https://github.com/daxiaxiong88/zotero-research/releases/latest/download/zotero-research-webai.user.js
// @supportURL   https://github.com/daxiaxiong88/zotero-research/issues
// @description  网页 AI 回答流自动回传 Zotero，并提供对话时间轴与星标；支持 Gemini、DeepSeek、ChatGPT、Kimi、Claude、AI Studio。
// @match        https://gemini.google.com/*
// @match        https://aistudio.google.com/*
// @match        https://chat.deepseek.com/*
// @match        https://chatgpt.com/*
// @match        https://www.kimi.com/*
// @match        https://kimi.moonshot.cn/*
// @match        https://claude.ai/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @grant        GM_registerMenuCommand
// @grant        GM_notification
// @grant        unsafeWindow
// @connect      127.0.0.1
// @connect      raw.githubusercontent.com
// @run-at       document-start
// @noframes
// ==/UserScript==
