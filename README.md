# 语伴 LinguaMate

在 YouTube 和 Amazon Prime Video 上用双语字幕、悬停词典和生词本学习外语的 Chrome 插件。

A Chrome extension for learning languages on YouTube and Amazon Prime Video with bilingual subtitles, a hover dictionary, and a vocabulary notebook.

## 中文

### 能做什么

- YouTube 和 Amazon Prime Video 双语字幕：学习语言加母语对照
- 优先使用视频自带字幕；没有对应语言时，用 YouTube 翻译轨道生成译文
- 鼠标悬停单词即可查词，卡片包含音标、美式 / 英式朗读、词性、释义和例句
- 右键单词直接加入生词本
- 单词卡显示收藏状态：点击加入生词本，再次点击移除，并显示操作结果
- 设置、查词、收藏、删除和复习都有明确的成功或失败反馈；Prime Video 设置会实时生效
- 听写模式：字幕默认隐藏，鼠标悬停才显示
- 逐句暂停，以及 A / S / D 上一句、重播、下一句（按住可预览）
- 右侧字幕列表会随页面滚动，不挡住推荐视频
- Prime Video 字幕栏保持固定高度并自动跟随当前字幕；向上滚动可暂停，点击「继续跟随」恢复
- Prime Video 插播广告时暂停正片字幕与跟随，保留已加载列表；广告后恢复正片时间，字幕跳转和收藏时间也会换算（1.9.1）
- 修复 Prime Video 播放器无法识别、字幕先于界面返回导致启动失败的问题（1.9.2）
- 适配新版 Prime Video 广告倒计时；重新读取字幕后仍保留已识别的广告时间校正（1.9.3）
- Prime Video 查词需短暂停留，快速划过单词不会反复闪卡
- 打开或关闭播放器 CC 时自动重新读取字幕
- 生词本、间隔重复闪卡，可导出 CSV / Anki
- 完整 JSON 备份与恢复，保留词条、掌握记录和复习进度；支持合并或确认后替换
- 任意网页：右键「用语伴查阅」或「用语伴阅读」

### 英语与日语单词卡（1.11.0）

