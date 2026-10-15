# Selection Fence

![Selection Fence](assets/selection-fence.png)

[日本語](#日本語) · [English](#english)

## 日本語

文章をドラッグして選択するとき、選択範囲がほかの段落まで広がるのを防ぐ Chrome 拡張機能です。選択を始めた段落や見出しなどのブロック内に、範囲を留めます。

### 使い方

拡張機能のアイコンを押してモードを選び、いつもどおり文字をドラッグしてください。

| モード | 範囲の止め方 |
| --- | --- |
| 自動（推奨） | 少しはみ出したときは近くの文字、大きく離れたときはブロックの端で止めます。 |
| 最寄り文字 | 開始ブロック内で、マウスに最も近い文字位置で止めます。 |
| ブロック端 | 開始ブロックの先頭または末尾で止めます。 |

複数の段落を選びたいときは、**Alt キーを押しながらドラッグを開始**してください。ダブルクリックなどの標準操作もそのまま使えます。

入力欄では動作を休止します。また、表示中のパスワード・カード・ワンタイムコード入力欄の周辺でも自動的に休止します。入力された値は読み取りません。

### 不具合を調べる

診断ログは初期状態ではオフです。必要なときに、次の手順で記録できます。

1. 症状が出るページで拡張機能の設定画面を開き、**「不具合の診断」→「診断ログを記録する」**をオンにします。
2. 「記録中です」と表示されたら設定画面を閉じ、不具合を再現します。
3. 同じページで設定画面を開き、**「ログを表示」→「コピー」**を押します。

ログは最大200件をページのメモリ内に保持し、本文・選択文字・URL・入力内容は含みません。記録をオフにするか、ページを再読み込みすると消えるため、その前にコピーしてください。

記録のオン・オフ設定は次回も引き継がれます。読み込み直後の不具合を調べる場合は、記録をオンにしてからページを開いてください。

### プライバシー

文字選択に必要なページ内容と操作情報は、ブラウザー内で処理します。保存する設定は、動作モードと診断ログのオン・オフだけです。外部通信、広告、アクセス解析はありません。

詳しい情報の扱いは[プライバシーポリシー](PRIVACY_POLICY.md#日本語)をご覧ください。

## English

Selection Fence is a Chrome extension that keeps a text selection inside the paragraph, heading, or other block where the drag began. It helps prevent a selection from spreading into unrelated parts of a page.

### How to use

Click the extension icon to choose a mode, then drag to select text as usual.

| Mode | Where the selection stops |
| --- | --- |
| Smart (recommended) | At the nearest text when the pointer is just outside the block; at the block edge when it moves farther away. |
| Nearest | At the text position closest to the pointer within the starting block. |
| Block Edge | At the beginning or end of the starting block. |

To select across blocks, **hold Alt while starting the drag**. Standard operations such as double-click selection remain available.

The extension pauses in input fields and near visible password, payment-card, and one-time-code fields. It does not read entered values.

### Troubleshooting

Diagnostic logging is off by default. To record an intermittent problem:

1. On the affected page, open the popup and turn on **Troubleshooting → Record diagnostic logs**.
2. Wait for the recording confirmation, close the popup, and reproduce the problem.
3. Open the popup on that same page and choose **Show logs → Copy**.

Logs contain up to 200 events in page memory. They exclude page text, selected text, URLs, and input values. Copy the report before turning logging off or reloading the page, as either action clears the log.

The logging preference is remembered. To investigate a problem immediately after navigation, enable logging before opening the page.

### Privacy

Page content and interaction information needed for selection control are processed locally in the browser. The only saved preferences are the selection mode and whether diagnostic logging is enabled. The extension has no external network requests, advertising, or analytics.

See the [privacy policy](PRIVACY_POLICY.md#english) for details.

## 開発 / Development

このフォルダを Chrome に「パッケージ化されていない拡張機能」として読み込めます。ビルドは不要です。

Load this folder as an unpacked extension in Chrome. No build is required.

テストには Node.js 22 以降を使用します。専用の Chromium で不具合の再発を確認し、普段のブラウザープロファイルは使用しません。テストと開発用ライブラリは、配布用ZIPには含めていません。

Tests require Node.js 22 or later and use a separate Chromium profile. Tests and development dependencies are excluded from the store package.

```sh
npm ci
npm run test:install
npm test
```

## ライセンス / License

MIT ライセンスです。利用条件と免責事項は [LICENSE](LICENSE) をご覧ください。機密入力欄周辺での自動休止は補助機能であり、機密情報の保護を保証するものではありません。

Released under the MIT License. See [LICENSE](LICENSE) for terms and the warranty disclaimer. Automatic pausing near sensitive fields is a convenience feature and does not guarantee protection of confidential information.
