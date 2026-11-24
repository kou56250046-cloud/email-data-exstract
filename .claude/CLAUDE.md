# msg メール抽出・分類ツール

Outlook の .msg ファイルをブラウザだけで読み、一覧・カテゴリ分類・書き出し（CSV / HTML / JSON）を行う。
Outlook の代替メーラーではない。送信・返信・.pst 読み込みはしない。

---

## 絶対的な制約

### 1. npm 依存ゼロ

- `package.json` の依存は空のまま。テストは `node --test` と Node 標準モジュールだけ
- .msg（OLE 複合ファイル）の解析も自前実装。外部ライブラリを入れない

### 2. オフライン・外部送信なし

- メールは機密。**実行時にネットワークへ一切アクセスしない**
- HTML 本文は `sandbox` 付き iframe ＋ CSP で表示し、外部画像・スクリプトを読ませない

### 3. `file://` で開ける

- 配布は 1 ファイルの index.html。埋め込んだスクリプトは CSP の sha256 ハッシュで許可する（'unsafe-inline' にしない）
- ES Modules を使わず通常の `<script>` で読み込む（`file://` で module が CORS 失敗するため）
- 各 js は `globalThis.MsgX` に公開し、Node テストからも読めるようにする

---

## 構成

```
src/page.html     画面の元（css/・js/ を外部参照する）
build.mjs         src/page.html に css/js を埋め込み、1 ファイルで動く index.html を生成
index.html        生成物。直接編集しない。「このツールを保存」はこれを丸ごと複製する
css/style.css
js/cfb.js         OLE 複合ファイル(CFB)の読み取り
js/msg.js         MAPI プロパティ → メールオブジェクト
js/rtf.js         圧縮 RTF(LZFu) 展開、RTF 内 HTML / テキスト取り出し
js/xlsx.js        添付 xlsx の読み取り（表示・検索・分類用）
js/classify.js    カテゴリ・ルール評価（主・副の 2 軸）、初期設定、v1→v2 の設定移行
js/fields.js      SS 名の取り出し（xlsx の見出しの隣 → 件名・本文の「○○SS」）
js/summary.js     集計（主×副・月別・SS 別）と集計表の CSV。画面に依存しない純粋関数
js/thread.js      再送のまとまりと、依頼メール↔返信メールの紐づけ（In-Reply-To・References → 会話情報）。純粋関数
js/store.js       IndexedDB（カテゴリ・ルール・手直しだけを保存。本文は保存しない）
js/export.js      CSV / HTML / JSON 書き出し
js/app.js         画面
tests/            node:test。make-msg.mjs がテスト用 .msg を生成する
.claude/specs/    仕様書（msg-extract/ が初版、two-axis-summary.md が 2 軸と集計の追加分）
```

## コマンド

```bash
node build.mjs                           # index.html を生成（css/js/src を変えたら必ず実行）
npm test                                 # テスト（node --test "tests/*.test.mjs"）
node tests/make-samples.mjs 1000         # 動作確認用の .msg を samples-gen/ に生成
node tests/dump.mjs <ファイルかフォルダ>   # 実物 .msg の解析結果を表示（--body で本文も）
node tests/compare-fixtures.mjs <資材>   # msgreader(OSS) のテスト資材と照合。資材はリポジトリ外に置く
```

## ドメインのルール

- 実物の .msg は機密のためリポジトリに置かない（`samples/` は .gitignore）
- 文字列は Unicode 版（型 001F）を優先し、ANSI 版（001E）は PR_INTERNET_CPID / PR_MESSAGE_CODEPAGE で復号。無ければ Shift_JIS
- 分類は 2 軸: 主＝業務の段階（依頼・見積・発注・完了・請求）、副＝設備・工種。1 通に各 1 つ。手直しは manual[key] = { main, sub, ss }
- 手で付けたカテゴリはルールより優先する
- 添付 PDF は FAX を PDF にしたもの（画像）で文字は取り出せない。OCR はしない
- 集計から一覧へ移るときは、今の絞り込みを残して条件を足す（件数を集計と一致させる）
- 中身はガソリンスタンドの補修依頼が中心。詳細は添付 xlsx にあることが多い。パスワード通知などは「対象外」へ
- 分類の語は NFKC・小文字・空白除去でそろえてから比べる（補修/修理などの揺れはルールに `,` で並べる）
- 設定は localStorage と IndexedDB の両方に時刻付きで保存し、新しい方を読む（file:// で IndexedDB が応答しないことがある）