- 参考 [Language Reactor 官方指南](https://www.languagereactor.com/help/basic)及实际词典交互，YouTube 和 Prime Video 共用新的单词卡：本句参考、词典义项、例句、词形语法、外部词典与词组查询。
- 保留词典返回的全部义项、英文原文和日语用法说明，取消英语每个词性仅两条、日语每词条仅三条的截断。首屏展示六项，点击「更多义项」继续查看并翻译；卡片先显示词典数据，不等待网络释义翻译。
- 原句及其机器译文独立显示。对英日词条，使用英文原句或日语原句的英文译文，与词典定义、用法和例句进行词语匹配；有明确匹配线索时显示最多两个「语境相关义项 · 待确认」。例如「薬を飲む」可关联词典里的 `to take (medicine)`。这是有限的词语匹配，不是 AI 语义消歧，不能保证句中含义；没有线索时不猜测。
- 「收藏此义项」保存你选定的解释；词条已存在时更新释义并保留复习进度。底部原有收藏按钮继续支持加入／移除。语境参考中的释义片段也可单独收藏。
- 英语保留词典例句并支持翻译；根据词典的词形关系以及已知不规则形式查验原形，保留同形词的其他解释。日语继续保留假名、辞书形、活用与读音限制，词形信息可展开查看。
- 卡片内可以查询完整词组或手动校正查询文本，不改写平台字幕。提供 Cambridge、Wiktionary、Jisho、Weblio 入口供进一步核对。
- 原句、例句和释义翻译失败均提供重试；原文释义仍可阅读。只翻译正在查看的释义及少量语境候选，切换单词后过期结果不会覆盖新卡片。

日语语境匹配会把当前原句送到现有翻译服务获取英文参考，释义中文仍为机器翻译。自动字幕的错字、缺词仍需核对原文；本次不提供 Language Reactor 的 AI 语法解释能力，也不要求新的 API Key。

### 日语学习（1.11.0）

- 将学习语言设为「日本語」。YouTube、Prime Video 和网页阅读会在本地按词典分词，把「食べませんでした」「食べちゃった」等完整活用链连接到「食べる」，保留字幕原文。
- 日语词卡显示辞书形、字幕形式、假名、词性和活用。可能、被动、尊敬等不能仅凭形式确定的解释会列出候选，需结合原句判断。IPADIC 没有提供可靠原形关系的独立词条会保留原词，不强行还原。
- 注音可选「全部」「仅未掌握」「悬停显示」「关闭」，设置后即时生效。默认仅未掌握；加入生词本不会自动视为已经掌握。
- 划选同一行中的词组后，点击「查询所选内容」查整段表达；假名注音不会混进查询。部分词语和整段短语会按选区保存。
- 收藏以辞书形和读音关联活用，同形异读分开，收藏时保留最多 20 条词形与原句。已有词条和复习进度可继续使用，完整 JSON 备份包含这些日语字段。
- 生词本可搜索假名和字幕里的活用；日语闪卡增加「看汉字回忆读音」「看活用回忆辞书形」两种题型，原有释义题型继续可用。
- 日语自动字幕会清理妨碍分词的空格；有词典依据的汉字复合名词（如「気象衛星」「最大瞬間風速」）按完整词查询。原文中的错字不会被悄悄替换。播放字幕保留平台每条原始时间点，处理自动字幕滚动窗口的重叠，避免合并成 8～12 秒长段造成跟随迟缓（1.10.1）。
- YouTube 优先读取整条母语字幕或平台译文轨道，按时间重叠完整对齐；轨道缺失时才翻译可见行和播放位置附近的字幕，同时最多两个请求。手动重译优先于后台预读，字幕切换不等待翻译。
- 工具栏明确显示「译文：开／关」，侧栏可点击「显示全部译文」。即使全局译文关闭，「整句重译」也会单独显示该句的进度、结果和失败提示；其他句子沿用原设置，再关闭全局译文可隐藏全部结果（1.10.1）。
- YouTube 日语字幕显示来源提示，每行提供「校正原文」和「整句重译」。修改后会重新分词、注音和翻译，可查看或恢复原字幕。校正只保留在当前页面会话；刷新页面后重新读取平台原字幕。
- 词卡优先显示词典义项的翻译，保留原始英文释义；助词和「～ていく／～てくる」等表达增加中文用法说明。没有匹配词条时会提示核对自动字幕，不把机器译文当作已确认词义。
- 词典扩充至 218,930 条 JMdict 英文词条（2026-10-19 快照）；常用词仍单独用于词频标记。扩充释义分为 32 个本地文件，查词时按需读取，最多缓存 4 份；普通语言不加载日语词典。专名、新词和语音识别错误仍可能查不到，机器翻译也不保证能还原缺失的原话。

本地分析不发送字幕到词典供应方；查询中文释义、句子译文和在线朗读仍使用原有在线服务。词典、许可证及更新方法见 [第三方数据说明](THIRD_PARTY_NOTICES.md)。

### 范围

- 用于 YouTube、Amazon Prime Video 和普通网页。在 Amazon 播放器里打开要学习的字幕后，语伴会自动接上。Netflix 字幕受版权和 DRM 保护，本插件不会拦截或复制。

### 安装

不需要安装 Git，也不需要注册 GitHub 账号。用浏览器把项目下载成一个压缩包即可。

1. 用 Chrome 打开这个页面：<https://github.com/Miso-Soup98/LinguaMate>
2. 点绿色的 **Code** 按钮。
3. 在弹出的菜单最下方点 **Download ZIP**。浏览器会下载一个名叫 `LinguaMate-main.zip` 的文件，一般在「下载」文件夹里。
4. 把这个压缩包解压。
   - Windows：右键压缩包，选「全部解压缩」，记住解压出来的文件夹。
   - Mac：双击压缩包，会得到一个文件夹。
5. 打开解压出来的文件夹，确认里面能直接看到 `manifest.json`。不要选再套一层的外层空文件夹，也不要选还没解压的 `.zip` 文件。
6. 在 Chrome 地址栏输入 `chrome://extensions` 并回车。
7. 打开页面右上角的 **开发者模式**。
8. 点左上角 **加载已解压的扩展程序**。
9. 在弹窗里选中第 5 步那个包含 `manifest.json` 的文件夹，然后点「选择文件夹」。
10. 安装成功后，语伴会出现在扩展列表里。点 Chrome 工具栏的拼图图标，把语伴固定到工具栏，以后更好找。

然后打开一个带字幕的 YouTube 视频。点语伴图标，把「学习语言」设成视频的语言，把「母语 / 译文」设成你的母语。

以后想更新到新版本：下载 ZIP 并解压后，把新版文件复制到当初加载的那个插件文件夹里，覆盖旧文件。回到 `chrome://extensions`，在语伴卡片上点刷新按钮，再刷新视频页。只解压到新文件夹然后点刷新，不会改变 Chrome 已加载的路径；如果移动了插件目录，需要重新选择加载目录。插件版本可以在扩展管理页查看。

备份生词：打开「生词本 / 闪卡」，展开「完整备份与恢复」，点击导出 JSON。恢复时先选备份文件，确认预览数量，再选择恢复方式；默认合并并保留现有同词的复习进度，替换会要求再次确认。CSV / Anki 导出用于学习工具交换，完整迁移请使用 JSON 备份。

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

- Bilingual subtitles on YouTube and Amazon Prime Video: the language you are learning, plus your native language
- Prefers captions that come with the video, and falls back to YouTube's translated track
- Hover a word for a dictionary card with IPA, American and British audio, part of speech, definitions, and examples
- Right-click a word to save it
- Dictionary cards show saved status: click to add a word, click again to remove it, with confirmation after each action
- Settings, lookups, saves, deletions, and reviews report success or failure; Prime Video settings update immediately
- Listening mode hides subtitles until you hover
- Auto-pause after each line, plus A / S / D for previous, replay, and next (hold to peek)
- The transcript sidebar scrolls with the page, so recommended videos stay clickable
- Prime Video's fixed-height transcript follows the current subtitle; scroll up to pause following and click the follow button to resume
- During Prime Video ads, programme subtitles and transcript following pause; the content timeline, subtitle seeks and vocabulary timestamps resume together afterward (1.9.1)
- Fixes Prime Video startup when the rendered video is excluded from the accessibility tree or subtitles arrive before the interface mounts (1.9.2)
- Recognizes the current Prime Video ad countdown and preserves observed ad timing when subtitles or cached manifests are reloaded (1.9.3)
- Prime Video dictionary cards wait for a brief hover, so passing over words does not flash cards
- Reloads captions when you turn the player's captions on or off
- Japanese uses bundled offline morphology, dictionary forms, kana readings and optional furigana on both video platforms and in the page reader; explicit range lookup keeps a whole phrase together
- Japanese vocabulary groups inflections by lemma and reading, preserves source examples, and supports meaning, reading and inflection-to-lemma review modes
- Japanese definitions use 218,930 bundled JMdict entries, with full-dictionary supplements loaded in bounded shards. Exact written noun compounds, particles and auxiliary expressions receive additional support. Machine translations and ambiguous inflections are labelled separately. See [data sources and update procedure](THIRD_PARTY_NOTICES.md)
- YouTube captions retain their original timing instead of merging into long paragraphs. Timed native/translated tracks load first; missing rows fall back to direct translation. Manually requested translations reveal progress and results even when automatic translation display is off, with explicit on/off controls (1.10.1)
- Automatic Japanese captions are labelled, and each row can be corrected, retranslated or restored within the current page session (1.10.0)
- Vocabulary notebook, spaced-repetition flashcards, and CSV / Anki export
- Complete JSON backup and restore preserve vocabulary, known words, and review progress, with merge or confirmed replacement
- On any page, right-click to look up a selection or read it in LinguaMate

### Scope

- It works on YouTube, Amazon Prime Video, and ordinary web pages. On Prime Video, turn on the subtitle language you are learning and LinguaMate picks it up. Netflix captions are protected by copyright and DRM, so this extension does not intercept or copy them.

### Install

You do not need Git, and you do not need a GitHub account. Download the project as a zip file in the browser.

1. Open this page in Chrome: <https://github.com/Miso-Soup98/LinguaMate>
2. Click the green **Code** button.
3. Click **Download ZIP** at the bottom of the menu. Chrome saves a file named `LinguaMate-main.zip`, usually in your Downloads folder.
4. Unzip it.
   - Windows: right-click the zip file, choose Extract All, and remember the folder it creates.
   - Mac: double-click the zip file. Finder creates a folder next to it.
5. Open that folder and check that `manifest.json` is directly inside it. Do not select the zip file itself, and do not select an extra outer folder that only contains another folder.
6. Click the address bar, type `chrome://extensions`, and press Enter.
7. Turn on **Developer mode** in the top-right corner of that page.
8. Click **Load unpacked** in the top-left.
9. Select the folder from step 5, the one that contains `manifest.json`, then confirm.
10. LinguaMate appears in the extensions list. Click the puzzle-piece icon on the Chrome toolbar and pin LinguaMate so it is easy to open.

Open a YouTube video that has captions. Click the LinguaMate icon, set Learning language to the video's language, and set Native language to yours.

To update, unzip the new version and copy its files over the files in the folder originally loaded into Chrome. On `chrome://extensions`, reload LinguaMate, then reload the video tab. Extracting into a different folder does not update Chrome's existing extension path; if you move the extension, select the new folder when loading it. The version is shown on the extension management page.

To back up vocabulary, open the vocabulary notebook and expand the backup and restore section. Export a JSON backup, or select one to preview its record counts before restoring. Merge is the default and preserves the review progress of existing words. Replacement requires confirmation. Use JSON for full migration; CSV and Anki exports are for exchanging learning content.

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

## Local checks / 本地检查

Run the regression tests with Node.js:

```sh
node --test
```

Browser integration tests use an installed Chrome in an isolated temporary profile. Set `CHROME_PATH` if Chrome is installed elsewhere; tests that require Chrome are skipped when it is unavailable.
