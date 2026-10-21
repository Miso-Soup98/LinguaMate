# 语伴 LinguaMate

在 YouTube 上用双语字幕、悬停词典和生词本学习外语的 Chrome 插件。

A Chrome extension for learning languages on YouTube with bilingual subtitles, a hover dictionary, and a vocabulary notebook.

## 中文

### 能做什么

- YouTube 双语字幕：学习语言加母语对照
- 优先使用视频自带字幕；没有对应语言时，用 YouTube 翻译轨道生成译文
- 鼠标悬停单词即可查词，卡片包含音标、美式 / 英式朗读、词性、释义和例句
- 右键单词直接加入生词本
- 听写模式：字幕默认隐藏，鼠标悬停才显示
- 逐句暂停，以及 A / S / D 上一句、重播、下一句（按住可预览）
- 右侧字幕列表会随页面滚动，不挡住推荐视频
- 打开或关闭播放器 CC 时自动重新读取字幕
- 生词本、间隔重复闪卡，可导出 CSV / Anki
- 任意网页：右键「用语伴查阅」或「用语伴阅读」

### 范围

- 用于 YouTube 和普通网页。Netflix 字幕受版权和 DRM 保护，本插件不会拦截或复制。

### 安装

1. 打开 Chrome，进入 `chrome://extensions`
2. 打开右上角「开发者模式」
3. 点击「加载已解压的扩展程序」
4. 选择本文件夹
5. 打开任意带字幕的 YouTube 视频

首次使用时，在插件弹窗里把「学习语言」设为视频语言，把「母语 / 译文」设成你的母语。更新插件后，在扩展管理页点一次刷新，再刷新正在观看的视频页。

### 快捷键

| 按键 | 作用 |
| --- | --- |
| A | 上一句。按住会暂停预览 |
| S | 重播当前句。按住会暂停预览 |
| D | 下一句。按住会暂停预览 |
| 悬停单词 | 打开词典卡片 |
| 右键单词 | 直接加入生词本 |

### 权限说明

- `storage`：保存设置和生词
- `contextMenus` / `activeTab` / `scripting`：网页阅读
- YouTube、翻译接口和词典接口：拉取字幕、词义和读音

## English

### What it does

- Bilingual YouTube subtitles: the language you are learning, plus your native language
- Prefers captions that come with the video, and falls back to YouTube's translated track
- Hover a word for a dictionary card with IPA, American and British audio, part of speech, definitions, and examples
- Right-click a word to save it
- Listening mode hides subtitles until you hover
- Auto-pause after each line, plus A / S / D for previous, replay, and next (hold to peek)
- The transcript sidebar scrolls with the page, so recommended videos stay clickable
- Reloads captions when you turn the player's captions on or off
- Vocabulary notebook, spaced-repetition flashcards, and CSV / Anki export
- On any page, right-click to look up a selection or read it in LinguaMate

### Scope

- It works on YouTube and ordinary web pages. Netflix captions are protected by copyright and DRM, so this extension does not intercept or copy them.

### Install

1. Open `chrome://extensions` in Chrome
2. Turn on Developer mode
3. Click Load unpacked
4. Select this folder
5. Open a YouTube video that has captions

On first use, set Learning language to the video's language and Native language to yours in the extension popup. After an update, reload the extension, then reload the video tab once.

### Shortcuts

| Key | Action |
| --- | --- |
| A | Previous line. Hold to pause and peek |
| S | Replay the current line. Hold to pause and peek |
| D | Next line. Hold to pause and peek |
| Hover a word | Open the dictionary card |
| Right-click a word | Save it to the notebook |

### Permissions

- `storage` saves settings and vocabulary
- `contextMenus`, `activeTab`, and `scripting` power the page reader
- YouTube, translation, and dictionary hosts are used to load captions, meanings, and audio
