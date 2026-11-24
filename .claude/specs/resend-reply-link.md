# 再送フラグと、依頼メール・返信メールの紐づけ

## Context
- 同じ補修依頼が「再送」や件名の「(1)」付きで何度も届く。今の「重複」は Message-ID が同じもの（同じファイル）しか拾えない
- 将来、依頼メールと自社の返信メールを組にして評価データにしたい。返信は先方から **.msg（送信済みアイテム）** で受け取れる見込み
- ヒヤリング結果: 「(1)」が件名とファイル名のどちらに付くかは不明 / 正解は最初の返信だけ / 再送はバッジだけで件数はそのまま

規模: **M**（新しいモジュールと新しいデータ構造を追加し、触るファイルは 4 つ以上）。実装前に `.claude/specs/resend-reply-link.md` にこの内容を仕様として残す。

## 方針

### 1. 再送の判定（新規 `js/thread.js`、純粋関数として `globalThis.MsgThread` に公開する）
- `normSubject(s)`: NFKC → 小文字 → 空白除去。先頭の `re:` `fw:` `fwd:` `返信:` `転送:` を繰り返し除き、`【再送】` `(再送)` `再送:` `(1)` `（2）` `[3]` と末尾の番号を除く
- `groupResends(mails, {days: 14})`: 次の条件をすべて満たすメールを同じグループにする
  - key（Message-ID）が違う
  - 送信者のアドレスが同じ
  - normSubject が同じ
  - SS名が両方にあるなら一致する
  - 最初の1通から 14 日以内に届いている
  - 返信と判定されたもの（下の 2.）を除く
- 届いた日時で並べ、最初の1通を原本、以降を `m.resend = { group, n }` とする（n = 2, 3 …）
- 「(1)」がファイル名に付いているだけなら同じ Message-ID なので、既存の「重複」として扱われる。件名に付いていれば再送として扱われる。どちらの場合も拾える

### 2. 返信の紐づけ（`js/thread.js`）
- `linkReplies(mails)`: 返信の `inReplyTo` と、`references` の各 ID を、読み込み済みメールの messageId と照合する（照合の手段は ①）
- 結べなければ、`PR_CONVERSATION_INDEX` の先頭 22 バイトが一致し、自分より前に届いたメールを親とする（照合の手段は ②）
- 依頼ごとに、送信日時がいちばん早い返信を `m.firstReply` とする。正解は最初の返信だけ
- 再送グループでは、グループ内のどのメールに付いた返信も、グループの原本に対する返信として扱う
- ペアには `method: 'header' | 'conversation'` を残す

### 3. `js/msg.js`
- `P` に `CONVERSATION_TOPIC: 0x0070` と `CONVERSATION_INDEX: 0x0071`（バイナリ）を追加する
- 戻り値に `conversationTopic` と `conversationIndex`（16 進文字列）を足す
- `js/app.js` の `summarize`（145 行目付近）でも引き継ぐ

### 4. 画面（`js/app.js`）
- `reclassify()`（330 行目）で `dup` を決めた後に `groupResends` と `linkReplies` を呼ぶ
- 一覧のバッジ: 「再送 2回目」と「返信あり」を、既存の「重複」バッジ（530 行目）の隣に並べる。返信メールの側には「返信」を付ける
- 絞り込み `filter.resend`: 再送だけ / 返信ありだけ / 返信なしの依頼だけ。既存の `filter.dup` と同じ書き方にする
- 詳細画面: 同じ再送グループのメールと、結んだ返信へのリンクを表示する
- 件数と集計は変えない（再送はバッジだけ）。返信メールは集計に入れない

### 5. 書き出し（`js/export.js`）
- 「返信ペアを書き出す」を追加する。出力は JSON と CSV
- 1 行の項目: 依頼の key・件名・本文・SS・主分類と副分類、返信の key・件名・本文・送信日時、紐づけの手段、再送回数
- 既存の `toCsv(rows, info.extra)` と `toJson` の仕組みを使う

## 非目標
- 件名と日時だけで返信を推定する照合（手段 ③）と、人が組を確定する UI。.msg で受け取れる前提なので作らない。実物でヘッダが欠けていると分かったら再検討する
- 本文の類似度による再送判定
- 2 通目以降の返信を評価データに入れること
- 再送を集計で 1 件にまとめること
- 紐づけ結果の保存。読み込むたびに計算し直す（IndexedDB の形は変えない）
- 返信メールの分類ルールの追加

## 触るファイル
`js/thread.js`（新規）、`js/msg.js`、`js/app.js`、`js/export.js`、`src/page.html`（script タグと CSP ハッシュは build.mjs が付ける）、`tests/make-msg.mjs`（In-Reply-To と ConversationIndex を付けられるようにする）、`tests/thread.test.mjs`（新規）

## 検証
1. `npm test` を実行する
   - normSubject: `RE: 【再送】件名(2)` と `件名` が同じになる
   - groupResends: 期間・送信者・SS の条件の境界
   - linkReplies: In-Reply-To、References、ConversationIndex のそれぞれで結べる。再送グループの原本にまとまる。最初の返信が選ばれる
2. `node tests/make-samples.mjs` に、再送と返信の組を混ぜて生成する
3. `node build.mjs` の後に、簡易サーバー＋ブラウザで次を確かめる
   - バッジ、絞り込み、詳細のリンク
   - ペアの書き出し
   - 集計の件数が変わっていないこと
4. 実物の返信 .msg が届いたら `node tests/dump.mjs` で、0x1042・0x1039・0x0071 が残っているかを確かめる
