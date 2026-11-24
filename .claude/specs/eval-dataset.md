# 評価データセットの zip 書き出し

## Context
集計画面の「評価データの配分試算」は、層ごとの**件数**を出すだけで、どのメールを選ぶかは決めていない。
そのため、評価に使うメールは 1 通ずつ開いて分類を確かめるしかなく、手間がかかる。
試算した件数どおりに各層からメールを無作為に選び、**分類ごとのフォルダに元の .msg と一覧（CSV / HTML）・条件を入れた zip** を 1 回の操作で保存できるようにする。

ユーザーが決めたこと: 抽出は試算の件数で行う（シード付きの無作為抽出）。中身は msg と一覧 CSV / HTML。

規模は M（新しいファイル、新しいデータ構造）。実装に入るとき `.claude/specs/eval-dataset.md` に同じ内容で仕様書を置く。

## 受入条件
1. 配分試算の節に「シード」の入力欄（初期値はランダムな整数）と「評価データを zip で保存」ボタンがある。
2. zip の構成:
   ```
   評価データ_YYYYMMDD-HHMM/
     一覧.csv      Exp.toCsv の列 ＋ 層 ・ zip 内のパス（UTF-8 BOM）
     一覧.html     Exp.toHtml の一覧。各行から zip 内の .msg へ相対リンク
     条件.txt      targetLabel / allocTitle / 注意 / シード / 作成日時 / 層ごとの配分・実際の件数 / 読めなかったファイル
     <主>/<副>/001_<元のファイル名>.msg   （層が主なら <主>/、副なら <副>/、主×副なら <主>/<副>/）
   ```
3. 各層から min(配分件数, 母数) 件を選ぶ。シードと絞り込み・設定が同じなら、読み込む順番が違っても同じメールが選ばれる（m.key で並べてから shuffle）。
4. 層の判定は集計と同じにする（`Sum.matrix` と同じく、カテゴリ ID が無い・カテゴリ一覧に無いものは未分類）。未分類を層から外す設定なら、未分類は zip に入れない。
5. フォルダ名・ファイル名から Windows で使えない文字（`\/:*?"<>|`・制御文字・末尾の `.` や空白）を `_` にし、長さを切り詰める。連番を付けて名前が重ならないようにする。
6. 元の File が読めなかったメールは飛ばし、条件.txt に書く（全体は止めない）。
7. ファイル名は UTF-8 フラグ付きで格納し、Windows のエクスプローラーで日本語名のまま展開できる。CRC32 は正しい値を入れる。
8. 保存中はボタンを無効にし、件数の進み具合を表示する。
9. ネットワークへは一切アクセスしない（Blob をダウンロードするだけ）。

## 非目標
- 圧縮（無圧縮 STORE のみ。.msg はもともと圧縮が効きにくい）、zip64（4GB 超・65535 件超はエラー文を出して止める）
- 添付 xlsx を取り出して別ファイルにすること
- 抽出したセットの保存（IndexedDB）や、zip を読み戻す機能
- 正解ラベルを付ける画面、評価の採点
- 配分試算の計算方法（`Sum.allocate`）の変更

## 変更するファイル
| ファイル | 内容 |
|---|---|
| `js/zipw.js`（新規） | `globalThis.MsgZipW`。`crc32(bytes)`、`build(entries[{name, data, date}]) → Uint8Array`（STORE・UTF-8 フラグ bit 11・DOS 日時）、`safeName(s, max)` |
| `js/summary.js` | `strataKeyOf(m, layer, mainSet, subSet)` と `sample(groups, allocMap, seed)` を追加（mulberry32 ＋ Fisher–Yates の純粋関数）。`idOf` を再利用 |
| `js/app.js` | `allocSection` に入力欄とボタンを足す。`buildEvalZip(d)`: summaryRows → 層に分ける → sample → `m.file.arrayBuffer()` → 一覧・条件を作る → `MsgZipW.build` → 既存の `download()`。一覧には既存の `Exp.toCsv` / `Exp.toHtml` と `EXPORT_INFO`、ファイル名には既存の `stamp()` を使う。`state.alloc.seed` を追加 |
| `src/page.html` | `<script src="js/zipw.js">` を export.js の前に追加 |
| `js/export.js` | `toHtml` に、行ごとのリンク先を渡せる省略可能な引数を足す（今の呼び出しには影響させない） |
| `tests/zipw.test.mjs`（新規） | crc32("123456789") = 0xCBF43926、build の結果を `Xlsx.listZip` で読み戻して名前・中身・UTF-8 フラグを確かめる、safeName |
| `tests/summary.test.mjs` | sample: 件数 = min(配分, 母数)、同じシードなら同じ結果、入力の順番に依存しない、シードを変えると選ばれるものが変わる |

`index.html` は `node build.mjs` で作り直す（直接編集しない）。

## 検証
1. `npm test` がすべて通る。
2. `node build.mjs` → `node tests/make-samples.mjs 300` で作った samples-gen/ を index.html で読み込み、配分試算（主×副・200 件・比例＋最低件数）から zip を保存する。
3. エクスプローラーで展開し、フォルダ名が日本語で出ること、各フォルダの件数が試算の表と一致すること、.msg を Outlook／このツールで開けること、一覧.html のリンクから .msg が開くことを確かめる。
4. 同じシードでもう一度保存し、一覧.csv が同じになることを確かめる。
