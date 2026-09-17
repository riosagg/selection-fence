# Selection Fence

Selection Fence is a lightweight Chrome extension that prevents accidental text selections from jumping into unrelated parts of a web page.

Selection Fence は、文字をドラッグ選択したときに、選択範囲が意図せず別の段落・見出し・サイドバーなどへ広がるのを防ぐ Chrome 拡張機能です。

## Features / 主な機能

- Keeps text selection within the block where the drag started.
- Smart / Nearest / Block selection modes.
- Hold **Alt** while starting a drag to temporarily bypass the restriction and select across multiple blocks.
- Automatically pauses near visible password, credit-card, and one-time-code fields.
- No analytics.
- No advertising.
- No external network requests.
- No page content, selected text, or form input values are stored or transmitted.

- 選択を開始した文字ブロック内に選択範囲を留めます。
- 「自動 / 最寄り文字 / ブロック端」の3モードを選択できます。
- **Alt キーを押しながらドラッグを開始**すると、一時的に制限を解除して複数ブロックを選択できます。
- 表示中のパスワード・カード・ワンタイムコード入力欄の周辺では自動休止します。
- 解析・広告・外部通信は行いません。
- ページ本文、選択文字列、フォーム入力値を保存・送信しません。

## Privacy / プライバシー

Selection Fence processes selection-related DOM information locally in the browser only as needed to provide its function.

The extension stores only the selected behavior mode (`smart`, `nearest`, or `block`) in `chrome.storage.local`. This setting remains on the local browser profile and is not transmitted by Selection Fence.

For details, see [PRIVACY_POLICY.md](./PRIVACY_POLICY.md).

Selection Fence は、機能提供に必要な範囲で、文字選択に関係する DOM 情報をブラウザ内で一時的に参照します。

保存するのは、動作モード（`smart` / `nearest` / `block`）の設定のみで、`chrome.storage.local` に保存されます。この設定を Selection Fence が外部へ送信することはありません。

詳細は [PRIVACY_POLICY.md](./PRIVACY_POLICY.md) をご覧ください。

## Disclaimer / 免責事項

This software is provided **"AS IS"**, without warranty of any kind, express or implied. Use of this extension is at your own risk.

To the maximum extent permitted by applicable law, the author and copyright holder shall not be liable for any claim, damages, loss of data, loss of profits, service interruption, or other liability arising from or related to the use of, inability to use, or malfunction of this software.

This extension is not a security product and does not guarantee protection of confidential information. Its automatic pause behavior around sensitive input fields is a convenience feature and must not be relied upon as a security control.

このソフトウェアは **「現状のまま（AS IS）」** 提供され、明示・黙示を問わず、いかなる保証も行いません。利用は利用者自身の責任で行ってください。

適用法令で認められる最大限の範囲において、本ソフトウェアの使用、使用不能、不具合等に関連して生じた損害、データ損失、利益損失、サービス停止、その他の請求・責任について、作者および著作権者は責任を負いません。

本拡張機能はセキュリティ製品ではなく、機密情報の保護を保証するものではありません。機密入力欄周辺での自動休止機能は補助的な利便機能であり、セキュリティ対策として依存しないでください。

## License / ライセンス

MIT License.

See [LICENSE](./LICENSE).

MIT ライセンスで公開しています。詳細は [LICENSE](./LICENSE) をご覧ください。
