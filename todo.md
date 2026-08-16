有，而且我搜到一个几乎就是你描述的东西：FluentAnyLang。它是开源 Web App，可以导入自己的音频/视频，再配 .srt 或 .lrc 字幕，然后按一句一句跳转、暂停、循环播放，还带 speaking practice；所有素材和录音都保存在浏览器本地，不上传服务器。技术栈是 Lit + Vite + TypeScript，MIT License。 

它的 workflow 基本就是：

上传日语歌曲 → 导入 LRC 歌词 → 点某一句 → 单句循环 → 跟读/录音 → 下一句

所以如果你的目标只是“找个现成的东西学 YOASOBI 之类的歌”，我会先试这个，不用自己造。唯一的问题是它现在非常新，GitHub 只有 0 star，项目成熟度还需要你自己试一下。 

另外几个也值得看，但方向稍微不同。

Onsei Anki 更偏真正的日语发音训练。它会拿原句音频和你自己的录音做比较，甚至画出 pitch accent / intonation 的差异；可以反复听原句和自己的录音。问题是它基于 Anki，不是“上传一首歌然后歌词逐句播放”的漂亮 Web UI。 

maestro-cli 是一个开源音乐播放器，支持 MP3/WAV/FLAC、同步歌词 .lrc、外语歌词 romanization 和翻译，而且可以人为定义：

clip <START> <END>

也就是说你可以把一首歌的一句话定义成 clip，然后重复播放。它甚至能自动找 synchronized lyrics。不过它是 terminal UI，更像可以拿来借鉴底层逻辑，而不是最终学习产品。 

还有 jidoujisho，它本身就是为语言学习做的视频播放器 + dictionary + card creation 工具，比普通播放器强很多；以及 Ear2Finger，后者直接就是“导入视频字幕 → sentence-by-sentence 练听力”，不过主要面向英语听写。 

所以我觉得你脑子里这个产品其实可以定义得更具体一点：

Spotify Lyrics × Shadowing × Anki，但针对日语歌。

比如：

夜に駆ける

沈むように溶けてゆくように
しずむ ように とけて ゆく ように
shizumu you ni tokete yuku you ni
像沉下去一般、像融化一般

▶ 原唱 ↻ Loop 0.75× 🎙 跟读

然后播放严格限定在这一句歌词的 timestamp：

12.42s ├──────────────┤ 16.81s

你按一下 Loop，就：

原唱 → 1 秒空白 → 你念 → 原唱 → 1 秒空白 → 你念……

这其实比 FluentAnyLang 更适合“学日语歌”，因为可以再加三个很有价值的日语功能：汉字 Furigana、罗马音开关、逐词解释/语法解释。

而且你甚至不需要自己手工切歌。.lrc 本身就有 timestamp，例如：

[00:12.42]沈むように溶けてゆくように
[00:16.81]二人だけの空が広がる夜に

播放器只需要把 currentTime 控制在 [12.42, 16.81]，一句话循环就实现了。所以从工程角度看，这个 MVP 相当轻。

如果歌曲没有 LRC，再走：

MP3 → Whisper / WhisperX → 日文 transcript + timestamps → 自动生成 LRC

这样连歌词都不用用户准备。

我目前搜到的这些里面，FluentAnyLang 是与你需求重合度最高的 repo；但我还没有看到一个成熟开源项目真正把“日语歌曲 + Furigana + 逐句循环 + shadowing + 发音比较”全部做在一起。 

所以这个东西反而挺适合你自己 fork FluentAnyLang 改一下（笑）。它已经帮你解决了最烦的 media import、subtitle timing、sentence looping、IndexedDB、PWA 和录音，你主要加 Japanese-specific layer 就行，工作量比从零开始小很多。
