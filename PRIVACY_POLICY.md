# Privacy Policy / プライバシーポリシー

**Selection Fence**

Last updated / 最終更新: 2026-09-17

## English

Selection Fence is designed to operate locally in the browser.

### Data processed locally

To provide its text-selection functionality, Selection Fence temporarily processes certain information on the device, including:

- pointer and mouse interaction information such as cursor position and drag state;
- browser Selection information such as selection start/end positions;
- selection-related DOM information from the current page, including element type, visibility, position, and DOM node/offset information;
- limited element attributes such as `type` and `autocomplete`, used only to detect certain sensitive input fields.

This processing occurs locally in the browser and is used only to provide Selection Fence's core functionality.

Selection Fence does **not** persistently store, transmit, sell, or share page contents, selected text, browsing history, form input values, passwords, credit-card numbers, one-time codes, cookies, personal information, analytics, or telemetry data.

### Local storage

Selection Fence stores only the selected behavior mode (`smart`, `nearest`, or `block`) using `chrome.storage.local`.

This setting is used only to remember the user's preferred selection behavior. Selection Fence does not transmit this setting to an external server.

### Page access

Selection Fence must interact with the DOM and browser Selection APIs on the page being viewed in order to detect and constrain text-selection behavior.

The extension may temporarily inspect selection-related DOM structure, element visibility and position, and limited attributes such as `type` and `autocomplete`.

Selection Fence does not read or store the values entered into password, payment-card, or one-time-code fields.

### Sensitive-input pause

Selection Fence may automatically pause its selection-limiting behavior near visible password, credit-card, and one-time-code fields.

The extension determines this using field type, `autocomplete` attributes, visibility, and position. It does not read the values entered into those fields.

This feature is provided as a convenience and privacy-oriented safeguard only. It is not a security guarantee and should not be relied upon as a substitute for normal security precautions.

### Network communication and third parties

Selection Fence does not make external network requests and does not use analytics, advertising, telemetry, or remote code.

Selection Fence does not sell, transfer, or share user data with third parties.

Selection Fence does not use user data for purposes unrelated to its single purpose, and does not use user data for creditworthiness or lending purposes.

### Changes

If this privacy policy changes in a way that affects data handling, the updated policy will be published with the project.

---

## 日本語

Selection Fence は、ブラウザ内でローカルに動作するよう設計されています。

### ブラウザ内で一時的に処理する情報

Selection Fence は、文字選択機能を提供するために、以下の情報を端末内で一時的に処理します。

- マウスカーソルの位置やドラッグ状態などのユーザー操作情報
- 選択開始位置・終了位置などのブラウザ Selection 情報
- 表示中ページの要素種類、表示状態、位置、DOM ノードや文字位置（offset）など、文字選択に必要な DOM 情報
- 機密入力欄を判定するための `type` や `autocomplete` などの限定的な要素属性

これらの処理はすべてブラウザ内で行われ、Selection Fence の主要機能を提供する目的にのみ使用されます。

Selection Fence は、ページ本文、選択文字列、閲覧履歴、フォーム入力値、パスワード、クレジットカード番号、ワンタイムコード、Cookie、個人情報、解析・テレメトリ情報を**永続保存・外部送信・販売・第三者共有しません**。

### ローカル保存

Selection Fence が保存するのは、選択した動作モード（`smart` / `nearest` / `block`）のみです。

この設定は `chrome.storage.local` に保存され、利用者が選んだ動作モードを記憶するためだけに使用されます。Selection Fence がこの設定を外部サーバーへ送信することはありません。

### ページへのアクセス

Selection Fence は、文字選択の挙動を検出・制御するために、表示中ページの DOM およびブラウザの Selection API を利用します。

文字選択に必要な DOM 構造、要素の表示状態や位置、`type` や `autocomplete` などの限定的な属性を一時的に参照する場合があります。

パスワード、支払いカード、ワンタイムコード欄へ入力された**値そのものを読み取ったり保存したりしません**。

### 機密入力欄周辺での自動休止

Selection Fence は、表示中のパスワード・カード・ワンタイムコード入力欄の周辺では、文字選択制限を自動休止する場合があります。

判定には、入力欄の種類、`autocomplete` 属性、表示状態、位置のみを使用し、入力された値そのものは読み取りません。

この機能は利便性とプライバシーに配慮した補助機能であり、セキュリティを保証するものではありません。通常のセキュリティ対策の代替として依存しないでください。

### 外部通信・第三者提供

Selection Fence は外部ネットワーク通信を行わず、解析、広告、テレメトリ、リモートコードを使用しません。

ユーザーデータを第三者へ販売・転送・共有しません。

また、単一用途と無関係な目的でユーザーデータを使用せず、信用力判断や融資目的にも使用しません。

### 変更

データの取扱いに影響する変更がある場合は、更新したプライバシーポリシーをプロジェクトとともに公開します。
