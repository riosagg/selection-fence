# Privacy Policy / プライバシーポリシー

**Selection Fence**

Last updated / 最終更新: 2026-10-15

[English](#english) · [日本語](#日本語)

## English

### Information used in the browser

Selection Fence runs locally in your browser. To keep a text selection inside its starting block, it temporarily processes mouse actions, pointer positions, selection boundaries, and the page text and structure needed for that task.

To pause near sensitive fields, it checks field types, `autocomplete` attributes, visibility, and position. It does not read values entered into form fields. Automatic pausing is a convenience feature and does not guarantee protection of confidential information.

This information is used only for selection control and troubleshooting. Page content, selected text, browsing history, cookies, and form values are not saved to persistent storage or sent to external servers.

### Saved preferences

The extension saves two preferences in `chrome.storage.local`:

- The selection mode: Smart, Nearest, or Block Edge.
- Whether diagnostic logging is enabled.

These settings stay in the browser. Diagnostic logs themselves are not saved to this storage.

### Optional diagnostic logs

Logging is off by default. If you enable it, the extension keeps up to 200 events in each page's memory. Events include relative timings, click counts, pause reasons, element types, connection status, and numeric selection offsets.

Reports exclude page text, selected text, URLs, element IDs and classes, input values, and exception messages.

You can view, clear, or copy a report from the popup. Copying places the report on your clipboard. The extension does not automatically upload reports or write them to persistent storage. Logs are cleared when logging is turned off or the page is fully reloaded.

### Network access and data use

Selection Fence makes no external network requests. It uses no advertising, analytics services, tracking services, or remotely loaded code.

The extension does not sell or share user data with third parties. Information is used only to provide and troubleshoot text-selection control, never for advertising or credit and lending decisions.

### Policy updates

Changes to this policy are published in this repository, with the date above updated accordingly.

---

## 日本語

### ブラウザー内で扱う情報

Selection Fence はブラウザー内で動作します。選択範囲を選び始めた段落や見出しの中に留めるため、マウス操作、カーソル位置、選択の始点・終点、必要なページの文字や構造を一時的に扱います。

機密入力欄の周辺で動作を休止する際は、入力欄の種類、`autocomplete` 属性、表示状態、位置を確認します。入力された値は読み取りません。自動休止は補助機能であり、機密情報の保護を保証するものではありません。

これらの情報は、文字選択の制御と不具合の調査にだけ使用します。ページ本文、選択文字列、閲覧履歴、Cookie、フォーム入力値を永続保存したり、外部サーバーへ送信したりすることはありません。

### 保存する設定

`chrome.storage.local` に保存するのは、次の2つの設定です。

- 選択モード：自動・最寄り文字・ブロック端
- 診断ログのオン・オフ

設定はブラウザー内に保存されます。診断ログそのものは、この保存先には書き込みません。

### 任意の診断ログ

診断ログは初期状態ではオフです。オンにすると、各ページのメモリ内に最大200件のイベントを保持します。記録するのは、相対的な経過時間、クリック回数、休止理由、要素の種類やページとの接続状態、選択位置を表す数値などです。

本文、選択文字列、URL、要素のID・class、入力値、例外メッセージはログに含みません。

設定画面からログを表示・消去・コピーできます。コピーしたログはクリップボードに入ります。拡張機能がログを自動送信したり、永続保存したりすることはありません。記録をオフにするか、ページを完全に再読み込みするとログは消えます。

### 外部通信と情報の利用

Selection Fence は外部通信を行いません。広告、アクセス解析サービス、追跡サービス、外部から読み込むコードも使用していません。

利用者のデータを販売したり、第三者へ共有したりすることはありません。扱う情報は文字選択の制御と不具合の調査にだけ使用し、広告や信用評価・融資の判断には利用しません。

### ポリシーの更新

このポリシーを変更した場合は、このリポジトリで公開し、上記の最終更新日を更新します。
