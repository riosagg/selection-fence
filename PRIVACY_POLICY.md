# Privacy Policy / プライバシーポリシー

**Selection Fence**

Last updated / 最終更新: 2026-09-17

## English

Selection Fence is designed to operate locally in the browser.

### Data collection

Selection Fence does **not** collect, transmit, sell, or share:

- page contents;
- selected text;
- browsing history;
- form input values;
- passwords;
- credit-card numbers;
- one-time codes;
- cookies;
- personal information;
- analytics or telemetry data.

### Local storage

Selection Fence stores only the selected behavior mode (`smart`, `nearest`, or `block`) using `chrome.storage.local`.

This setting is used only to remember the user's preferred selection behavior. Selection Fence does not transmit this setting to an external server.

### Page access

To provide its core function, Selection Fence must interact with the DOM and browser Selection APIs on the page being viewed. This processing occurs locally in the browser.

The extension may inspect element types, attributes such as `autocomplete`, visibility, position, and selection-related DOM nodes/offsets in order to control text-selection behavior and to pause near certain sensitive input fields.

Selection Fence does not read or store the values entered into password, payment-card, or one-time-code fields.

### Network communication

Selection Fence does not make external network requests and does not use analytics, advertising, telemetry, or remote code.

### Sensitive-input pause

The extension may automatically pause its selection-limiting behavior near visible password, credit-card, and one-time-code fields.

This is a convenience and privacy-oriented feature only. It is not a security guarantee and should not be relied upon as a substitute for normal security precautions.

### Changes

If this privacy policy changes in a way that affects data handling, the updated policy will be published with the project.

---

## 日本語

Selection Fence は、ブラウザ内でローカルに動作するよう設計されています。

### 収集するデータ

Selection Fence は、以下の情報を**収集・送信・販売・共有しません**。

- ページ本文
- 選択した文字列
- 閲覧履歴
- フォーム入力値
- パスワード
- クレジットカード番号
- ワンタイムコード
- Cookie
- 個人情報
- 解析・テレメトリ情報

### ローカル保存

Selection Fence が保存するのは、選択した動作モード（`smart` / `nearest` / `block`）のみです。

この設定は `chrome.storage.local` に保存され、利用者が選んだ動作モードを記憶するためだけに使用されます。Selection Fence がこの設定を外部サーバーへ送信することはありません。

### ページへのアクセス

本拡張機能の主要機能を提供するため、表示中ページの DOM およびブラウザの Selection API を利用します。これらの処理はブラウザ内でローカルに行われます。

文字選択の制御や、特定の機密入力欄周辺で自動休止するために、要素の種類、`autocomplete` などの属性、表示状態、位置、選択に関係する DOM ノードや文字位置を一時的に参照する場合があります。

パスワード、支払いカード、ワンタイムコード欄へ入力された**値そのものを読み取ったり保存したりしません**。

### 外部通信

Selection Fence は外部ネットワーク通信を行わず、解析、広告、テレメトリ、リモートコードを使用しません。

### 機密入力欄周辺での自動休止

表示中のパスワード・カード・ワンタイムコード入力欄の周辺では、文字選択制限を自動休止する場合があります。

これは利便性とプライバシーに配慮した補助機能であり、セキュリティを保証するものではありません。通常のセキュリティ対策の代替として依存しないでください。

### 変更

データの取扱いに影響する変更がある場合は、更新したプライバシーポリシーをプロジェクトとともに公開します。
